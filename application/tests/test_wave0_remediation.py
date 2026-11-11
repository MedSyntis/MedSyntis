"""Wave 0 TDD regression tests for issues #29, #30, and #31."""

from __future__ import annotations

from datetime import datetime
import hashlib
import importlib.util
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

from fastapi.testclient import TestClient
import pytest

from src.application.use_cases import (
    PatientMDTFormExtractionService,
    PatientRecordService,
)
from src.domain.patient_dashboard import (
    ONCOLOGY_METRIC_DESCRIPTORS,
    SMA_METRIC_DESCRIPTORS,
    build_patient_metric_series,
)
from src.infrastructure.documents.mongodb import Mongodb
from src.infrastructure.documents.repositories import (
    InMemoryDocumentCacheRepository,
    InMemoryPatientMDTFormRepository,
    InMemoryPatientRepository,
)
from src.routers import dependencies as api_deps
from src.routers.dependencies import get_domain_config
from src.routers.patientmdtform import get_mdt_form_repo
from src.routers.resources import _resolve_resource_pdf_path

APP_API_PATH = Path(__file__).resolve().parent.parent / "app-api.py"


@pytest.fixture()
def api_app_and_client():
    spec = importlib.util.spec_from_file_location("app_api_wave0", APP_API_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = module.app
    client = TestClient(app)
    try:
        yield app, client
    finally:
        app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Issue #29 — Homonym Patient Isolation & Opaque PDF Filename
# ---------------------------------------------------------------------------


def test_homonym_patients_without_birth_date_never_auto_merge():
    """Two homonyms missing date_birth must stay isolated and flag identity_verification_required."""
    patient_repo = InMemoryPatientRepository()
    mdt_repo = InMemoryPatientMDTFormRepository()
    cache_repo = InMemoryDocumentCacheRepository()
    service = PatientRecordService(
        patient_repo=patient_repo,
        mdt_form_repo=mdt_repo,
        cache_repo=cache_repo,
    )

    p1, _ = service.synchronize_patient_from_admin(
        filename="doc_1111111111111111.pdf",
        admin_data={
            "first_name": "Jean",
            "last_name": "DUPONT",
            "date_birth": None,
            "date_rcp": "2026-03-01",
        },
    )
    p2, _ = service.synchronize_patient_from_admin(
        filename="doc_2222222222222222.pdf",
        admin_data={
            "first_name": "Jean",
            "last_name": "DUPONT",
            "date_birth": None,
            "date_rcp": "2026-03-08",
        },
    )

    assert p1.patient_id != p2.patient_id
    assert p1.identity_verification_required is True
    assert p2.identity_verification_required is True
    assert len(patient_repo.list_all()) == 2

    # A verified patient with the same name and a known birth date must NOT hijack p1 or p2
    p3, _ = service.synchronize_patient_from_admin(
        filename="doc_3333333333333333.pdf",
        admin_data={
            "first_name": "Jean",
            "last_name": "DUPONT",
            "date_birth": "1958-04-12",
            "date_rcp": "2026-03-15",
        },
    )
    assert p3.patient_id not in {p1.patient_id, p2.patient_id}
    assert p3.identity_verification_required is False
    assert len(patient_repo.list_all()) == 3

    # A second form for the SAME verified patient (exact name + exact birth date) DOES merge
    p3_bis, _ = service.synchronize_patient_from_admin(
        filename="doc_4444444444444444.pdf",
        admin_data={
            "first_name": "Jean",
            "last_name": "DUPONT",
            "date_birth": datetime(1958, 4, 12),
            "date_rcp": "2026-06-15",
        },
    )
    assert p3_bis.patient_id == p3.patient_id
    assert sorted(p3_bis.files) == [
        "doc_3333333333333333.pdf",
        "doc_4444444444444444.pdf",
    ]


def test_mongodb_find_patient_by_identity_forbids_name_only_homonym_merge():
    """Mongodb.find_patient_by_identity must never query by name_key alone when date_birth is missing."""
    mongo = Mongodb.__new__(Mongodb)
    mongo.get_patient = MagicMock(return_value=None)
    mongo.get_document = MagicMock(
        return_value={"patient_id": "pat_homonym", "name_key": "dupont_jean"}
    )

    found_no_dob = mongo.find_patient_by_identity(
        first_name="Jean",
        last_name="DUPONT",
        date_birth=None,
        fallback_file="doc_aaaa.pdf",
    )
    assert found_no_dob is None
    mongo.get_document.assert_not_called()

    found_with_dob = mongo.find_patient_by_identity(
        first_name="Jean",
        last_name="DUPONT",
        date_birth="1962-09-20",
        fallback_file="doc_bbbb.pdf",
    )
    assert found_with_dob is None
    mongo.get_document.assert_not_called()


def test_resolve_upload_produces_opaque_filename_without_legacy_fallback(
    tmp_path,
):
    """resolve_upload must return doc_<sha256[:16]>.pdf strictly without legacy <stem>_<hash10>.pdf runtime fallbacks."""
    mock_conf = MagicMock()
    mock_conf.rcp.path = str(tmp_path)
    mock_conf.rcp.display_type = "stdout"

    mdt_repo = InMemoryPatientMDTFormRepository()
    extraction_service = PatientMDTFormExtractionService(
        config=mock_conf,
        patient_repo=InMemoryPatientRepository(),
        mdt_form_repo=mdt_repo,
        cache_repo=InMemoryDocumentCacheRepository(),
    )

    pdf_bytes = b"%PDF-1.4 Confidential Patient DUPONT Jean 1954-02-11"
    expected_digest16 = hashlib.sha256(pdf_bytes).hexdigest()[:16]
    opaque_name = f"doc_{expected_digest16}.pdf"

    fname, is_dup = extraction_service.resolve_upload(
        pdf_bytes, "DUPONT_Jean_1954_02_11_RCP.pdf"
    )
    assert is_dup is False
    assert fname == opaque_name
    assert "dupont" not in fname.lower()
    assert "jean" not in fname.lower()
    assert "1954" not in fname

    # Unmigrated legacy `<stem>_<hash10>.pdf` files are NOT recognized at runtime (must run `make migrate`)
    legacy_hash10 = hashlib.sha256(pdf_bytes).hexdigest()[:10]
    legacy_name = f"fiche_rcp_{legacy_hash10}.pdf"
    (tmp_path / legacy_name).write_bytes(pdf_bytes)
    mdt_repo.upsert_fields(
        legacy_name, {"file": legacy_name, "processing_status": "COMPLETED"}
    )
    resolved_after_legacy, is_legacy_dup = extraction_service.resolve_upload(
        pdf_bytes, "fiche_rcp.pdf"
    )
    assert is_legacy_dup is False
    assert resolved_after_legacy == opaque_name

    # Canonical `doc_<sha256[:16]>.pdf` on disk + COMPLETED in repo IS detected as duplicate
    (tmp_path / opaque_name).write_bytes(pdf_bytes)
    mdt_repo.upsert_fields(
        opaque_name, {"file": opaque_name, "processing_status": "COMPLETED"}
    )
    resolved_canonical, is_canonical_dup = extraction_service.resolve_upload(
        pdf_bytes, "DUPONT_Jean_1954_02_11_RCP.pdf"
    )
    assert is_canonical_dup is True
    assert resolved_canonical == opaque_name


def test_upload_endpoint_persists_original_filename_without_url_pii(
    api_app_and_client, tmp_path
):
    """Uploading a PDF must return an opaque filename and persist original_filename in mdt_form_repo."""
    app, client = api_app_and_client
    conf = api_deps.get_base_config().model_copy(deep=True)
    conf.rcp.path = str(tmp_path)
    conf.queue.enabled = False

    mdt_repo = InMemoryPatientMDTFormRepository()
    patient_repo = InMemoryPatientRepository()
    cache_repo = InMemoryDocumentCacheRepository()
    record_svc = PatientRecordService(
        patient_repo=patient_repo,
        mdt_form_repo=mdt_repo,
        cache_repo=cache_repo,
        config=conf,
    )
    extraction_svc = PatientMDTFormExtractionService(
        config=conf,
        patient_repo=patient_repo,
        mdt_form_repo=mdt_repo,
        cache_repo=cache_repo,
        patient_record_service=record_svc,
    )

    def fake_ingest_and_associate(filename: str, patient_id: str | None = None, **_kw):
        p, _ = record_svc.synchronize_patient_from_admin(
            filename=filename,
            admin_data={
                "first_name": "Jean",
                "last_name": "DUPONT",
                "date_birth": None,
            },
            target_patient_id=patient_id,
        )
        return {"file": filename, "patient_id": p.patient_id}, p.to_persistence()

    extraction_svc.ingest_and_associate = MagicMock(
        side_effect=fake_ingest_and_associate
    )

    app.dependency_overrides[get_domain_config] = lambda: conf
    app.dependency_overrides[get_mdt_form_repo] = lambda: mdt_repo

    # Patch router helper _build_extraction_service on the loaded app's router module
    import src.routers.patientmdtform as router_mod

    orig_builder = router_mod._build_extraction_service
    router_mod._build_extraction_service = lambda *_a, **_k: extraction_svc
    try:
        pdf_bytes = b"%PDF-1.4 Upload Endpoint PII Check"
        resp = client.post(
            "/api/v1/patientmdtform/upload",
            files={
                "file": (
                    "DUPONT_Jean_1954_RCP.pdf",
                    pdf_bytes,
                    "application/pdf",
                )
            },
            data={"run_full_ai": "false"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["filename"].startswith("doc_")
        assert "dupont" not in body["filename"].lower()
        saved_doc = mdt_repo.get_by_file(body["filename"])
        assert saved_doc is not None
        assert saved_doc.get("original_filename") == "DUPONT_Jean_1954_RCP.pdf"
    finally:
        router_mod._build_extraction_service = orig_builder


def test_resource_pdf_endpoint_never_serves_patient_files_from_rcp_dir(
    api_app_and_client, tmp_path
):
    """_resolve_resource_pdf_path and GET /api/v1/resources/{f}/file must strictly stay inside resources dir."""
    app, client = api_app_and_client
    res_dir = tmp_path / "resources"
    rcp_dir = tmp_path / "rcp_patients"
    res_dir.mkdir()
    rcp_dir.mkdir()

    (res_dir / "TNCD_pancreas.pdf").write_bytes(b"%PDF-1.4 guideline")
    (rcp_dir / "patient_secret.pdf").write_bytes(b"%PDF-1.4 confidential patient")

    conf = api_deps.get_base_config().model_copy(deep=True)
    conf.rcp.additional_path = str(res_dir)
    conf.rcp.path = str(rcp_dir)
    app.dependency_overrides[get_domain_config] = lambda: conf

    assert _resolve_resource_pdf_path(conf, "patient_secret.pdf") is None

    resp_patient = client.get("/api/v1/resources/patient_secret.pdf/file")
    assert resp_patient.status_code == 404

    resp_guideline = client.get("/api/v1/resources/TNCD_pancreas.pdf/file")
    assert resp_guideline.status_code == 200
    assert resp_guideline.content == b"%PDF-1.4 guideline"


# ---------------------------------------------------------------------------
# Issue #30 — ChemotherapyTreament & SMA HFMSE / sma_type Metrics
# ---------------------------------------------------------------------------


def test_chemotherapy_treament_series_and_manual_edit_provenance():
    """ONCOLOGY_METRIC_DESCRIPTORS must target ChemotherapyTreament and detect manual_edits."""
    onco_keys = {d.metric_key for d in ONCOLOGY_METRIC_DESCRIPTORS}
    assert "ChemotherapyTreament.chemotherapy_name" in onco_keys
    assert "ChemotherapyTreament.chemotherapy_tolerance" in onco_keys
    assert "Chemotherapy.chemotherapy_name" not in onco_keys

    forms: list[dict[str, Any]] = [
        {
            "file": "doc_chemo1.pdf",
            "PatientAdministrative": {"date_rcp": "2026-01-15"},
            "ChemotherapyTreament": {
                "chemotherapy_list": [
                    {
                        "chemotherapy_name": "FOLFIRINOX",
                        "chemotherapy_tolerance": "Good",
                    }
                ]
            },
            "manual_edits": {
                "ChemotherapyTreament": {
                    "is_manual": True,
                    "edited_by": "dr.martin",
                    "edited_at": "2026-01-16T09:00:00",
                }
            },
        }
    ]
    series_by_key = {
        s.metric_key: s for s in build_patient_metric_series(forms, domain="oncology")
    }
    chemo_series = series_by_key["ChemotherapyTreament.chemotherapy_name"]
    assert chemo_series.points[0].display_value == "FOLFIRINOX"
    assert chemo_series.points[0].is_manual is True
    assert chemo_series.points[0].edited_by == "dr.martin"


def test_sma_metric_descriptors_include_hfmse_and_sma_type_without_best_motor_function():
    """SMA_METRIC_DESCRIPTORS must include hfmse_score and sma_type and omit best_motor_function."""
    sma_keys = {d.metric_key for d in SMA_METRIC_DESCRIPTORS}
    assert "MotorFunctionStatus.hfmse_score" in sma_keys
    assert "MotorFunctionStatus.sma_type" in sma_keys
    assert "MotorFunctionStatus.best_motor_function" not in sma_keys

    forms: list[dict[str, Any]] = [
        {
            "file": "doc_sma1.pdf",
            "PatientAdministrative": {"date_rcp": "2025-06-10"},
            "MotorFunctionStatus": {"sma_type": "Type 2", "hfmse_score": 38},
        },
        {
            "file": "doc_sma2.pdf",
            "PatientAdministrative": {"date_rcp": "2026-01-10"},
            "MotorFunctionStatus": {"sma_type": "Type 2", "hfmse_score": 43},
        },
    ]
    series_by_key = {
        s.metric_key: s for s in build_patient_metric_series(forms, domain="sma")
    }
    assert (
        series_by_key["MotorFunctionStatus.hfmse_score"].points[1].delta_numeric == 5.0
    )
    assert (
        series_by_key["MotorFunctionStatus.sma_type"].points[0].display_value
        == "Type 2"
    )


# ---------------------------------------------------------------------------
# Issue #31 — Complete Removal of Dead bbox PDF Variant
# ---------------------------------------------------------------------------


def test_pdf_endpoint_removes_bbox_variant_from_openapi_and_disk_lookup(
    api_app_and_client, tmp_path
):
    """GET /api/v1/patientmdtform/{filename}/pdf must have no variant query parameter and ignore .bbox files."""
    app, client = api_app_and_client
    conf = api_deps.get_base_config().model_copy(deep=True)
    conf.rcp.path = str(tmp_path)
    app.dependency_overrides[get_domain_config] = lambda: conf

    plain_pdf = tmp_path / "doc_plain.pdf"
    plain_pdf.write_bytes(b"%PDF-1.4 canonical plain pdf")
    stray_bbox = tmp_path / "doc_plain.pdf.bbox"
    stray_bbox.write_bytes(b"%PDF-1.4 obsolete bbox pdf")

    spec = client.get("/api/v1/openapi.json").json()
    pdf_op = spec["paths"]["/api/v1/patientmdtform/{filename}/pdf"]["get"]
    param_names = {p["name"] for p in pdf_op.get("parameters", [])}
    assert "variant" not in param_names
    assert "inline" in param_names

    resp = client.get("/api/v1/patientmdtform/doc_plain.pdf/pdf?inline=true")
    assert resp.status_code == 200
    assert resp.content == b"%PDF-1.4 canonical plain pdf"


# ---------------------------------------------------------------------------
# Canonical Zero-Legacy Migration Script (`scripts/migrate.py`)
# ---------------------------------------------------------------------------


class _FakeMongoCollection:
    """Minimal in-memory PyMongo collection double supporting `$set`, `$unset`, `insert_one`, and `delete_one`."""

    def __init__(self, initial_docs: list[dict[str, Any]] | None = None):
        self._docs: list[dict[str, Any]] = []
        self._seq = 0
        for d in initial_docs or []:
            self.insert_one(d)

    def _next_id(self) -> str:
        self._seq += 1
        return f"oid_{self._seq}"

    def find(self, query: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        query = query or {}
        out: list[dict[str, Any]] = []
        for doc in self._docs:
            if all(doc.get(k) == v for k, v in query.items()):
                out.append(dict(doc))
        return out

    def insert_one(self, doc: dict[str, Any]) -> None:
        copy = dict(doc)
        copy.setdefault("_id", self._next_id())
        self._docs.append(copy)

    def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> None:
        for doc in self._docs:
            if all(doc.get(k) == v for k, v in query.items()):
                if "$set" in update:
                    doc.update(update["$set"])
                if "$unset" in update:
                    for key in update["$unset"]:
                        doc.pop(key, None)
                break

    def delete_one(self, query: dict[str, Any]) -> None:
        for idx, doc in enumerate(self._docs):
            if all(doc.get(k) == v for k, v in query.items()):
                self._docs.pop(idx)
                break


class _FakeMongoDatabase:
    def __init__(self, collections: dict[str, _FakeMongoCollection]):
        self._collections = collections

    def __getitem__(self, name: str) -> _FakeMongoCollection:
        if name not in self._collections:
            self._collections[name] = _FakeMongoCollection()
        return self._collections[name]


def test_migrate_script_converts_legacy_files_schemas_homonyms_and_is_idempotent(
    tmp_path, monkeypatch
):
    """`scripts/migrate.py` must migrate filesystem PDFs, MongoDB schemas/identities, and Milvus collections idempotently."""
    from scripts.migrate import (
        build_vector_collection_name,
        migrate_database_storage_and_schema,
        migrate_filesystem_pdfs,
        migrate_milvus_collections,
    )
    from src.domain.patient import Patient

    # 1. Seed legacy files on disk (including `.bbox` sidecar + two legacy homonym PDFs)
    bytes_1 = b"%PDF-1.4 Homonym Patient 1"
    bytes_2 = b"%PDF-1.4 Homonym Patient 2"
    digest_1 = hashlib.sha256(bytes_1).hexdigest()
    digest_2 = hashlib.sha256(bytes_2).hexdigest()
    opaque_1 = f"doc_{digest_1[:16]}.pdf"
    opaque_2 = f"doc_{digest_2[:16]}.pdf"

    legacy_file_1 = f"DUPONT_Jean_{digest_1[:10]}.pdf"
    legacy_file_2 = f"DUPONT_Jean_{digest_2[:10]}.pdf"
    (tmp_path / legacy_file_1).write_bytes(bytes_1)
    (tmp_path / legacy_file_2).write_bytes(bytes_2)
    (tmp_path / f"{legacy_file_1}.bbox").write_bytes(b"%PDF-1.4 dead bbox")

    # Dry-run filesystem check: zero disk mutation
    dry_map, dry_fs_stats = migrate_filesystem_pdfs(tmp_path, dry_run=True)
    assert dry_fs_stats["bbox_files_deleted"] == 1
    assert dry_fs_stats["pdf_files_renamed"] == 2
    assert dry_map == {legacy_file_1: opaque_1, legacy_file_2: opaque_2}
    assert (tmp_path / legacy_file_1).exists()
    assert (tmp_path / f"{legacy_file_1}.bbox").exists()

    # Live filesystem migration
    live_map, live_fs_stats = migrate_filesystem_pdfs(tmp_path, dry_run=False)
    assert live_fs_stats["bbox_files_deleted"] == 1
    assert live_fs_stats["pdf_files_renamed"] == 2
    assert not (tmp_path / legacy_file_1).exists()
    assert not (tmp_path / f"{legacy_file_1}.bbox").exists()
    assert (tmp_path / opaque_1).read_bytes() == bytes_1
    assert (tmp_path / opaque_2).read_bytes() == bytes_2

    # 2. Seed MongoDB with legacy merged unverified homonyms + legacy `Chemotherapy` section
    legacy_merged_pid = (
        "pat_" + hashlib.sha256(b"medsyntis:patient:dupont_jean").hexdigest()[:16]
    )
    fake_db = _FakeMongoDatabase(
        {
            "patients": _FakeMongoCollection(
                [
                    {
                        "patient_id": legacy_merged_pid,
                        "name_key": "dupont_jean",
                        "first_name": "Jean",
                        "last_name": "DUPONT",
                        "date_birth": None,
                        "files": [legacy_file_1, legacy_file_2],
                    }
                ]
            ),
            "rcp_info": _FakeMongoCollection(
                [
                    {
                        "file": legacy_file_1,
                        "patient_id": legacy_merged_pid,
                        "Chemotherapy": {"chemotherapy_name": "FOLFIRINOX"},
                        "manual_edits": {
                            "Chemotherapy": {
                                "is_manual": True,
                                "edited_by": "dr.martin",
                            }
                        },
                        "manually_edited_sections": ["Chemotherapy"],
                        "execution_times": {"Chemotherapy": 4.2},
                        "bbox": {"obsolete": True},
                    },
                    {
                        "file": legacy_file_2,
                        "patient_id": legacy_merged_pid,
                        "RadiologicalExams": {"exams_list": []},
                    },
                ]
            ),
            "document_cache": _FakeMongoCollection(
                [
                    {"hash": digest_1, "file": legacy_file_1, "markdown": "# Doc 1"},
                ]
            ),
            "mdt_agendas": _FakeMongoCollection(
                [
                    {
                        "agenda_id": "default",
                        "entries": [
                            {
                                "patient_id": legacy_merged_pid,
                                "filename": legacy_file_1,
                                "manual_order": 0,
                            }
                        ],
                    }
                ]
            ),
            "bug_reports": _FakeMongoCollection(
                [
                    {
                        "bug_id": "BUG-1",
                        "patient_id": legacy_merged_pid,
                        "rcp_file": legacy_file_2,
                    }
                ]
            ),
        }
    )

    # Dry-run DB check: zero DB mutation
    _, dry_db_stats = migrate_database_storage_and_schema(
        fake_db, file_map=live_map, dry_run=True
    )
    assert dry_db_stats["forms_file_migrated"] == 2
    assert dry_db_stats["forms_sections_migrated"] == 2
    assert dry_db_stats["unverified_patients_isolated"] == 1
    assert fake_db["rcp_info"].find()[0]["file"] == legacy_file_1

    # Live DB migration
    effective_map, live_db_stats = migrate_database_storage_and_schema(
        fake_db, file_map=live_map, dry_run=False
    )
    assert live_db_stats["forms_file_migrated"] == 2
    assert live_db_stats["forms_sections_migrated"] == 2
    assert live_db_stats["unverified_patients_isolated"] == 1
    assert live_db_stats["cache_docs_migrated"] == 1
    assert live_db_stats["agendas_files_migrated"] == 1
    assert live_db_stats["bugs_files_migrated"] == 1

    # Verify isolated provisional patients
    patients_after = fake_db["patients"].find()
    assert len(patients_after) == 2
    expected_pid_1 = Patient.build_id(
        first_name="Jean",
        last_name="DUPONT",
        date_birth=None,
        fallback_file=opaque_1,
    )
    expected_pid_2 = Patient.build_id(
        first_name="Jean",
        last_name="DUPONT",
        date_birth=None,
        fallback_file=opaque_2,
    )
    assert {p["patient_id"] for p in patients_after} == {expected_pid_1, expected_pid_2}
    assert all(p["identity_verification_required"] is True for p in patients_after)

    # Verify forms canonicalization (`Chemotherapy` -> `ChemotherapyTreament`, `original_filename` preserved)
    forms_after = {f["file"]: f for f in fake_db["rcp_info"].find()}
    assert set(forms_after.keys()) == {opaque_1, opaque_2}
    f1 = forms_after[opaque_1]
    assert f1["original_filename"] == legacy_file_1
    assert f1["patient_id"] == expected_pid_1
    assert "Chemotherapy" not in f1
    assert "bbox" not in f1
    assert f1["ChemotherapyTreament"] == {"chemotherapy_name": "FOLFIRINOX"}
    assert "ChemotherapyTreament" in f1["manual_edits"]
    assert "Chemotherapy" not in f1["manual_edits"]
    assert f1["manually_edited_sections"] == ["ChemotherapyTreament"]
    assert f1["execution_times"] == {"ChemotherapyTreament": 4.2}

    f2 = forms_after[opaque_2]
    assert f2["patient_id"] == expected_pid_2
    assert "RadiologicalExams" not in f2
    assert f2["RadiologicExams"] == {"exams_list": []}

    # Verify cache, agenda, and bug report cascades
    assert fake_db["document_cache"].find()[0]["file"] == opaque_1
    agenda_entry = fake_db["mdt_agendas"].find()[0]["entries"][0]
    assert agenda_entry["filename"] == opaque_1
    assert agenda_entry["patient_id"] == expected_pid_1
    bug_after = fake_db["bug_reports"].find()[0]
    assert bug_after["rcp_file"] == opaque_2
    assert bug_after["patient_id"] == expected_pid_2

    # 3. Idempotency check: second run mutates nothing
    _, rerun_fs = migrate_filesystem_pdfs(tmp_path, dry_run=False)
    _, rerun_db = migrate_database_storage_and_schema(
        fake_db, file_map={}, dry_run=False
    )
    assert rerun_fs["pdf_files_renamed"] == 0
    assert rerun_fs["pdf_files_already_opaque"] == 2
    assert rerun_db["forms_file_migrated"] == 0
    assert rerun_db["forms_sections_migrated"] == 0
    assert rerun_db["unverified_patients_isolated"] == 0
    assert rerun_db["patients_flags_updated"] == 0

    # 4. Milvus collection rename test with mocked pymilvus
    conf = api_deps.get_base_config().model_copy(deep=True)
    conf.dbvec.type = "milvus"
    old_coll_1 = build_vector_collection_name(conf, legacy_file_1)
    new_coll_1 = build_vector_collection_name(conf, opaque_1)
    old_coll_2 = build_vector_collection_name(conf, legacy_file_2)
    new_coll_2 = build_vector_collection_name(conf, opaque_2)
    existing_colls = {old_coll_1, old_coll_2, new_coll_2}
    renamed_pairs: list[tuple[str, str]] = []
    dropped_colls: list[str] = []

    import pymilvus

    monkeypatch.setattr(pymilvus.connections, "connect", lambda **_k: None)
    monkeypatch.setattr(pymilvus.connections, "disconnect", lambda *_a, **_k: None)
    monkeypatch.setattr(
        pymilvus.db, "list_database", lambda **_k: [conf.milvus.database]
    )
    monkeypatch.setattr(pymilvus.db, "using_database", lambda *_a, **_k: None)
    monkeypatch.setattr(
        pymilvus.utility, "has_collection", lambda c, **_k: c in existing_colls
    )
    monkeypatch.setattr(
        pymilvus.utility,
        "rename_collection",
        lambda old_c, new_c, **_k: renamed_pairs.append((old_c, new_c)),
    )
    monkeypatch.setattr(
        pymilvus.utility,
        "drop_collection",
        lambda old_c, **_k: dropped_colls.append(old_c),
    )

    vec_stats = migrate_milvus_collections(conf, effective_map, dry_run=False)
    assert vec_stats["vector_collections_renamed"] == 1
    assert vec_stats["vector_collections_dropped_duplicate"] == 1
    assert renamed_pairs == [(old_coll_1, new_coll_1)]
    assert dropped_colls == [old_coll_2]
