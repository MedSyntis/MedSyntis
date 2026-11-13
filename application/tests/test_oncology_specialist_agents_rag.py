"""Unit tests for Oncology practice-specialty agents, dynamic TNCD resource selection, and migration."""

from __future__ import annotations

import inspect
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

from langchain_core.documents import Document

from scripts.migrate import _migrate_expert_dict_keys
from src.application.agent.collaborate import (
    _build_debate_checkpoint_key,
    clear_debate_checkpoint_cache,
    collaborative_debate,
)
from src.application.reader import DocumentReader
from src.application.use_cases.patient_mdt_form_extraction import (
    PatientMDTFormExtractionService,
)
from src.domain.common.common_ressources import PrimaryOrganEnum
from src.domain.oncology.agents import (
    DEFAULT_TNCD_RESOURCES,
    TNCD_BY_ORGAN,
    Agents as OncologyAgents,
    resolve_oncology_resources,
)
from src.domain.oncology.patient_mdt_oncologic_form import PatientMDTOncologicForm
from src.domain.sma.agents import Agents as SmaAgents
from src.domain.sma.patient_mdt_sma_form import PatientMDTSmaForm
from src.infrastructure.documents.repositories import (
    InMemoryDocumentCacheRepository,
    InMemoryPatientMDTFormRepository,
    InMemoryPatientRepository,
)


