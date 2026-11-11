"""Unit and non-regression tests for Issue #22 full-audit remediations."""

from datetime import datetime
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from pydantic import SecretStr, ValidationError
import pytest

from src.application.agent.agent import MedSyntisAgent
from src.application.config import AppConfig
from src.application.reader import DocumentReader
from src.application.use_cases import PatientRecordService
from src.domain.bug_report import BugCategory, BugReport, BugSeverity, BugStatus
from src.domain.common.common_ressources import Gender, PatientPriority
from src.domain.oncology.patient_mdt_oncologic_form import PatientMDTOncologicForm
from src.domain.patient import Patient, PatientIdentity
from src.domain.sma.patient_mdt_sma_form import PatientMDTSmaForm
from src.infrastructure.documents.mongodb import Mongodb, close_all_mongo_clients
from src.infrastructure.documents.repositories import (
    InMemoryBugReportRepository,
    InMemoryDocumentCacheRepository,
    InMemoryPatientMDTFormRepository,
    InMemoryPatientRepository,
    MongoBugReportRepository,
    MongoPatientRepository,
)
from src.infrastructure.vectorial.database import sanitize_collection_name
from src.infrastructure.vectorial.milvus import MilvusDB
from src.routers import dependencies as api_deps
from src.routers.bug_reports import get_bug_report_repo

APP_API_PATH = Path(__file__).resolve().parent.parent / "app-api.py"


