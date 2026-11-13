"""Unit tests covering audit remediation branches across services, readers, vector DBs, queues, and routers."""

import asyncio
from datetime import datetime, timedelta
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pymupdf
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from pymilvus import MilvusException

from src.application.reader import DocumentReader
from src.application.use_cases import PatientRecordService
from src.domain.common.common_ressources import PatientPriority
from src.domain.mdt_agenda import MDTAgenda, MDTAgendaEntry
from src.domain.patient import Patient
from src.domain.patient_mdt_form import PatientMDTOncologicForm
from src.domain.worker import JobStatus
from src.infrastructure.documents.repositories import (
    InMemoryDocumentCacheRepository,
    InMemoryMDTAgendaRepository,
    InMemoryPatientMDTFormRepository,
    InMemoryPatientRepository,
)
from src.infrastructure.llm.llamacpp import LlamaCppCompatibleEmbeddings
from src.infrastructure.llm.openai import OllamaCompatibleOpenAIEmbeddings
from src.infrastructure.llm.vllm import VllmCompatibleEmbeddings
from src.infrastructure.queue.memory_queue import InMemoryQueueManager
from src.infrastructure.vectorial.chromadb import Chromadb
from src.infrastructure.vectorial.database import VectorialDataBase
from src.infrastructure.vectorial.milvus import MilvusDB
from src.routers import dependencies as api_deps
from src.routers.patientmdtform import get_record_service
from src.routers.queue import (
    UnbufferedEventSourceResponse,
    _require_existing_job,
    _resolve_queue_domain_filter,
    _stream_thinking_sse,
)

APP_API_PATH = Path(__file__).resolve().parent.parent / "app-api.py"