class TestOncologySpecialistAgentsAndDynamicResources:
    """Verify the 6 specialty personas, dynamic TNCD resource resolver, and KV-cache prefix invariance."""

    def test_six_anonymous_practice_specialty_agents(self) -> None:
        agents_obj = OncologyAgents()
        names = {ag.agent_name for ag in agents_obj.expert_agents}
        assert names == {
            "digestive surgeon expert",
            "medical oncologist expert",
            "radiation oncologist expert",
            "radiologist expert",
            "gastroenterologist expert",
            "pathologist expert",
        }
        assert len(agents_obj.expert_agents) == 6

        for ag_cls in agents_obj.expert_agents:
            prompt = ag_cls.get_system_prompt()
            assert OncologyAgents.Expert_model.system_prompt == ""
            assert "Dr." not in prompt
            assert "Prof." not in prompt

    def test_resolve_oncology_resources_by_organ(self) -> None:
        docs_dir = (
            Path(__file__).resolve().parents[1]
            / "ressources"
            / "documents"
            / "oncology"
        )
        assert DEFAULT_TNCD_RESOURCES == ()
        all_tncd_pdfs = {pdf for pdfs in TNCD_BY_ORGAN.values() for pdf in pdfs}
        assert len(all_tncd_pdfs) == 8
        for pdf_name in all_tncd_pdfs:
            pdf_path = docs_dir / pdf_name
            assert pdf_path.is_file(), f"Missing bundled TNCD file: {pdf_name}"
            with pdf_path.open("rb") as fh:
                assert fh.read(5) == b"%PDF-"

        assert (
            PatientMDTOncologicForm.TumorLocation.model_validate(
                {"tumor_location": "pancreas"}
            ).tumor_location
            == PrimaryOrganEnum.pancreas
        )

        assert resolve_oncology_resources("oesophagus") == ["TNCDOESOPHAGE.pdf"]
        assert resolve_oncology_resources(PrimaryOrganEnum.stomach) == [
            "TNCDESTOMAC.pdf"
        ]
        assert resolve_oncology_resources(PrimaryOrganEnum.colon) == [
            "TNCDCOLON.pdf",
            "TNCDCOLORECTALMETA.pdf",
        ]
        assert resolve_oncology_resources(PrimaryOrganEnum.rectum) == [
            "TNCDRECTUM.pdf",
            "TNCDCOLORECTALMETA.pdf",
        ]
        assert resolve_oncology_resources("Liver") == ["TNCDCHC.pdf"]
        assert resolve_oncology_resources(PrimaryOrganEnum.intra_hepatic_bile_duct) == [
            "TNCDVOIESBILIAIRES.pdf"
        ]
        assert resolve_oncology_resources(PrimaryOrganEnum.extra_hepatic_bile_duct) == [
            "TNCDVOIESBILIAIRES.pdf"
        ]
        assert resolve_oncology_resources(PrimaryOrganEnum.pancreas) == [
            "TNCDPANCREAS.pdf"
        ]
        assert resolve_oncology_resources(PrimaryOrganEnum.unknown) == []
        assert resolve_oncology_resources(None) == []
        assert resolve_oncology_resources("unrecognized") == []

    def test_polymorphic_resolve_agent_ressources_selects_tncd_and_protects_admin_agents(
        self,
    ) -> None:
        doc = {"TumorLocation": {"tumor_location": "Pancreas"}}
        assert PatientMDTOncologicForm.resolve_agent_ressources(
            doc, OncologyAgents.Digestive_surgeon_expert_agent
        ) == ["TNCDPANCREAS.pdf"]
        assert (
            PatientMDTOncologicForm.resolve_agent_ressources(
                doc, OncologyAgents.Administratives_agent
            )
            == []
        )
        assert (
            PatientMDTOncologicForm.resolve_agent_ressources(
                doc, OncologyAgents.Coordinator_agent
            )
            == []
        )
        assert (
            PatientMDTSmaForm.resolve_agent_ressources(
                {}, SmaAgents.Neurologist_expert_agent
            )
            == SmaAgents.Neurologist_expert_agent.ressources
        )

    @patch("src.application.agent.agent.get_llm_client")
    @patch("src.application.agent.agent.create_agent")
    @patch("src.application.agent.agent.DocumentReader")
    def test_kv_cache_prefix_invariance_tool_detachment_and_debug_log_redaction(
        self,
        mock_doc_reader_cls: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_llm_client: MagicMock,
    ) -> None:
        mock_config = MagicMock()
        mock_config.domain = "oncology"
        mock_config.language = "french"
        mock_config.llm.reasoning = False
        mock_config.logs.langchaindebug = False

        reader = MagicMock(spec=DocumentReader)
        reader.document = "doc_abcdef0123456789.pdf"
        sample_md = "## COMPTE-RENDU RCP\nAdénocarcinome pancréatique cT3N1M0."
        reader.markdown_exporter = [Document(page_content=sample_md)]

        OncologyAgents.Digestive_surgeon_expert_agent(
            config=mock_config,
            mtd=reader,
            output_format=PatientMDTOncologicForm.ExpertAnswer,
            ressources=["TNCDPANCREAS.pdf"],
        )
        OncologyAgents.Radiologist_expert_agent(
            config=mock_config,
            mtd=reader,
            output_format=PatientMDTOncologicForm.ExpertAnswer,
            ressources=[],
        )
        prompt_surg = mock_create_agent.call_args_list[0].kwargs["system_prompt"]
        prompt_rad = mock_create_agent.call_args_list[1].kwargs["system_prompt"]
        tools_surg = [
            t.name for t in mock_create_agent.call_args_list[0].kwargs["tools"]
        ]
        tools_rad = [
            t.name for t in mock_create_agent.call_args_list[1].kwargs["tools"]
        ]

        assert "search_on_ressources" in tools_surg
        assert "search_on_ressources" not in tools_rad
        assert "Call `search_on_ressources`" not in prompt_rad

        common_prefix = os.path.commonprefix([prompt_surg, prompt_rad])
        assert sample_md in common_prefix
        assert OncologyAgents.Digestive_surgeon_expert_agent.system_prompt == ""
        assert OncologyAgents.Radiologist_expert_agent.system_prompt == ""

        debug_calls = mock_config.set_logger.return_value.debug.call_args_list
        assert debug_calls
        for dbg in debug_calls:
            logged_str = " ".join(str(a) for a in dbg.args)
            assert "Adénocarcinome pancréatique" not in logged_str
            assert "REDACTED_PATIENT_RECORD" in logged_str