@pytest.fixture(scope="module")
def api_app():
    """Load the FastAPI application without starting background lifespan workers."""
    spec = importlib.util.spec_from_file_location(
        "app_api_audit_remediations", APP_API_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.app


@pytest.fixture
def client(api_app):
    """Provide an isolated FastAPI TestClient per test."""
    api_app.dependency_overrides.clear()
    yield TestClient(api_app)
    api_app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# 1. Pseudonymized Patient.build_id, zero PII leakage, patient_ prefix & legacy fallback
# ---------------------------------------------------------------------------
class TestPseudonymizedPatientIdentifiers:
    """Verify SHA-256 pseudonymized patient IDs and legacy slug backward compatibility."""

    def test_build_id_is_deterministic_and_leaks_zero_pii(self):
        pid_a = Patient.build_id("Jean-Pierre", "Dupont", "1964-08-19")
        pid_b = Patient.build_id("  jean pierre ", "DUPONT", datetime(1964, 8, 19))
        assert pid_a == pid_b
        assert pid_a.startswith("pat_")
        assert len(pid_a) == 20

        lower_id = pid_a.lower()
        for pii_token in ("jean", "pierre", "dupont", "1964", "08", "19"):
            if len(pii_token) >= 4:
                assert pii_token not in lower_id

        legacy_id = Patient.build_legacy_id("Jean-Pierre", "Dupont", "1964-08-19")
        assert legacy_id == "dupont_jean_pierre_1964_08_19"
        assert (
            PatientIdentity(
                first_name="Jean-Pierre",
                last_name="Dupont",
                date_birth=datetime(1964, 8, 19),
            ).build_legacy_patient_id()
            == "dupont_jean_pierre_1964_08_19"
        )

    def test_unidentified_fallback_keeps_patient_prefix_and_hides_filename_pii(self):
        fallback_pid = Patient.build_id(
            first_name="",
            last_name="",
            date_birth=None,
            fallback_file="compte_rendu_dupont_marie_1975.pdf",
        )
        assert fallback_pid.startswith("patient_")
        assert len(fallback_pid) == len("patient_") + 16
        assert "dupont" not in fallback_pid
        assert "marie" not in fallback_pid
        assert "1975" not in fallback_pid

        legacy_fallback = Patient.build_legacy_id(
            first_name="",
            last_name="",
            date_birth=None,
            fallback_file="compte_rendu_dupont_marie_1975.pdf",
        )
        assert legacy_fallback.startswith("patient_compte_rendu_dupont_marie_1975")

    def test_in_memory_and_mongo_repositories_fallback_to_legacy_slug(self):
        # 1. InMemoryPatientRepository legacy record lookup & find_by_identity
        legacy_patient = Patient(
            patient_id="dupont_jean_1964_08_19",
            first_name="Jean",
            last_name="Dupont",
            date_birth=datetime(1964, 8, 19),
            gender=Gender.male,
            files=["legacy_rcp.pdf"],
        )
        mem_repo = InMemoryPatientRepository([legacy_patient])
        new_pid = Patient.build_id("Jean", "Dupont", "1964-08-19")

        found_by_new_id = mem_repo.get_by_id(new_pid)
        assert found_by_new_id is not None
        assert found_by_new_id.files == ["legacy_rcp.pdf"]

        found_by_identity = mem_repo.find_by_identity(
            first_name="Jean",
            last_name="Dupont",
            date_birth="1964-08-19",
        )
        assert found_by_identity is not None
        assert found_by_identity.patient_id == "dupont_jean_1964_08_19"

        # Also check reverse lookup: persisted pat_<16hex> queried by legacy slug
        modern_patient = Patient.from_administrative(
            {
                "first_name": "Claire",
                "last_name": "Moreau",
                "date_birth": "1982-09-20",
            },
            filename="modern_rcp.pdf",
        )
        mem_repo.save(modern_patient)
        found_by_legacy_slug = mem_repo.get_by_id("moreau_claire_1982_09_20")
        assert found_by_legacy_slug is not None
        assert found_by_legacy_slug.patient_id == modern_patient.patient_id

        # 2. MongoPatientRepository / Mongodb legacy fallback on find_patient_by_identity & upsert
        close_all_mongo_clients()
        try:
            with patch("src.infrastructure.documents.mongodb.MongoClient"):
                mock_conf = MagicMock()
                mock_conf.mongodb.host = "127.0.0.1"
                mock_conf.mongodb.port = "27017"
                mock_conf.mongodb.user = ""
                mock_conf.mongodb.password = ""
                mock_conf.mongodb.database = "TestLegacyFallback"
                mock_conf.set_logger.return_value = MagicMock()

                db = Mongodb(mock_conf)
                mock_database = MagicMock()
                col = MagicMock()
                mock_database.__getitem__.return_value = col
                db.database = mock_database

                legacy_doc = {
                    "patient_id": "dupont_jean_1964_08_19",
                    "name_key": "dupont_jean",
                    "first_name": "Jean",
                    "last_name": "Dupont",
                    "date_birth": "1964-08-19",
                    "gender": "Male",
                    "files": ["old_2021.pdf"],
                }

                def fake_find_one(flt):
                    if flt == {"patient_id": "dupont_jean_1964_08_19"}:
                        return dict(legacy_doc)
                    return None

                col.find_one.side_effect = fake_find_one
                mongo_repo = MongoPatientRepository(db)
                matched = mongo_repo.find_by_identity(
                    first_name="Jean",
                    last_name="Dupont",
                    date_birth="1964-08-19",
                )
                assert matched is not None
                assert matched.files == ["old_2021.pdf"]
        finally:
            close_all_mongo_clients()


# ---------------------------------------------------------------------------
# 2. CareOrientationProposal editability & longitudinal date_rcp > 5 years preserved
# ---------------------------------------------------------------------------
class TestCareOrientationHumanOversightAndLongitudinalDates:
    """Verify CSP Art. L. 4001-2 human editability and historical MDT dates."""

    @pytest.mark.parametrize("form_cls", [PatientMDTOncologicForm, PatientMDTSmaForm])
    def test_care_orientation_proposal_is_manually_editable(
        self, form_cls, tmp_path: Path
    ):
        assert form_cls.is_section_manually_editable("CareOrientationProposal") is True
        assert form_cls.is_section_manually_editable("ExpertAnswer") is False

        validated = form_cls.validate_manual_section_update(
            "CareOrientationProposal",
            {
                "care_adaptation_suggested": True,
                "suggested_priority": PatientPriority.urgent.value,
                "proposed_care_type": "Pre-MDT collegial surgical review",
                "clinical_rationale": "Clinician override after multidisciplinary review.",
            },
        )
        assert validated["care_adaptation_suggested"] is True
        assert validated["proposed_care_type"] == "Pre-MDT collegial surgical review"

        conf = AppConfig()
        conf.rcp.path = tmp_path
        svc = PatientRecordService(
            patient_repo=InMemoryPatientRepository(),
            mdt_form_repo=InMemoryPatientMDTFormRepository(),
            cache_repo=InMemoryDocumentCacheRepository(),
            form_cls=form_cls,
            config=conf,
        )
        updated_doc = svc.update_patient_mdt_form_section(
            filename="case_override.pdf",
            section_name="CareOrientationProposal",
            section_data=validated,
            edited_by="dr_collegial",
        )
        assert (
            updated_doc["manual_edits"]["CareOrientationProposal"]["is_manual"] is True
        )
        assert (
            updated_doc["manual_edits"]["CareOrientationProposal"]["edited_by"]
            == "dr_collegial"
        )

    def test_historical_date_rcp_older_than_five_years_is_preserved(self):
        admin_historical = PatientMDTOncologicForm.PatientAdministrative(
            first_name="Pierre",
            last_name="Curie",
            age=63,
            date_birth=datetime(1955, 5, 15),
            date_rcp=datetime(2018, 5, 10),
            gender=Gender.male,
        )
        assert admin_historical.date_rcp == datetime(2018, 5, 10)

        # Implausible date_rcp before date_birth raises a validation error
        with pytest.raises(
            ValidationError, match="Date of birth must be before Date of RCP"
        ):
            PatientMDTOncologicForm.PatientAdministrative(
                first_name="Pierre",
                last_name="Curie",
                age=30,
                date_birth=datetime(1990, 5, 15),
                date_rcp=datetime(1985, 1, 1),
                gender=Gender.male,
            )

        admin_pre_1970 = PatientMDTOncologicForm.PatientAdministrative(
            first_name="Pierre",
            last_name="Curie",
            age=70,
            date_birth=datetime(1950, 1, 1),
            date_rcp=datetime(1965, 6, 1),
            gender=Gender.male,
        )
        assert admin_pre_1970.date_rcp is None

    def test_nullable_clinical_fields_default_to_none_without_hallucination(self):
        onco_ps = PatientMDTOncologicForm.PatientPerformanceStatus()
        assert onco_ps.performance_status is None
        onco_prev_surg = PatientMDTOncologicForm.PreviousCurativeSurgery()
        assert onco_prev_surg.previous_curative_surgery is None
        onco_plan_surg = PatientMDTOncologicForm.PlannedCurativeSurgery()
        assert onco_plan_surg.planned_curative_surgery is None
        onco_chemo = PatientMDTOncologicForm.ChemotherapyTreament()
        assert onco_chemo.chemotherapy is None

        sma_ps = PatientMDTSmaForm.PatientPerformanceStatus()
        assert sma_ps.performance_status is None
        sma_gen = PatientMDTSmaForm.GeneticDiagnosis()
        assert sma_gen.smn1_deletion_confirmed is None
        assert sma_gen.smn2_copy_count is None
        sma_resp = PatientMDTSmaForm.RespiratoryFunction()
        assert sma_resp.requires_ventilation_support is None
        assert sma_resp.uses_cough_assist is None


# ---------------------------------------------------------------------------
# 3. BugReportRepository / Mongodb delete -> bool & update on missing -> None (404)
# ---------------------------------------------------------------------------
class TestBugReportPersistenceSafety:
    """Verify delete returns bool and update on missing ID returns None without corrupting list_all."""

    def test_in_memory_bug_report_repo_delete_bool_and_missing_update(
        self, api_app, client
    ):
        repo = InMemoryBugReportRepository()
        assert repo.delete("bug_missing") is False
        assert repo.update_status("bug_missing", BugStatus.resolved) is None

        report = BugReport(
            bug_id="bug_valid001",
            title="UI contrast issue",
            description="Low contrast badge in dark mode",
            category=BugCategory.ui,
            severity=BugSeverity.low,
        )
        repo.create(report)
        assert len(repo.list_all()) == 1
        assert repo.delete("bug_valid001") is True
        assert repo.delete("bug_valid001") is False
        assert repo.list_all() == []

        # Router contract check: missing update -> 404, subsequent GET /bug-reports -> 200 []
        api_app.dependency_overrides[get_bug_report_repo] = lambda: repo
        patch_resp = client.patch(
            "/api/v1/bug-reports/bug_nonexistent/status",
            json={"status": BugStatus.closed.value},
        )
        assert patch_resp.status_code == 404
        list_resp = client.get("/api/v1/bug-reports")
        assert list_resp.status_code == 200
        assert list_resp.json() == []

    def test_mongodb_bug_report_update_missing_and_corrupt_doc_skipping(self):
        close_all_mongo_clients()
        try:
            with patch("src.infrastructure.documents.mongodb.MongoClient"):
                mock_conf = MagicMock()
                mock_conf.mongodb.host = "127.0.0.1"
                mock_conf.mongodb.port = "27017"
                mock_conf.mongodb.user = ""
                mock_conf.mongodb.password = ""
                mock_conf.mongodb.database = "TestBugReports"
                mock_conf.set_logger.return_value = MagicMock()

                db = Mongodb(mock_conf)
                mock_database = MagicMock()
                col = MagicMock()
                mock_database.__getitem__.return_value = col
                db.database = mock_database

                # Missing bug_id on find_one_and_update returns None (no upsert!)
                col.find_one_and_update.return_value = None
                assert (
                    db.update_bug_report(
                        "bug_ghost", {"status": BugStatus.resolved.value}
                    )
                    is None
                )
                _, call_kwargs = col.find_one_and_update.call_args
                assert call_kwargs.get("upsert") is False

                # delete_bug_report returns False when deleted_count == 0, True when > 0
                col.delete_one.return_value.deleted_count = 0
                assert db.delete_bug_report("bug_ghost") is False
                col.delete_one.return_value.deleted_count = 1
                assert db.delete_bug_report("bug_ok") is True

                # MongoBugReportRepository.list_all skips corrupt partial documents safely
                valid_doc = BugReport(
                    bug_id="bug_clean01",
                    title="Valid bug",
                    description="Complete schema",
                ).model_dump(mode="json")
                corrupt_doc = {
                    "bug_id": "bug_corrupt",
                    "status": "closed",
                }  # missing title/description
                col.find.return_value = [corrupt_doc, valid_doc]

                mongo_repo = MongoBugReportRepository(db)
                listed = mongo_repo.list_all()
                assert len(listed) == 1
                assert listed[0]["bug_id"] == "bug_clean01"
        finally:
            close_all_mongo_clients()


# ---------------------------------------------------------------------------
# 4. Fail-closed AppConfig.is_admin() and require_admin when dev_mode=False
# ---------------------------------------------------------------------------
class TestFailClosedAdminAuthorization:
    """Verify AppConfig.is_admin() and FastAPI require_admin fail closed outside dev_mode."""

    def test_app_config_is_admin_fails_closed_outside_dev_mode(self):
        prod_empty = AppConfig(
            dev_mode=False,
            admin_users="",
            api_token=SecretStr("prod-api-token-123456"),
        )
        assert prod_empty.is_admin("dr_anyone") is False
        assert prod_empty.is_admin(None) is False

        prod_configured = AppConfig(
            dev_mode=False,
            admin_users="dr_chief",
            api_token=SecretStr("prod-api-token-123456"),
        )
        assert prod_configured.is_admin("dr_chief") is True
        assert prod_configured.is_admin("dr_intern") is False
        assert prod_configured.is_admin(None) is False

    def test_require_admin_fails_closed_when_dev_mode_false_and_admin_users_empty(
        self, client, monkeypatch
    ):
        prod_conf = AppConfig(
            dev_mode=False,
            admin_users="",
            api_token=SecretStr("prod-api-token-123456"),
            proxy_secret=SecretStr("proxy-shared-secret"),
        )
        monkeypatch.setattr(api_deps, "get_base_config", lambda: prod_conf)

        # Direct dependency call without user or with user fails closed (403)
        with pytest.raises(HTTPException) as exc_no_user:
            api_deps.require_admin(
                x_user=None,
                x_user_name=None,
                x_proxy_secret="proxy-shared-secret",
            )
        assert exc_no_user.value.status_code == 403

        with pytest.raises(HTTPException) as exc_with_user:
            api_deps.require_admin(
                x_user="dr_anyone",
                x_user_name="Dr Anyone",
                x_proxy_secret="proxy-shared-secret",
            )
        assert exc_with_user.value.status_code == 403

        # End-to-end HTTP check on newly protected DELETE / PATCH routes
        auth_headers = {
            "Authorization": "Bearer prod-api-token-123456",
            "X-MedSyntis-Proxy-Secret": "proxy-shared-secret",
            "X-MedSyntis-User": "dr_anyone",
        }
        assert (
            client.delete(
                "/api/v1/patientmdtform/any_case.pdf", headers=auth_headers
            ).status_code
            == 403
        )
        assert (
            client.delete(
                "/api/v1/resources/guideline.pdf", headers=auth_headers
            ).status_code
            == 403
        )
        assert (
            client.delete(
                "/api/v1/bug-reports/bug_123", headers=auth_headers
            ).status_code
            == 403
        )


# ---------------------------------------------------------------------------
# 5. VectorialDataBase / MilvusDB digit-prefixed & long collection naming sanitization
# ---------------------------------------------------------------------------
class TestVectorCollectionNamingAndPromptGuardrails:
    """Verify Milvus collection name sanitization and prompt-injection defenses."""

    @patch("src.infrastructure.vectorial.database.get_llm_client")
    @patch("src.infrastructure.vectorial.milvus.Milvus")
    @patch("src.infrastructure.vectorial.milvus.db")
    @patch("src.infrastructure.vectorial.milvus.connections")
    @patch("src.infrastructure.vectorial.milvus.utility")
    def test_digit_prefixed_and_oversized_collection_names_are_sanitized(
        self,
        mock_utility,
        mock_connections,
        mock_db,
        mock_milvus_cls,
        mock_get_llm_client,
        tmp_path: Path,
    ):
        # 1. Direct helper checks
        digit_name = sanitize_collection_name("2026_rcp.pdf")
        assert digit_name.startswith("doc_2026_rcp")
        assert digit_name[0].isalpha()

        very_long_raw = "2026_" + ("long_clinical_filename_" * 15)
        truncated = sanitize_collection_name(very_long_raw)
        assert truncated.startswith("doc_2026_")
        assert len(truncated) <= 240

        # 2. MilvusDB & DocumentReader integration check for "2026_rcp.pdf"
        pdf_file = tmp_path / "2026_rcp.pdf"
        pdf_file.write_bytes(b"%PDF-1.4 sample")

        mock_conf = MagicMock()
        mock_conf.dbvec.type = "milvus"
        mock_conf.dbvec.collection = "medsyntisDocs"
        mock_conf.llm.type = "ollama"
        mock_conf.llm.embeddings = "bge-m3"
        mock_conf.milvus.host = "localhost"
        mock_conf.milvus.port = "19530"
        mock_conf.milvus.scheme = "http"
        mock_conf.milvus.token = "root:Milvus"
        mock_conf.milvus.database = "medsyntis_oncology"
        mock_conf.rcp.path = str(tmp_path)
        mock_conf.rcp.doc_type = "pymupdf"
        mock_conf.set_logger.return_value = MagicMock()

        mock_llm = MagicMock()
        mock_llm.embedding = MagicMock(spec=Embeddings)
        mock_get_llm_client.return_value = mock_llm
        mock_db.list_database.return_value = ["medsyntis_oncology"]

        reader = DocumentReader(
            config=mock_conf,
            document="2026_rcp.pdf",
            vecdb_client=None,
            llm_client=mock_llm,
        )
        assert isinstance(reader.vecdb, MilvusDB)
        assert reader.vecdb.coll_name.startswith("doc_2026_rcp")
        assert len(reader.vecdb.coll_name) <= 240
        assert reader.vecdb._alias == "medsyntis_medsyntis_oncology"

    @patch("src.application.agent.agent.create_agent")
    @patch("src.application.agent.agent.get_llm_client")
    def test_prefetched_markdown_wrapping_and_oversized_cap(
        self, mock_get_llm_client, mock_create_agent
    ):
        from src.application.agent.tools import search_on_mtd

        mock_conf = MagicMock()
        mock_conf.llm.models = "mistral-nemo"
        mock_conf.language = "french"
        mock_conf.set_logger.return_value = MagicMock()
        mock_get_llm_client.return_value = MagicMock()

        # 1. Normal prefetched_markdown is wrapped inside <untrusted_patient_record> with guardrail
        MedSyntisAgent(
            config=mock_conf,
            output_format=PatientMDTOncologicForm.TumorLocation,
            prefetched_markdown="Patient age 62.",
        )
        built_prompt = mock_create_agent.call_args.kwargs["system_prompt"]
        assert "SECURITY GUARDRAIL" in built_prompt
        assert (
            "<untrusted_patient_record>\nPatient age 62.\n</untrusted_patient_record>"
            in built_prompt
        )

        # 2. Oversized markdown (> 80_000 chars) returns None and falls back to search_on_mtd tool
        huge_reader = MagicMock()
        huge_reader.markdown_exporter = [
            Document(
                page_content="A" * (MedSyntisAgent.MAX_PREFETCHED_MARKDOWN_CHARS + 100)
            )
        ]
        assert MedSyntisAgent._extract_prefetched_mtd_markdown(mtd=huge_reader) is None

        mock_create_agent.reset_mock()
        MedSyntisAgent(
            config=mock_conf,
            mtd=huge_reader,
            output_format=PatientMDTOncologicForm.TumorLocation,
        )
        fallback_prompt = mock_create_agent.call_args.kwargs["system_prompt"]
        fallback_tools = mock_create_agent.call_args.kwargs["tools"]
        assert "<untrusted_patient_record>" not in fallback_prompt
        assert search_on_mtd in fallback_tools