@pytest.fixture(scope="module")
def api_app():
    """Load the FastAPI application instance for router error-handling tests."""
    spec = importlib.util.spec_from_file_location("app_api_cov_gaps", APP_API_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.app


@pytest.fixture
def client(api_app):
    """Provide an isolated FastAPI TestClient with clean dependency overrides."""
    api_app.dependency_overrides.clear()
    yield TestClient(api_app)
    api_app.dependency_overrides.clear()


def _build_record_service(tmp_path: Path):
    """Construct an in-memory PatientRecordService wired with an MDTAgenda repository."""
    patient_repo = InMemoryPatientRepository()
    mdt_form_repo = InMemoryPatientMDTFormRepository()
    cache_repo = InMemoryDocumentCacheRepository()
    agenda_repo = InMemoryMDTAgendaRepository()
    mock_conf = MagicMock()
    mock_conf.domain = "oncology"
    mock_conf.rcp.path = str(tmp_path)
    mock_conf.queue.enabled = False
    service = PatientRecordService(
        patient_repo=patient_repo,
        mdt_form_repo=mdt_form_repo,
        cache_repo=cache_repo,
        mdt_agenda_repo=agenda_repo,
        form_cls=PatientMDTOncologicForm,
        config=mock_conf,
    )
    return service, patient_repo, mdt_form_repo, agenda_repo


def test_patient_record_create_new_llm_fallback_and_agenda_cleanup(tmp_path: Path):
    """Verify CREATE_NEW standalone patient splitting, LLM summary fallback, and agenda cleanup."""
    service, patient_repo, mdt_form_repo, agenda_repo = _build_record_service(tmp_path)

    # 1. Seed a patient with two forms, then split one into a standalone Patient via CREATE_NEW
    p1, _ = service.synchronize_patient_from_admin(
        filename="form_a.pdf",
        admin_data={
            "first_name": "Claire",
            "last_name": "Moreau",
            "date_birth": "1972-06-20",
            "date_rcp": "2026-04-10",
            "gender": "Female",
        },
    )
    service.synchronize_patient_from_admin(
        filename="form_b.pdf",
        admin_data={
            "first_name": "Claire",
            "last_name": "Moreau",
            "date_birth": "1972-06-20",
            "date_rcp": "2026-05-10",
            "gender": "Female",
        },
    )
    # Existing candidate_id triggers deterministic standalone pat_<digest> ID
    standalone_colliding, updated_b = service.link_mdt_form_to_patient(
        filename="form_b.pdf",
        target_patient_id="CREATE_NEW",
        override_date_rcp="2026-05-15",
        edited_by="dr_moreau",
    )
    assert standalone_colliding.patient_id.startswith("pat_")
    assert standalone_colliding.patient_id != p1.patient_id
    assert updated_b["patient_id"] == standalone_colliding.patient_id

    # Free candidate_id uses canonical Patient.build_id directly
    mdt_form_repo.save_full(
        "unlinked_new.pdf",
        {
            "file": "unlinked_new.pdf",
            "PatientAdministrative": {
                "first_name": "Luc",
                "last_name": "Bernard",
                "date_birth": "1980-01-10",
                "gender": "Male",
            },
        },
    )
    standalone_fresh, _ = service.link_mdt_form_to_patient(
        filename="unlinked_new.pdf",
        target_patient_id="CREATE_NEW",
        override_date_rcp="2026-06-01",
    )
    expected_fresh_id = Patient.build_id(
        first_name="Luc",
        last_name="Bernard",
        date_birth="1980-01-10",
        fallback_file="unlinked_new.pdf",
    )
    assert standalone_fresh.patient_id == expected_fresh_id

    # 2. LLM exception during longitudinal summary falls back deterministically
    with patch(
        "src.infrastructure.llm.factory.get_llm_client",
        side_effect=RuntimeError("Local LLM unavailable"),
    ):
        summary_eval = service.generate_and_save_patient_record_summary(
            p1.patient_id, use_llm=True
        )
    assert summary_eval is not None
    reloaded = patient_repo.get_by_id(p1.patient_id)
    assert reloaded is not None
    assert reloaded.record_summary is not None
    assert reloaded.record_summary["model_used"] == "deterministic-fallback"

    # 3. _cleanup_agenda_and_bugs empty guard & active MDTAgenda removal on patient deletion
    service._cleanup_agenda_and_bugs()
    agenda = MDTAgenda(
        agenda_id="next_mdt_oncology",
        domain="oncology",
        entries=[
            MDTAgendaEntry(patient_id=p1.patient_id),
            MDTAgendaEntry(patient_id=standalone_colliding.patient_id),
        ],
    )
    agenda_repo.save(agenda)
    assert service.delete_patient_record(p1.patient_id) is True
    updated_agenda = agenda_repo.get_active()
    assert updated_agenda is not None
    enrolled_ids = [entry.patient_id for entry in updated_agenda.entries]
    assert p1.patient_id not in enrolled_ids
    assert standalone_colliding.patient_id in enrolled_ids


def test_document_reader_docling_pymupdf_and_splitter_branches(tmp_path: Path):
    """Verify DocumentReader Docling offline fallback, chunk splitter guards, and PyMuPDF loading."""
    pdf_path = tmp_path / "clinical_note.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_text((72, 72), "Clinical synthesis for pancreatic adenocarcinoma.")
        doc.save(str(pdf_path))

    mock_conf = MagicMock()
    mock_conf.rcp.path = str(tmp_path)
    mock_conf.rcp.doc_type = "pymupdf"
    mock_conf.rcp.docling_device = "cpu"
    mock_conf.rcp.chunk_size = -10
    mock_conf.rcp.chunk_overlap = 5000
    mock_conf.llm.embeddings = "bge-m3"
    mock_conf.set_logger.return_value = MagicMock()

    mock_vecdb = MagicMock(spec=VectorialDataBase)
    mock_llm = MagicMock()
    mock_llm.embedding = MagicMock(spec=Embeddings)

    reader = DocumentReader(
        config=mock_conf,
        document="clinical_note.pdf",
        vecdb_client=mock_vecdb,
        llm_client=mock_llm,
    )

    # Invalid chunk_size/overlap falls back safely
    splitter = reader._build_text_splitter()
    assert splitter._chunk_size == 1000
    assert splitter._chunk_overlap == 150

    # PyMuPDF loader extracts text and populates markdown_exporter
    pymupdf_docs = reader._load_document(str(pdf_path), loader_type="pymupdf")
    assert len(pymupdf_docs) >= 1
    assert "pancreatic adenocarcinoma" in pymupdf_docs[0].page_content
    assert len(reader.markdown_exporter) == 1

    # Docling loader both when chunker is None and when chunker is present
    fake_dl_doc = MagicMock()
    fake_dl_doc.export_to_markdown.return_value = "# Heading\nClinical body text."
    fake_conv_res = SimpleNamespace(document=fake_dl_doc)
    fake_converter = MagicMock()
    fake_converter.convert.return_value = fake_conv_res

    with (
        patch.object(
            DocumentReader,
            "get_docling_components",
            return_value=(fake_converter, None),
        ),
        patch("src.application.reader.MetaExtractor") as mock_meta_cls,
    ):
        mock_meta_cls.return_value.extract_dl_doc_meta.return_value = {"source": "dl"}
        docs_no_chunker = reader._load_document(str(pdf_path), loader_type="docling")
    assert len(docs_no_chunker) == 1
    assert "Clinical body text." in docs_no_chunker[0].page_content

    fake_chunker = MagicMock()
    fake_chunker.chunk.return_value = ["raw_chunk_1"]
    fake_chunker.contextualize.return_value = "Contextualized chunk 1"
    with (
        patch.object(
            DocumentReader,
            "get_docling_components",
            return_value=(fake_converter, fake_chunker),
        ),
        patch("src.application.reader.MetaExtractor") as mock_meta_cls,
    ):
        mock_meta_cls.return_value.extract_dl_doc_meta.return_value = {"source": "dl"}
        mock_meta_cls.return_value.extract_chunk_meta.return_value = {"page": 1}
        docs_with_chunker = reader._load_document(str(pdf_path), loader_type="docling")
    assert len(docs_with_chunker) == 1
    assert docs_with_chunker[0].page_content == "Contextualized chunk 1"

    # get_docling_components initializes converter and handles offline tokenizer fallback to None
    orig_conv = DocumentReader._docling_converter
    orig_chunk = DocumentReader._docling_chunker
    try:
        DocumentReader._docling_converter = None
        DocumentReader._docling_chunker = None
        with (
            patch(
                "docling.document_converter.DocumentConverter",
                return_value=fake_converter,
            ),
            patch("docling.document_converter.PdfFormatOption"),
            patch("docling.datamodel.pipeline_options.PdfPipelineOptions"),
            patch("docling.datamodel.pipeline_options.RapidOcrOptions"),
            patch("docling.datamodel.accelerator_options.AcceleratorOptions"),
            patch(
                "docling_core.transforms.chunker.tokenizer.huggingface.HuggingFaceTokenizer.from_pretrained",
                side_effect=OSError("Offline mode"),
            ),
        ):
            conv_out, chunk_out = DocumentReader.get_docling_components("cpu")
            assert conv_out is fake_converter
            assert chunk_out is None
    finally:
        DocumentReader._docling_converter = orig_conv
        DocumentReader._docling_chunker = orig_chunk


def test_vectorial_databases_milvus_chroma_and_batching():
    """Verify MilvusDB delete/is_indexed/retry paths, VectorialDataBase batching, and Chromadb."""
    mock_config = MagicMock()
    mock_config.dbvec.type = "milvus"
    mock_config.dbvec.collection = "medsyntisDocs"
    mock_config.llm.type = "ollama"
    mock_config.llm.embeddings = "bge-m3"
    mock_config.milvus.host = "localhost"
    mock_config.milvus.port = "19530"
    mock_config.milvus.scheme = "http"
    mock_config.milvus.token = ""
    mock_config.milvus.database = "medsyntis"
    mock_config.set_logger.return_value = MagicMock()

    mock_llm_client = MagicMock()
    mock_llm_client.embedding = MagicMock(spec=Embeddings)

    with (
        patch(
            "src.infrastructure.vectorial.database.get_llm_client",
            return_value=mock_llm_client,
        ),
        patch("src.infrastructure.vectorial.milvus.Milvus") as mock_milvus_cls,
        patch("src.infrastructure.vectorial.milvus.db") as mock_db,
        patch("src.infrastructure.vectorial.milvus.connections"),
        patch("src.infrastructure.vectorial.milvus.utility") as mock_utility,
        patch("src.infrastructure.vectorial.milvus.Collection") as mock_col_cls,
        patch("src.infrastructure.vectorial.milvus.time.sleep"),
    ):
        mock_db.list_database.return_value = ["medsyntis"]
        client_inst = MagicMock()
        client_inst.client = None
        mock_milvus_cls.return_value = client_inst

        milvus_db = MilvusDB(mock_config)

        # delete_collection success + exception warning
        mock_utility.has_collection.return_value = True
        milvus_db.delete_collection()
        mock_utility.drop_collection.assert_called_once()

        mock_utility.has_collection.side_effect = RuntimeError("Drop error")
        milvus_db.delete_collection()
        mock_utility.has_collection.side_effect = None

        # is_indexed fallback via Collection.num_entities and exception fallback
        mock_utility.has_collection.return_value = True
        mock_col_cls.return_value = SimpleNamespace(num_entities=3)
        assert milvus_db.is_indexed() is True
        mock_col_cls.return_value = SimpleNamespace(num_entities=0)
        assert milvus_db.is_indexed() is False
        mock_col_cls.side_effect = RuntimeError("ORM unavailable")
        assert milvus_db.is_indexed() is True
        mock_utility.has_collection.return_value = False
        assert milvus_db.is_indexed() is False

        # _add_documents_batch: empty guard, transient retry, and fatal raise
        milvus_db._add_documents_batch([])
        client_inst.add_documents.side_effect = [
            MilvusException(message="partition not found"),
            None,
        ]
        milvus_db._add_documents_batch([Document(page_content="chunk 1")])
        assert client_inst.add_documents.call_count == 2

        client_inst.add_documents.side_effect = MilvusException(
            message="fatal schema error"
        )
        with pytest.raises(MilvusException):
            milvus_db._add_documents_batch([Document(page_content="chunk 2")])

    # Base VectorialDataBase batching (>32 docs) & _add_documents_batch branches
    class DummyVecDB(VectorialDataBase):
        def init_client(self, config):
            self.client = MagicMock()

        def get_embedding(self):
            return self.llm_embeddings

        def set_clientdb(self, flush=False):
            pass

    with patch(
        "src.infrastructure.vectorial.database.get_llm_client",
        return_value=mock_llm_client,
    ):
        dummy_db = DummyVecDB(mock_config)
        dummy_db.collection = MagicMock()
        dummy_db.add_chunked_to_collection([], flush_before=True)
        many_docs = [
            Document(page_content=f"c-{i}", metadata={"i": i}) for i in range(35)
        ]
        dummy_db.add_chunked_to_collection(many_docs, flush_before=False)
        assert dummy_db.collection.add_documents.call_count == 2

        # Fallback to clientdb.add_documents and add_to_collection
        dummy_db.collection = None
        dummy_db.clientdb = MagicMock()
        dummy_db._add_documents_batch([Document(page_content="via clientdb")])
        dummy_db.clientdb.add_documents.assert_called_once()

        dummy_db.clientdb = None
        with patch.object(dummy_db, "add_to_collection") as mock_single_add:
            dummy_db._add_documents_batch([Document(page_content="via single")])
            mock_single_add.assert_called_once()

    # Chromadb delete_collection success & exception suppression
    mock_config.chromadb.client = "PersistentClient"
    with (
        patch(
            "src.infrastructure.vectorial.database.get_llm_client",
            return_value=mock_llm_client,
        ),
        patch(
            "src.infrastructure.vectorial.chromadb.chromadb.PersistentClient"
        ) as mock_chroma_client,
        patch("src.infrastructure.vectorial.chromadb.Chroma"),
    ):
        cdb = Chromadb(mock_config)
        cdb.delete_collection()
        mock_chroma_client.return_value.delete_collection.side_effect = ValueError(
            "Missing"
        )
        cdb.delete_collection()


def test_memory_queue_eviction_and_poll_thinking_step():
    """Verify InMemoryQueueManager terminal/cancelled cap eviction and poll_thinking_step states."""
    manager = InMemoryQueueManager(auto_start_workers=False)
    manager._max_terminal_jobs = 2

    now = datetime.now()
    for idx in range(4):
        jid = f"term-{idx}"
        manager._jobs[jid] = {
            "job_id": jid,
            "status": JobStatus.COMPLETED.value,
            "created_at": now + timedelta(seconds=idx),
            "completed_at": now + timedelta(seconds=idx),
        }
    for idx in range(5):
        cid = f"canc-{idx}"
        manager._cancelled_job_ids.add(cid)
        if idx < 3:
            manager._cancelled_history.append(cid)

    with manager._cond:
        manager._evict_excess_terminal_jobs_locked()

    assert len(manager._jobs) == 2
    assert len(manager._cancelled_job_ids) <= 2

    # poll_thinking_step: active job discovery, thinking delta, heartbeat, deadline, and stop_event
    active_id = "job-live-1"
    manager._jobs[active_id] = {
        "job_id": active_id,
        "domain": "oncology",
        "filename": "case.pdf",
        "status": JobStatus.PROCESSING.value,
        "current_step": "TumorBiology",
        "active_agent": "medical oncologist expert",
        "current_thinking": "Analyzing biomarkers...",
        "thinking_seq": 1,
    }
    state: dict[str, object] = {"domain": "oncology", "timeout": 5.0}
    ev1 = manager.poll_thinking_step(state, wait_timeout=0.05, heartbeat_interval=0.05)
    assert ev1 is not None
    assert ev1["event"] == "thinking"
    assert ev1["delta"] == "Analyzing biomarkers..."
    assert state["tracked_job_id"] == active_id

    # Force heartbeat branch by backdating last_emit_at
    state["last_emit_at"] = datetime.now() - timedelta(seconds=1.0)
    ev_hb = manager.poll_thinking_step(
        state, wait_timeout=0.05, heartbeat_interval=0.05
    )
    assert ev_hb is not None
    assert ev_hb["event"] == "heartbeat"

    # Force deadline branch
    state["deadline"] = datetime.now() - timedelta(seconds=1.0)
    ev_deadline = manager.poll_thinking_step(
        state, wait_timeout=0.05, heartbeat_interval=5.0
    )
    assert ev_deadline is not None
    assert ev_deadline["event"] == "done"

    # Terminal status emits done
    state_term: dict[str, object] = {"job_id": active_id, "timeout": 5.0}
    manager._jobs[active_id]["status"] = JobStatus.COMPLETED.value
    ev_term = manager.poll_thinking_step(
        state_term, wait_timeout=0.05, heartbeat_interval=5.0
    )
    assert ev_term is not None
    assert ev_term["event"] == "done"

    # Stop event emits done immediately
    manager._stop_event.set()
    ev_stop = manager.poll_thinking_step({}, wait_timeout=0.05, heartbeat_interval=5.0)
    assert ev_stop is not None
    assert ev_stop["event"] == "done"


def test_queue_and_patientmdtform_router_edge_cases(
    api_app, client, tmp_path: Path, monkeypatch
):
    """Verify SSE helpers, domain filters, and 500 error handlers on queue and patientmdtform routers."""
    # 1. UnbufferedEventSourceResponse headers
    sse_resp = UnbufferedEventSourceResponse(content=iter([]))
    assert sse_resp.headers.get("x-accel-buffering") == "no"
    assert "no-cache" in sse_resp.headers.get("cache-control", "")

    # 2. _resolve_queue_domain_filter branches
    prod_conf = api_deps.get_base_config().model_copy(
        update={"dev_mode": False, "domain": "oncology"}
    )
    monkeypatch.setattr("src.routers.queue.get_base_config", lambda: prod_conf)
    dummy_req = SimpleNamespace(state=SimpleNamespace())
    assert (
        _resolve_queue_domain_filter(dummy_req, "sma", True, {"is_admin": True}) is None
    )
    assert (
        _resolve_queue_domain_filter(dummy_req, " SMA ", True, {"is_admin": False})
        == "sma"
    )
    assert (
        _resolve_queue_domain_filter(dummy_req, None, False, {"is_admin": False})
        == "oncology"
    )
    dummy_req.state.domain = "sma"
    assert (
        _resolve_queue_domain_filter(dummy_req, None, False, {"is_admin": False})
        == "sma"
    )
    dummy_req.state.requested_domain = "oncology"
    assert (
        _resolve_queue_domain_filter(dummy_req, "sma", False, {"is_admin": False})
        == "oncology"
    )

    # 3. _require_existing_job 404 vs found
    mgr = InMemoryQueueManager(auto_start_workers=False)
    with pytest.raises(HTTPException) as exc_info:
        _require_existing_job("missing-job", mgr)
    assert exc_info.value.status_code == 404
    mgr._jobs["job-ok"] = {"job_id": "job-ok", "status": JobStatus.PENDING.value}
    assert _require_existing_job("job-ok", mgr) == "job-ok"

    # 4. _stream_thinking_sse for both InMemoryQueueManager and generic stream_job_thinking
    async def _collect_sse():
        fake_req = MagicMock()
        fake_req.is_disconnected = MagicMock(side_effect=[False, False])

        async def _not_disconnected():
            return False

        fake_req.is_disconnected = _not_disconnected
        events_mem = [
            ev
            async for ev in _stream_thinking_sse(
                fake_req, mgr, job_id="job-ok", domain="oncology", timeout=1.0
            )
        ]
        assert len(events_mem) == 1
        assert events_mem[0].event == "done"

        generic_mgr = MagicMock()
        generic_mgr.stream_job_thinking.return_value = [
            {
                "event": "done",
                "active": False,
                "job_id": "g-1",
                "status": "COMPLETED",
                "domain": "oncology",
                "filename": "case.pdf",
                "model_name": None,
                "current_step": None,
                "active_agent": None,
                "thinking_seq": 1,
                "delta": "",
                "current_thinking": "",
                "progress_pct": 100.0,
            }
        ]
        events_gen = [
            ev
            async for ev in _stream_thinking_sse(
                fake_req, generic_mgr, job_id="g-1", domain="oncology", timeout=1.0
            )
        ]
        assert len(events_gen) == 1
        assert events_gen[0].event == "done"

    asyncio.run(_collect_sse())

    # 5. HTTP 500 error handlers in patientmdtform router
    broken_service = MagicMock()
    broken_service.update_missing_items_visibility.side_effect = RuntimeError(
        "DB failure"
    )
    broken_service.update_patient_mdt_form_section.side_effect = RuntimeError(
        "DB failure"
    )
    broken_service.rollback_patient_mdt_form_section.side_effect = RuntimeError(
        "DB failure"
    )
    broken_service.update_patient_administrative.side_effect = RuntimeError(
        "DB failure"
    )
    broken_service.link_mdt_form_to_patient.side_effect = RuntimeError("DB failure")

    api_app.dependency_overrides[get_record_service] = lambda: broken_service
    api_app.dependency_overrides[api_deps.require_db] = lambda: MagicMock()
    monkeypatch.setattr(
        "src.routers.patientmdtform._build_record_service",
        lambda *a, **kw: broken_service,
    )

    assert (
        client.patch(
            "/api/v1/patientmdtform/case.pdf/missing-items",
            json={"hide_missing_items": True},
        ).status_code
        == 500
    )
    assert (
        client.patch(
            "/api/v1/patientmdtform/case.pdf/sections/TumorLocation",
            json={"section_data": {"tumor_location": "Pancreas"}},
        ).status_code
        == 500
    )
    assert (
        client.post(
            "/api/v1/patientmdtform/case.pdf/sections/TumorLocation/rollback"
        ).status_code
        == 500
    )
    assert (
        client.patch(
            "/api/v1/patientmdtform/case.pdf/administrative",
            json={"first_name": "Jean", "last_name": "Dupont"},
        ).status_code
        == 500
    )
    assert (
        client.post(
            "/api/v1/patientmdtform/case.pdf/link-patient",
            json={"target_patient_id": "P-1"},
        ).status_code
        == 500
    )


def test_embeddings_len_safe_batching_and_domain_manual_priority_overrides():
    """Verify local OpenAI-compatible embeddings batching and manual CareOrientationProposal metrics."""
    fake_response_obj = MagicMock()
    fake_response_obj.model_dump.return_value = {"data": [{"embedding": [0.1, 0.2]}]}
    fake_client = MagicMock()
    fake_client.create.side_effect = [
        {"data": [{"embedding": [0.3, 0.4]}]},
        fake_response_obj,
    ]

    for emb_cls in (
        LlamaCppCompatibleEmbeddings,
        VllmCompatibleEmbeddings,
        OllamaCompatibleOpenAIEmbeddings,
    ):
        emb = emb_cls.model_construct(model="bge-m3", chunk_size=1, client=fake_client)
        assert emb._get_len_safe_embeddings([], engine="bge-m3") == []
        fake_client.create.side_effect = [
            {"data": [{"embedding": [0.3, 0.4]}]},
            fake_response_obj,
        ]
        vecs = emb._get_len_safe_embeddings(
            ["alpha", "beta"], engine="bge-m3", chunk_size=1
        )
        assert vecs == [[0.3, 0.4], [0.1, 0.2]]

    # Manual CareOrientationProposal priority overrides in PatientMDTForm.extract_card_metrics
    for prio_val, expected_score in (
        (PatientPriority.medium.value, 1),
        (PatientPriority.low.value, 0),
        (PatientPriority.not_given.value, 0),
    ):
        metrics = PatientMDTOncologicForm.extract_card_metrics(
            {
                "ExpertAnswer": {
                    "medical oncologist expert": {
                        "expert_relevant": True,
                        "patient_priority": PatientPriority.urgent.value,
                    }
                },
                "CareOrientationProposal": {
                    "care_adaptation_suggested": True,
                    "suggested_priority": prio_val,
                },
                "manual_edits": {
                    "CareOrientationProposal": {
                        "is_manual": True,
                        "edited_by": "dr_test",
                    }
                },
            }
        )
        assert metrics["urgency_score"] == expected_score

    # Manual CareOrientationProposal with care_adaptation_suggested=False and no suggested_priority
    metrics_no_adapt = PatientMDTOncologicForm.extract_card_metrics(
        {
            "ExpertAnswer": {
                "medical oncologist expert": {
                    "expert_relevant": True,
                    "patient_priority": PatientPriority.urgent.value,
                }
            },
            "CareOrientationProposal": {
                "care_adaptation_suggested": False,
                "suggested_priority": None,
            },
            "manual_edits": {
                "CareOrientationProposal": {"is_manual": True, "edited_by": "dr_test"}
            },
        }
    )
    assert metrics_no_adapt["urgency_score"] == 0