class TestExtractionDebateAndMigration:
    """Verify organ-scoped extraction, domain-agnostic debate checkpoint key, and direct legacy migration."""

    @patch("src.application.agent.agent.get_llm_client")
    @patch("src.application.agent.agent.create_agent")
    @patch("src.application.agent.agent.DocumentReader")
    def test_extract_section_passes_organ_scoped_resources(
        self,
        mock_doc_reader_cls: MagicMock,
        mock_create_agent: MagicMock,
        mock_get_llm_client: MagicMock,
    ) -> None:
        mock_conf = MagicMock()
        mock_conf.domain = "oncology"
        mock_conf.language = "french"
        mock_conf.rcp.path = "/tmp"
        mock_conf.rcp.display_type = "memory"
        mock_conf.llm.reasoning = False
        mock_conf.logs.langchaindebug = False

        fake_graph = MagicMock()
        fake_graph.invoke.return_value = {
            "structured_response": PatientMDTOncologicForm.ExpertAnswer(
                expert_relevant=True,
                why_relevant="Pertinent",
                sources_relevant=[],
                patient_priority="Patient must be treated as soon as possible",
                suggestions=[],
            ),
            "messages": [],
        }
        mock_create_agent.return_value = fake_graph

        mdt_repo = InMemoryPatientMDTFormRepository()
        fname = "doc_9988776655443322.pdf"
        mdt_repo.upsert_fields(
            fname,
            {
                "file": fname,
                "TumorLocation": {"tumor_location": "Pancreas"},
            },
        )

        reader = MagicMock(spec=DocumentReader)
        reader.document = fname
        reader.markdown_exporter = [
            Document(page_content="Dossier pancréas borderline")
        ]

        svc = PatientMDTFormExtractionService(
            config=mock_conf,
            filename=fname,
            form_cls=PatientMDTOncologicForm,
            reader=reader,
            patient_repo=InMemoryPatientRepository(),
            mdt_form_repo=mdt_repo,
            cache_repo=InMemoryDocumentCacheRepository(),
        )

        svc.extract_section(
            model_cls=PatientMDTOncologicForm.ExpertAnswer,
            upsert=True,
            reader=reader,
        )

        loaded_docs = [
            call.args[1]
            for call in mock_doc_reader_cls.call_args_list
            if len(call.args) >= 2
        ]
        assert set(loaded_docs) == {"TNCDPANCREAS.pdf"}

        mock_doc_reader_cls.reset_mock()
        svc.form.set_section("TumorLocation", {"tumor_location": "Colon"})
        svc.extract_section(
            model_cls=PatientMDTOncologicForm.ExpertAnswer,
            upsert=False,
            reader=reader,
        )
        loaded_colon_docs = {
            call.args[1]
            for call in mock_doc_reader_cls.call_args_list
            if len(call.args) >= 2
        }
        assert loaded_colon_docs == {"TNCDCOLON.pdf", "TNCDCOLORECTALMETA.pdf"}

        mock_doc_reader_cls.reset_mock()
        svc.form.set_section("TumorLocation", {"tumor_location": "unknown"})
        svc.extract_section(
            model_cls=PatientMDTOncologicForm.ExpertAnswer,
            upsert=False,
            reader=reader,
        )
        assert mock_doc_reader_cls.call_count == 0

    def test_collaborate_checkpoint_key_tracks_ressources_without_domain_leakage(
        self,
    ) -> None:
        assert (
            "tumor_location" not in inspect.signature(collaborative_debate).parameters
        )
        assert (
            "tumor_location"
            not in inspect.signature(_build_debate_checkpoint_key).parameters
        )

        clear_debate_checkpoint_cache()
        reader = MagicMock()
        reader.document = "doc_1234567890abcdef.pdf"
        reader.file_hash = "abc123"
        agents = OncologyAgents().expert_agents

        key_pancreas = _build_debate_checkpoint_key(
            mtd=reader,
            output_format=PatientMDTOncologicForm.CareOrientationProposal,
            question="Synthesize",
            agents_classes=agents,
            ressources=["TNCDPANCREAS.pdf"],
        )
        key_colon = _build_debate_checkpoint_key(
            mtd=reader,
            output_format=PatientMDTOncologicForm.CareOrientationProposal,
            question="Synthesize",
            agents_classes=agents,
            ressources=[],
        )
        assert key_pancreas is not None
        assert key_colon is not None
        assert key_pancreas != key_colon

    @patch("src.application.use_cases.patient_mdt_form_extraction.collaborative_debate")
    def test_care_orientation_proposal_filters_to_relevant_experts(
        self,
        mock_collab: MagicMock,
    ) -> None:
        mock_collab.return_value = {
            "care_adaptation_suggested": True,
            "suggested_priority": "Patient must be treated urgently",
            "proposed_care_type": "Chimiothérapie d'induction",
            "clinical_rationale": "Synthèse RCP",
        }
        mock_conf = MagicMock()
        mock_conf.domain = "oncology"
        mock_conf.rcp.path = "/tmp"
        mock_conf.rcp.display_type = "memory"

        fname = "doc_fedcba9876543210.pdf"
        mdt_repo = InMemoryPatientMDTFormRepository()
        mdt_repo.upsert_fields(
            fname,
            {
                "file": fname,
                "TumorLocation": {"tumor_location": "Pancreas"},
                "ExpertAnswer": {
                    "digestive surgeon expert": {"expert_relevant": True},
                    "medical oncologist expert": {"expert_relevant": True},
                    "radiation oncologist expert": {"expert_relevant": False},
                },
            },
        )
        reader = MagicMock(spec=DocumentReader)
        reader.document = fname

        svc = PatientMDTFormExtractionService(
            config=mock_conf,
            filename=fname,
            form_cls=PatientMDTOncologicForm,
            reader=reader,
            patient_repo=InMemoryPatientRepository(),
            mdt_form_repo=mdt_repo,
            cache_repo=InMemoryDocumentCacheRepository(),
        )
        svc.extract_section(
            model_cls=PatientMDTOncologicForm.CareOrientationProposal,
            upsert=False,
            reader=reader,
        )

        passed_agents = mock_collab.call_args.kwargs["agents_classes"]
        assert [ag.agent_name for ag in passed_agents] == [
            "digestive surgeon expert",
            "medical oncologist expert",
        ]
        assert mock_collab.call_args.kwargs["ressources"] == ["TNCDPANCREAS.pdf"]

    def test_migrate_expert_dict_keys_purges_irrelevant_organ_entries(self) -> None:
        legacy_map = {
            "pancreas expert": {
                "expert_relevant": True,
                "why_relevant": "Adénocarcinome pancréas",
            },
            "oesophagus expert": {
                "expert_relevant": False,
                "why_relevant": "Pas d'atteinte oesophagienne",
            },
            "anatomopathologie": {
                "expert_relevant": True,
                "why_relevant": "Biopsie EUS",
            },
        }
        migrated, changed = _migrate_expert_dict_keys(legacy_map)
        assert changed is True
        assert set(migrated.keys()) == {
            "digestive surgeon expert",
            "pathologist expert",
        }
        assert "gastroenterologist expert" not in migrated

    def test_collaborate_forwards_ressources_and_base_form_resolves_class_ressources(
        self,
    ) -> None:
        from src.domain.sma.agents import Agents as SmaAgents
        from src.domain.sma.patient_mdt_sma_form import PatientMDTSmaForm

        assert (
            PatientMDTSmaForm.resolve_agent_ressources(
                None, SmaAgents.Neurologist_expert_agent
            )
            == SmaAgents.Neurologist_expert_agent.ressources
        )

        captured_res: list[list[str] | None] = []

        class _StubExpert:
            agent_name = "digestive surgeon expert"
            expert_type = "digestive surgery"
            response_language = "french"

            def __init__(self, **kwargs):
                captured_res.append(kwargs.get("ressources"))

            def ask(self, *_args, **_kwargs):
                turn = MagicMock()
                turn.response = "Avis chirurgical"
                return turn

        class _StubCoordinator:
            agent_name = "MDT Coordinator"
            response_language = "french"
            latest_thinking = ""

            def __init__(self, **_kwargs):
                pass

            def ask(self, *_args, **_kwargs):
                out = MagicMock()
                out.model_dump_json.return_value = '{"care_adaptation_suggested": true, "suggested_priority": "Patient must be treated urgently", "proposed_care_type": "Chirurgie", "clinical_rationale": "OK"}'
                return out

        clear_debate_checkpoint_cache()
        reader = MagicMock()
        reader.document = "doc_9999999999999999.pdf"
        reader.file_hash = "h1"
        reader.markdown_exporter = []

        res = collaborative_debate(
            agents_classes=[_StubExpert],  # type: ignore[list-item]
            question="Synthesize",
            output_format=PatientMDTOncologicForm.CareOrientationProposal,
            config=MagicMock(domain="oncology"),
            mtd=reader,
            logger=MagicMock(),
            coordinator_agent_cls=_StubCoordinator,  # type: ignore[arg-type]
            ressources=["TNCDPANCREAS.pdf"],
        )
        assert captured_res == [["TNCDPANCREAS.pdf"]]
        assert res["care_adaptation_suggested"] is True
