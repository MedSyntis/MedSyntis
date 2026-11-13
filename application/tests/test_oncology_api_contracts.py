"""FastAPI contract tests for Oncology practice specialties and dynamic chat RAG."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

EXPECTED_ONCOLOGY_SPECIALTIES = {
    "digestive surgeon expert",
    "medical oncologist expert",
    "radiation oncologist expert",
    "radiologist expert",
    "gastroenterologist expert",
    "pathologist expert",
}

APP_API_PATH = Path(__file__).resolve().parents[1] / "app-api.py"


def _load_app():
    spec = importlib.util.spec_from_file_location("app_api_contracts", APP_API_PATH)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module.app


class TestOncologySpecialtyApiContracts:
    """Verify `/api/v1/agents`, `/api/v1/patientmdtform/schema`, and organ-scoped chat."""

    def test_agents_and_schema_expose_six_specialties_and_reject_legacy_names(
        self,
    ) -> None:
        app = _load_app()
        client = TestClient(app)

        r_list = client.get("/api/v1/agents?domain=oncology")
        assert r_list.status_code == 200
        by_name = {it["name"]: it for it in r_list.json()}

        for spec in EXPECTED_ONCOLOGY_SPECIALTIES:
            assert spec in by_name
            r_detail = client.get(f"/api/v1/agents/{spec}?domain=oncology")
            assert r_detail.status_code == 200
            assert r_detail.json()["name"] == spec

        for removed in (
            "pancreas expert",
            "oesophagus expert",
            "hepatocellular expert",
        ):
            assert removed not in by_name
            r_removed = client.get(f"/api/v1/agents/{removed}?domain=oncology")
            assert r_removed.status_code == 404

        r_schema = client.get("/api/v1/patientmdtform/schema?domain=oncology")
        assert r_schema.status_code == 200
        sections = {s["name"]: s for s in r_schema.json()["sections"]}
        assert set(sections["ExpertAnswer"]["agents"]) == EXPECTED_ONCOLOGY_SPECIALTIES
        assert len(sections["ExpertAnswer"]["agents"]) == 6

    def test_chat_endpoint_resolves_organ_scoped_tncd_resources(
        self, tmp_path: Path
    ) -> None:
        app = _load_app()
        pdf_name = "doc_0123456789abcdef.pdf"
        (tmp_path / pdf_name).write_bytes(b"%PDF-1.4\n%%EOF\n")

        fake_record_service = MagicMock()
        fake_record_service.mdt_form_repo.get_by_file.return_value = {
            "file": pdf_name,
            "TumorLocation": {"tumor_location": "Colon"},
        }
        from src.application.config import AppConfig
        from src.domain.oncology.patient_mdt_oncologic_form import (
            PatientMDTOncologicForm,
        )
        from src.routers import patientmdtform as router_mod
        from src.routers.dependencies import get_domain_config

        fake_record_service.form_cls = PatientMDTOncologicForm

        def _override_config():
            conf = AppConfig().for_domain("oncology")
            conf.rcp.path = str(tmp_path)
            return conf

        app.dependency_overrides[get_domain_config] = _override_config
        app.dependency_overrides[router_mod.get_record_service] = lambda: (
            fake_record_service
        )

        from src.domain.oncology.agents import Agents as OncologyAgents

        captured_ressources: list[list[str] | None] = []

        class _FakeAgent(OncologyAgents.Expert_model):
            def __init__(self, **kwargs):
                captured_ressources.append(kwargs.get("ressources"))

            def ask(self, _msg: str):
                resp = MagicMock()
                resp.response = "Réponse basée sur le dossier"
                return resp

        fake_agents = MagicMock()
        fake_agents.list = {"medical oncologist expert": _FakeAgent}

        try:
            with (
                patch.object(router_mod, "DocumentReader", MagicMock()),
                patch.object(router_mod, "get_domain_agents", return_value=fake_agents),
            ):
                client = TestClient(app)
                resp = client.post(
                    f"/api/v1/patientmdtform/{pdf_name}/chat?domain=oncology",
                    json={
                        "agent_name": "medical oncologist expert",
                        "message": "Quel bilan complémentaire ?",
                    },
                )
                assert resp.status_code == 200
                assert captured_ressources == [
                    ["TNCDCOLON.pdf", "TNCDCOLORECTALMETA.pdf"]
                ]
        finally:
            app.dependency_overrides.clear()

    def test_patient_record_chat_endpoint_resolves_latest_form_tncd_resources(
        self, tmp_path: Path
    ) -> None:
        app = _load_app()
        pdf_name = "doc_abcdef0123456789.pdf"
        (tmp_path / pdf_name).write_bytes(b"%PDF-1.4\n%%EOF\n")

        from src.application.config import AppConfig
        from src.domain.oncology.patient_mdt_oncologic_form import (
            PatientMDTOncologicForm,
        )
        from src.routers import patientmdtform as router_mod
        from src.routers.dependencies import get_db, get_domain_config

        fake_record_service = MagicMock()
        fake_record_service.form_cls = PatientMDTOncologicForm
        fake_record_service.get_patient_detail.return_value = {
            "patient": {"patient_id": "pat_123", "files": [pdf_name]},
            "rcps": [
                {
                    "file": pdf_name,
                    "processing_status": "COMPLETED",
                    "TumorLocation": {"tumor_location": "Pancreas"},
                }
            ],
        }

        def _override_config():
            conf = AppConfig().for_domain("oncology")
            conf.rcp.path = str(tmp_path)
            return conf

        app.dependency_overrides[get_domain_config] = _override_config
        app.dependency_overrides[get_db] = lambda: None
        app.dependency_overrides[router_mod.get_record_service] = lambda: (
            fake_record_service
        )

        from src.domain.oncology.agents import Agents as OncologyAgents

        captured_ressources: list[list[str] | None] = []

        class _FakeAgent(OncologyAgents.Expert_model):
            def __init__(self, **kwargs):
                captured_ressources.append(kwargs.get("ressources"))

            def ask(self, _msg: str):
                resp = MagicMock()
                resp.response = "Synthèse TNCD Pancréas"
                return resp

        fake_agents = MagicMock()
        fake_agents.list = {"digestive surgeon expert": _FakeAgent}

        fake_extraction_service = MagicMock()
        fake_extraction_service.build_patient_readers.return_value = [MagicMock()]

        try:
            with (
                patch.object(
                    router_mod,
                    "_build_extraction_service",
                    return_value=fake_extraction_service,
                ),
                patch.object(router_mod, "get_domain_agents", return_value=fake_agents),
            ):
                client = TestClient(app)
                resp = client.post(
                    "/api/v1/patientmdtform/patients/pat_123/chat?domain=oncology",
                    json={
                        "agent_name": "digestive surgeon expert",
                        "message": "Quelle stratégie chirurgicale ?",
                    },
                )
                assert resp.status_code == 200
                assert captured_ressources == [["TNCDPANCREAS.pdf"]]
        finally:
            app.dependency_overrides.clear()
