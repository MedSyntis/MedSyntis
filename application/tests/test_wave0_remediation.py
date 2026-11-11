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


def test_resolve_upload_produces_opaque_filename_and_supports_legacy_duplicates(
    tmp_path,
):
    """resolve_upload must return doc_<sha256[:16]>.pdf with zero PII while honoring legacy <stem>_<hash10>.pdf duplicates."""
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

    fname, is_dup = extraction_service.resolve_upload(
        pdf_bytes, "DUPONT_Jean_1954_02_11_RCP.pdf"
    )
    assert is_dup is False
    assert fname == f"doc_{expected_digest16}.pdf"
    assert "dupont" not in fname.lower()
    assert "jean" not in fname.lower()
    assert "1954" not in fname

    # Backward compatibility: existing legacy <stem>_<hash10>.pdf already COMPLETED on disk is detected as duplicate
    legacy_bytes = b"%PDF-1.4 Legacy Indexed Patient File"
    legacy_hash10 = hashlib.sha256(legacy_bytes).hexdigest()[:10]
    legacy_name = f"fiche_rcp_{legacy_hash10}.pdf"
    (tmp_path / legacy_name).write_bytes(legacy_bytes)
    mdt_repo.upsert_fields(
        legacy_name, {"file": legacy_name, "processing_status": "COMPLETED"}
    )

    resolved_legacy, is_legacy_dup = extraction_service.resolve_upload(
        legacy_bytes, "fiche_rcp.pdf"
    )
    assert is_legacy_dup is True
    assert resolved_legacy == legacy_name


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

    assert (
        _resolve_resource_pdf_path(
            conf, "patient_secret.pdf", form_file="patient_secret.pdf"
        )
        is None
    )

    resp_patient = client.get(
        "/api/v1/resources/patient_secret.pdf/file?form_file=patient_secret.pdf"
    )
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
