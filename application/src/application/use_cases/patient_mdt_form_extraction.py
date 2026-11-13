from concurrent.futures import ThreadPoolExecutor
import hashlib
import logging
import threading
import time
import uuid
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from src.application.agent.agent import MedSyntisAgent
from src.application.agent.collaborate import collaborative_debate
from src.application.app_functions import to_naive
from src.application.config import AppConfig
from src.application.reader import DocumentReader
from src.application.ressources import Ressources
from src.application.use_cases.patient_record import PatientRecordService
from src.domain.agents import Agents, get_domain_agents_cls
from src.domain.common.common_ressources import PatientPriority
from src.domain.patient import Patient
from src.domain.patient_mdt_form import (
    NonPatientMDTFormError,
    PatientMDTForm,
    get_domain_mdt_form_cls,
)
from src.domain.repositories import (
    DocumentCacheRepository,
    PatientMDTFormRepository,
    PatientRepository,
)
from src.domain.worker import JobType, RCPProcessingStatus
from src.infrastructure.documents.mongodb import Mongodb
from src.infrastructure.documents.repositories import (
    InMemoryDocumentCacheRepository,
    InMemoryPatientMDTFormRepository,
    InMemoryPatientRepository,
    MongoDocumentCacheRepository,
    MongoPatientMDTFormRepository,
    MongoPatientRepository,
)


def _serialize_dates(data: Any) -> Any:
    """
    Recursively normalize Pydantic models, `datetime`, `date`, and `Enum` objects
    into BSON/JSON-compatible primitives for persistence.
    """
    if isinstance(data, BaseModel):
        return _serialize_dates(data.model_dump())
    if isinstance(data, dict):
        return {str(k): _serialize_dates(v) for k, v in data.items()}
    if isinstance(data, (list, tuple, set)):
        return [_serialize_dates(i) for i in data]
    if isinstance(data, datetime):
        return to_naive(data)
    if isinstance(data, date):
        return data.isoformat()
    if isinstance(data, Enum):
        return data.value
    return data


class PatientMDTFormExtractionService:
    """
    Application use-case service orchestrating AI extraction of `PatientMDTForm` sections,
    `PatientMDTFormCheck` validation, synchronization with the `Patient` aggregate,
    and submission into the priority processing queue.

    Replaces the legacy `PatientMDTForm(DocumentReader)` inheritance with clean composition
    between the pure `PatientMDTForm` entity, the technical `DocumentReader`, and domain repositories.
    """

    def __init__(
        self,
        config: AppConfig,
        filename: str | None = None,
        form_cls: type[PatientMDTForm] | None = None,
        reader: DocumentReader | None = None,
        patient_repo: PatientRepository | None = None,
        mdt_form_repo: PatientMDTFormRepository | None = None,
        cache_repo: DocumentCacheRepository | None = None,
        patient_record_service: PatientRecordService | None = None,
        db_client: Mongodb | None = None,
    ) -> None:
        self.config = config
        self.logger = (
            config.set_logger(__name__)
            if hasattr(config, "set_logger")
            else logging.getLogger(__name__)
        )
        self.filename = filename or ""
        domain_val = config.domain
        self.form_cls = form_cls or get_domain_mdt_form_cls(
            domain_val if isinstance(domain_val, str) else None
        )
        self._reader = reader
        self._owns_db_client = False
        self._db_client = db_client
        self._resource_readers_cache: dict[str, DocumentReader] = {}
        self._resource_cache_lock = threading.Lock()
        self._form_lock = threading.Lock()
        self._available_resource_files: list[str] | None = None

        if mdt_form_repo is not None and (
            patient_record_service is not None or patient_repo is not None
        ):
            self.mdt_form_repo = mdt_form_repo
            self.cache_repo = cache_repo or InMemoryDocumentCacheRepository()
            self.patient_repo = patient_repo or (
                patient_record_service.patient_repo
                if patient_record_service is not None
                else InMemoryPatientRepository()
            )
            self.patient_record_service = (
                patient_record_service
                or PatientRecordService(
                    patient_repo=self.patient_repo,
                    mdt_form_repo=self.mdt_form_repo,
                    cache_repo=self.cache_repo,
                    mdt_form_storage_path=config.rcp.path,
                    form_cls=self.form_cls,
                    config=config,
                )
            )
        elif config.rcp.display_type == "mongodb":
            if self._db_client is None:
                self._db_client = Mongodb(config)
                self._owns_db_client = True
            self.mdt_form_repo = mdt_form_repo or MongoPatientMDTFormRepository(
                self._db_client
            )
            self.cache_repo = cache_repo or MongoDocumentCacheRepository(
                self._db_client
            )
            self.patient_repo = patient_repo or MongoPatientRepository(self._db_client)
            self.patient_record_service = (
                patient_record_service
                or PatientRecordService(
                    patient_repo=self.patient_repo,
                    mdt_form_repo=self.mdt_form_repo,
                    cache_repo=self.cache_repo,
                    mdt_form_storage_path=config.rcp.path,
                    form_cls=self.form_cls,
                    config=config,
                )
            )
        else:
            self.mdt_form_repo = mdt_form_repo or InMemoryPatientMDTFormRepository()
            self.cache_repo = cache_repo or InMemoryDocumentCacheRepository()
            self.patient_repo = patient_repo or InMemoryPatientRepository()
            self.patient_record_service = (
                patient_record_service
                or PatientRecordService(
                    patient_repo=self.patient_repo,
                    mdt_form_repo=self.mdt_form_repo,
                    cache_repo=self.cache_repo,
                    mdt_form_storage_path=config.rcp.path,
                    form_cls=self.form_cls,
                    config=config,
                )
            )

        existing_raw = (
            self.mdt_form_repo.get_by_file(self.filename) if self.filename else None
        )
        if existing_raw:
            self.form = self.form_cls.from_persistence(existing_raw)
        else:
            self.form = self.form_cls(file=self.filename)

    def close(self) -> None:
        """Close the owned database client if one was created internally."""
        if self._owns_db_client and self._db_client is not None:
            self._db_client.close()
            self._db_client = None

    def get_reader(self, filename: str | None = None) -> DocumentReader:
        """Return or lazily initialize the indexed `DocumentReader`."""
        target_file = filename or self.filename
        if self._reader is None or (
            target_file and getattr(self._reader, "document", None) != target_file
        ):
            self._reader = DocumentReader(self.config, target_file)
            self._reader.read_document()
        return self._reader

    # ------------------------------------------------------------------
    # Section Extraction (Single-Agent, Multi-Agent, Collaborative Debate)
    # ------------------------------------------------------------------

    def _get_available_resource_files(self) -> list[str]:
        """Cache domain guideline filenames for the lifetime of this extraction service."""
        with self._resource_cache_lock:
            if self._available_resource_files is None:
                self._available_resource_files = list(
                    Ressources.list_from_config(self.config) or []
                )
            return self._available_resource_files

    def _get_resource_readers(self, ressources: list[str]) -> list[DocumentReader]:
        """Reuse read-only DocumentReader instances across Wave 3 agents."""
        if not ressources:
            return []
        dbvec_type = getattr(getattr(self.config, "dbvec", None), "type", None)
        if not isinstance(dbvec_type, str) or not dbvec_type.strip():
            return []
        with self._resource_cache_lock:
            readers: list[DocumentReader] = []
            for ressource in ressources:
                reader = self._resource_readers_cache.get(ressource)
                if reader is None:
                    reader = DocumentReader(
                        self.config, ressource, document_type="ressource"
                    )
                    self._resource_readers_cache[ressource] = reader
                readers.append(reader)
            return readers

    @staticmethod
    def _clone_callbacks(callbacks: list[Any] | None) -> list[Any] | None:
        """Clone stateful thinking callbacks so parallel worker threads do not share buffers."""
        if not callbacks:
            return callbacks
        return [
            cb.clone_for_worker() if hasattr(cb, "clone_for_worker") else cb
            for cb in callbacks
        ]

    @staticmethod
    def _dump_section_dict(val: Any) -> dict[str, Any]:
        if isinstance(val, BaseModel):
            return val.model_dump()
        if isinstance(val, dict):
            return val
        return {}

    def _get_coordinator_agent_cls(self) -> type[MedSyntisAgent]:
        domain = getattr(self.config, "domain", None)
        if isinstance(domain, str) and domain.strip():
            return get_domain_agents_cls(domain).Coordinator_agent
        return Agents.Coordinator_agent

    def _build_mtd_completeness_context(
        self, target_form: PatientMDTForm
    ) -> tuple[str, bool, str | None, list[str]]:
        """Build deterministic Wave 1+2 and ExpertAnswer completeness context for MTDCompleted."""
        factual_models = list(self.form_cls.get_factual_clinical_models() or [])
        missing_sections: list[str] = []
        present_summaries: list[str] = []
        has_blocking_missing, blocking_reason = (
            self.form_cls.get_completeness_guardrail_flags(target_form)
        )

        for m_cls in factual_models:
            m_name = m_cls.__name__
            sec_data = self._dump_section_dict(target_form.sections.get(m_name))
            if not sec_data:
                missing_sections.append(m_name)
                continue
            non_null_keys = [
                k for k, v in sec_data.items() if v is not None and v != [] and v != ""
            ]
            present_summaries.append(
                f"- {m_name}: populated fields ({len(non_null_keys)}): {', '.join(non_null_keys[:10])}"
            )

        expert_ans = target_form.sections.get("ExpertAnswer")
        expert_lines: list[str] = []
        if isinstance(expert_ans, dict):
            for ag_name, ag_val in expert_ans.items():
                d = self._dump_section_dict(ag_val)
                if not d:
                    continue
                rel = bool(d.get("expert_relevant"))
                prio = d.get("patient_priority")
                why = str(d.get("why_relevant") or "").strip()
                expert_lines.append(
                    f"- {ag_name} (relevant={rel}, priority={prio}): {why[:400]}"
                )

        parts: list[str] = ["\n\n## DETERMINISTIC WAVE 1 & 2 COMPLETENESS CHECK"]
        if missing_sections:
            parts.append(f"- Missing factual sections: {', '.join(missing_sections)}")
        if has_blocking_missing and blocking_reason:
            parts.append(f"- CRITICAL: {blocking_reason}")
        if present_summaries:
            parts.append(
                "### Extracted Factual Sections\n" + "\n".join(present_summaries)
            )
        if expert_lines:
            parts.append("### ExpertAnswer Summary\n" + "\n".join(expert_lines))
        return (
            "\n".join(parts),
            has_blocking_missing,
            blocking_reason,
            missing_sections,
        )

    @staticmethod
    def _apply_mtd_completeness_guardrails(
        serialized_value: Any,
        has_blocking_missing: bool,
        blocking_reason: str | None,
        missing_factual_sections: list[str],
    ) -> Any:
        """Never mark an MDT file complete when blocking domain info or core factual sections are missing."""
        if not isinstance(serialized_value, dict):
            return serialized_value
        mtd_comp = serialized_value.get("mtd_complete")
        if not isinstance(mtd_comp, dict):
            return serialized_value
        if (has_blocking_missing or missing_factual_sections) and mtd_comp.get(
            "is_mtd_complete"
        ) is True:
            mtd_comp["is_mtd_complete"] = False if has_blocking_missing else "partial"
            what_missing = list(mtd_comp.get("what_missing") or [])
            if has_blocking_missing and blocking_reason and not what_missing:
                what_missing.append(blocking_reason)
            elif missing_factual_sections and not what_missing:
                what_missing.append(
                    f"Sections factuelles manquantes : {', '.join(missing_factual_sections)}"
                )
            mtd_comp["what_missing"] = what_missing
        return serialized_value

    def _extract_relevant_expert_opinions(
        self, expert_ans: Any
    ) -> tuple[dict[str, str], set[str], bool]:
        """Extract opinions, priority set, and urgent flag from relevant ExpertAnswer entries."""
        relevant_opinions: dict[str, str] = {}
        priorities: set[str] = set()
        has_urgent = False
        if not isinstance(expert_ans, dict):
            return relevant_opinions, priorities, has_urgent

        for ag_name, ag_val in expert_ans.items():
            d = self._dump_section_dict(ag_val)
            if not d or not d.get("expert_relevant"):
                continue
            prio = str(d.get("patient_priority") or "").strip().lower()
            if prio:
                priorities.add(prio)
                if (
                    prio == PatientPriority.urgent.value.lower()
                    or "high-priority" in prio
                    or ("urgent" in prio and "not urgent" not in prio)
                ):
                    has_urgent = True
            why = str(d.get("why_relevant") or "").strip()
            suggestions = d.get("suggestions") or []
            sugg_lines = []
            for s in suggestions:
                if isinstance(s, dict):
                    sugg_lines.append(
                        f"  - {s.get('suggestion', '')} ({s.get('why', '')})"
                    )
            opinion_parts = [f"Priority: {prio or 'unspecified'}", f"Rationale: {why}"]
            if sugg_lines:
                opinion_parts.append("Suggestions:\n" + "\n".join(sugg_lines))
            relevant_opinions[str(ag_name).strip()] = "\n".join(opinion_parts)

        return relevant_opinions, priorities, has_urgent

    def _should_run_care_debate(
        self,
        target_form: PatientMDTForm,
        relevant_opinions: dict[str, str],
        priorities: set[str],
    ) -> bool:
        """Route CareOrientationProposal to Debate Path only on divergence or clinical complexity."""
        if not relevant_opinions or len(priorities) > 1:
            return True
        return self.form_cls.should_run_care_orientation_debate(target_form)

    @staticmethod
    def _apply_care_orientation_guardrails(
        serialized_value: Any, has_urgent: bool
    ) -> Any:
        """Enforce urgent priority floor if any relevant specialist flagged urgent."""
        if has_urgent and isinstance(serialized_value, dict):
            serialized_value["care_adaptation_suggested"] = True
            serialized_value["suggested_priority"] = PatientPriority.urgent.value
        return serialized_value

    def extract_section(
        self,
        model_cls: type[BaseModel] | None = None,
        upsert: bool = False,
        callbacks: list | None = None,
        *,
        form: PatientMDTForm | None = None,
        reader: DocumentReader | None = None,
        clear_manual_flag: bool = False,
    ) -> Any:
        """
        Execute AI extraction for section `model_cls` on the `PatientMDTForm`,
        update `form` (or `self.form`), and optionally persist the result via `self.mdt_form_repo`.
        """
        if model_cls is None:
            raise ValueError("model_cls is required for extract_section")
        target_form = form if form is not None else self.form
        target_file = target_form.file or self.filename
        target_reader = (
            reader if reader is not None else self.get_reader(filename=target_file)
        )
        section_name = model_cls.__name__
        t_start = time.perf_counter()

        agents_list = list(getattr(model_cls, "agents", None) or [])
        is_collaborative = bool(getattr(model_cls, "collaborative", False))
        question = getattr(model_cls, "question", None)

        if section_name == "MTDCompleted" and agents_list:
            available_files = self._get_available_resource_files()
            mtd_ressources = self.form_cls.resolve_agent_ressources(
                target_form, agents_list[0], available_files
            )
            mtd_readers = self._get_resource_readers(mtd_ressources)
            (
                completeness_ctx,
                has_blocking_missing,
                blocking_reason,
                missing_factual_sections,
            ) = self._build_mtd_completeness_context(target_form)
            coordinator_cls = self._get_coordinator_agent_cls()
            coordinator = coordinator_cls(
                config=self.config,
                mtd=target_reader,
                output_format=model_cls,
                reasoning=False,
                ressources=[] if mtd_readers else mtd_ressources,
                additionnal_readers=mtd_readers if mtd_readers else None,
            )
            ans = coordinator.ask(
                f"{question or ''}{completeness_ctx}",
                callbacks=callbacks,
            )
            ans_dict = (
                ans.model_dump()
                if isinstance(ans, BaseModel)
                else (dict(ans) if isinstance(ans, dict) else {"value": ans})
            )
            serialized_value = self._apply_mtd_completeness_guardrails(
                _serialize_dates(ans_dict),
                has_blocking_missing=has_blocking_missing,
                blocking_reason=blocking_reason,
                missing_factual_sections=missing_factual_sections,
            )
        elif is_collaborative and len(agents_list) >= 1:
            debate_agents = list(agents_list)
            expert_ans = target_form.sections.get("ExpertAnswer")
            relevant_opinions, priorities, has_urgent = (
                self._extract_relevant_expert_opinions(expert_ans)
            )
            if relevant_opinions:
                relevant_names = set(relevant_opinions.keys())
                filtered = [
                    cls_ag
                    for cls_ag in debate_agents
                    if str(getattr(cls_ag, "agent_name", "")).strip() in relevant_names
                ]
                if filtered:
                    debate_agents = filtered

            use_seed = section_name == "CareOrientationProposal" and bool(
                relevant_opinions
            )
            skip_round2 = use_seed and not self._should_run_care_debate(
                target_form, relevant_opinions, priorities
            )

            available_files = self._get_available_resource_files()
            debate_ressources = self.form_cls.resolve_agent_ressources(
                target_form, debate_agents[0], available_files
            )
            debate_readers = self._get_resource_readers(debate_ressources)
            debate_res = collaborative_debate(
                agents_classes=debate_agents,
                question=question,
                output_format=model_cls,
                config=self.config,
                mtd=target_reader,
                logger=self.logger,
                callbacks=callbacks,
                ressources=debate_ressources,
                additionnal_readers=debate_readers if debate_readers else None,
                seed_opinions=relevant_opinions if use_seed else None,
                skip_round2=skip_round2,
            )
            serialized_value = _serialize_dates(
                debate_res.model_dump()
                if isinstance(debate_res, BaseModel)
                else debate_res
            )
            if section_name == "CareOrientationProposal":
                serialized_value = self._apply_care_orientation_guardrails(
                    serialized_value, has_urgent=has_urgent
                )
        elif len(agents_list) > 1:
            available_files = self._get_available_resource_files()
            multi_res: dict[str, Any] = {}

            def _run_expert_agent(agent_cls: Any) -> tuple[str, dict[str, Any]]:
                agent_ressources = self.form_cls.resolve_agent_ressources(
                    target_form, agent_cls, available_files
                )
                agent_readers = self._get_resource_readers(agent_ressources)
                agent = agent_cls(
                    config=self.config,
                    mtd=target_reader,
                    output_format=model_cls,
                    ressources=[] if agent_readers else agent_ressources,
                    additionnal_readers=agent_readers if agent_readers else None,
                )
                ans = agent.ask(question, callbacks=self._clone_callbacks(callbacks))
                ans_dict = (
                    ans.model_dump()
                    if isinstance(ans, BaseModel)
                    else (dict(ans) if isinstance(ans, dict) else {"value": ans})
                )
                if getattr(agent, "latest_thinking", ""):
                    ans_dict["reasoning_thinking"] = agent.latest_thinking
                key = getattr(agent, "agent_name", None) or agent_cls.__name__
                return key, _serialize_dates(ans_dict)

            max_workers = max(1, min(3, len(agents_list)))
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = [
                    pool.submit(_run_expert_agent, agent_cls)
                    for agent_cls in agents_list
                ]
                for fut in futures:
                    key, val = fut.result()
                    multi_res[key] = val
            serialized_value = multi_res
        elif len(agents_list) == 1:
            available_files = self._get_available_resource_files()
            agent_cls = agents_list[0]
            agent_ressources = self.form_cls.resolve_agent_ressources(
                target_form, agent_cls, available_files
            )
            agent_readers = self._get_resource_readers(agent_ressources)
            agent = agent_cls(
                config=self.config,
                mtd=target_reader,
                output_format=model_cls,
                ressources=[] if agent_readers else agent_ressources,
                additionnal_readers=agent_readers if agent_readers else None,
            )
            ans = agent.ask(question, callbacks=callbacks)
            ans_dict = (
                ans.model_dump()
                if isinstance(ans, BaseModel)
                else (dict(ans) if isinstance(ans, dict) else {"value": ans})
            )
            if getattr(agent, "latest_thinking", ""):
                ans_dict["reasoning_thinking"] = agent.latest_thinking
            serialized_value = _serialize_dates(ans_dict)
        else:
            raise ValueError(f"No agent defined on section model {section_name}")

        elapsed = round(time.perf_counter() - t_start, 2)
        with self._form_lock:
            target_form.set_section(
                section_name, serialized_value, elapsed_seconds=elapsed
            )
            if clear_manual_flag and section_name in target_form.manual_edits:
                target_form.manual_edits = (
                    self.form_cls.archive_manual_edit_before_ai_rerun(
                        target_form.manual_edits,
                        section_name,
                    )
                )

            if upsert and target_file:
                if section_name == "PatientAdministrative" and isinstance(
                    serialized_value, dict
                ):
                    patient, merged_admin = (
                        self.patient_record_service.synchronize_patient_from_admin(
                            filename=target_file,
                            admin_data=serialized_value,
                            target_patient_id=target_form.patient_id,
                        )
                    )
                    target_form.patient_id = patient.patient_id
                    target_form.set_section(
                        section_name, merged_admin, elapsed_seconds=elapsed
                    )
                    serialized_value = merged_admin

                upsert_fields_dict: dict[str, Any] = {
                    section_name: serialized_value,
                    "execution_times": dict(target_form.execution_times),
                    "date_refresh": target_form.date_refresh,
                }
                if section_name == "PatientAdministrative" and target_form.patient_id:
                    upsert_fields_dict["patient_id"] = target_form.patient_id
                if clear_manual_flag:
                    upsert_fields_dict["manual_edits"] = dict(target_form.manual_edits)

                self.mdt_form_repo.upsert_fields(
                    target_file,
                    fields=upsert_fields_dict,
                    set_on_insert={
                        "file": target_file,
                        "ui_date": target_form.ui_date,
                    },
                )

        return serialized_value

    # ------------------------------------------------------------------
    # PatientMDTForm Compliance Guardrail & Patient Identification (Wave 1)
    # ------------------------------------------------------------------

    def verify_is_patient_mdt_form(
        self,
        callbacks: list | None = None,
        *,
        form: PatientMDTForm | None = None,
        reader: DocumentReader | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Verify via `PatientMDTFormCheck` that the imported PDF is a valid `PatientMDTForm`.
        """
        target_form = form if form is not None else self.form
        raw_check = self.extract_section(
            form=target_form,
            reader=reader,
            model_cls=self.form_cls.PatientMDTFormCheck,
            upsert=False,
            callbacks=callbacks,
        )
        if isinstance(raw_check, BaseModel):
            check_dict = raw_check.model_dump()
        elif isinstance(raw_check, dict):
            check_dict = dict(raw_check)
        elif isinstance(target_form.sections.get("PatientMDTFormCheck"), dict):
            check_dict = dict(target_form.sections["PatientMDTFormCheck"])
        else:
            check_dict = {}

        is_valid = bool(check_dict.get("is_patient_mdt_form", True))
        target_form.set_section("PatientMDTFormCheck", check_dict)
        return is_valid, check_dict

    def reject_non_patient_mdt_form(
        self,
        check_result: dict[str, Any] | None = None,
        *,
        filename: str | None = None,
        reader: DocumentReader | None = None,
    ) -> None:
        """
        Clean up a rejected non-`PatientMDTForm` document (vector collection, cache, persistence, PDF)
        and raise `NonPatientMDTFormError`.
        """
        check_data = check_result or {}
        target_reader = reader if reader is not None else self._reader
        target_file = filename or (
            getattr(target_reader, "document", None) or self.filename
        )
        if target_reader is not None and hasattr(target_reader, "vecdb"):
            try:
                target_reader.vecdb.delete_collection()
            except Exception:
                pass

        if target_file:
            self.patient_record_service.delete_patient_mdt_form_document(
                target_file,
                delete_file=True,
                delete_queue_jobs=False,
                delete_vector_collection=(target_reader is None),
            )

        raise NonPatientMDTFormError(
            filename=target_file,
            detected_document_type=str(
                check_data.get("detected_document_type") or "Document non-RCP"
            ),
            justification=str(
                check_data.get("justification")
                or "Ce document ne correspond pas à une fiche de réunion de concertation pluridisciplinaire."
            ),
        )

    def process_patient_association(
        self,
        target_patient_id: str | None = None,
        run_admin_ai: bool = True,
        verify_patient_mdt_form: bool = False,
        callbacks: list | None = None,
        *,
        form: PatientMDTForm | None = None,
        reader: DocumentReader | None = None,
    ) -> Patient:
        """
        Execute Wave 1 (Patient Identification):
        1. Optionally verify that the document is a valid `PatientMDTForm`.
        2. Extract `PatientAdministrative` via the administrative agent.
        3. Synchronize the `Patient` aggregate and persist the `patient_id` <-> `filename` association.
        """
        target_form = form if form is not None else self.form
        target_file = target_form.file or self.filename

        if verify_patient_mdt_form:
            is_valid, check_dict = self.verify_is_patient_mdt_form(
                callbacks=callbacks,
                form=target_form,
                reader=reader,
            )
            if not is_valid:
                self.reject_non_patient_mdt_form(
                    check_dict,
                    filename=target_file,
                    reader=reader,
                )

        admin_raw = target_form.get_section("PatientAdministrative")
        if run_admin_ai and not admin_raw:
            admin_raw = self.extract_section(
                form=target_form,
                reader=reader,
                model_cls=self.form_cls.PatientAdministrative,
                upsert=False,
                callbacks=callbacks,
            )
            if admin_raw is None:
                admin_raw = target_form.get_section("PatientAdministrative")

        if isinstance(admin_raw, BaseModel):
            admin_dict = _serialize_dates(admin_raw.model_dump())
        elif isinstance(admin_raw, dict):
            admin_dict = _serialize_dates(dict(admin_raw))
        else:
            admin_dict = {}

        effective_target_pid = target_patient_id or target_form.patient_id
        patient, merged_admin = (
            self.patient_record_service.synchronize_patient_from_admin(
                filename=target_file,
                admin_data=admin_dict,
                target_patient_id=effective_target_pid,
            )
        )
        target_form.patient_id = patient.patient_id
        target_form.set_section("PatientAdministrative", merged_admin)

        upsert_payload: dict[str, Any] = {
            "patient_id": patient.patient_id,
            "PatientAdministrative": merged_admin,
            "execution_times": dict(target_form.execution_times),
            "date_refresh": target_form.date_refresh,
        }
        if "PatientMDTFormCheck" in target_form.sections:
            chk = target_form.sections["PatientMDTFormCheck"]
            upsert_payload["PatientMDTFormCheck"] = (
                chk.model_dump() if isinstance(chk, BaseModel) else chk
            )

        if target_file:
            self.mdt_form_repo.upsert_fields(
                target_file,
                fields=upsert_payload,
                set_on_insert={
                    "file": target_file,
                    "ui_date": target_form.ui_date,
                },
            )
        return patient

    def extract_all_sections(
        self,
        filename: str | None = None,
        replace: bool = True,
        unload_models: bool = True,
        callbacks: list | None = None,
        *,
        preserve_manual_edits: bool = True,
    ) -> PatientMDTForm:
        """Execute full extraction across all sections of the `PatientMDTForm`."""
        target_fname = filename or self.filename
        if target_fname:
            self.filename = target_fname
            existing_raw = self.mdt_form_repo.get_by_file(target_fname)
            if existing_raw:
                self.form = self.form_cls.from_persistence(existing_raw)

        try:
            admin_manually_edited = (
                preserve_manual_edits
                and self.form_cls.is_section_manually_edited(
                    self.form, "PatientAdministrative"
                )
                and "PatientAdministrative" in self.form.sections
            )
            if (
                replace or "PatientAdministrative" not in self.form.sections
            ) and not admin_manually_edited:
                self.process_patient_association(
                    target_patient_id=self.form.patient_id,
                    run_admin_ai=True,
                    verify_patient_mdt_form=False,
                    callbacks=callbacks,
                )

            for model_cls in self.form_cls.get_clinical_models():
                sec_name = model_cls.__name__
                if not replace and sec_name in self.form.sections:
                    continue
                if (
                    preserve_manual_edits
                    and self.form_cls.is_section_manually_edited(self.form, sec_name)
                    and sec_name in self.form.sections
                ):
                    continue
                self.extract_section(
                    model_cls=model_cls,
                    upsert=True,
                    callbacks=callbacks,
                    clear_manual_flag=(not preserve_manual_edits),
                )

            return self.form
        finally:
            if unload_models:
                try:
                    from src.application.app_functions.llm import (
                        unload_active_models,
                    )

                    unload_active_models(self.config)
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Orchestration Methods (Upload, Queue, Patient Record Readers)
    # ------------------------------------------------------------------

    def resolve_upload(
        self,
        file_bytes: bytes,
        original_filename: str,
    ) -> tuple[str, bool]:
        """
        Compute the SHA-256 digest of the uploaded PDF, generate an opaque storage filename
        `doc_<sha256[:16]>.pdf` (zero PII in filesystem/URLs/Milvus collections), and detect
        whether an already-completed `doc_<sha256[:16]>.pdf` record exists.
        """
        _ = original_filename
        full_digest = hashlib.sha256(file_bytes).hexdigest()
        resolved_filename = f"doc_{full_digest[:16]}.pdf"

        target_path = Path(self.config.rcp.path) / resolved_filename
        doc = self.mdt_form_repo.get_by_file(resolved_filename)
        is_completed = (
            doc is not None
            and doc.get("processing_status") == RCPProcessingStatus.COMPLETED.value
        )
        if target_path.exists() and is_completed:
            return resolved_filename, True

        return resolved_filename, False

    def ingest_and_associate(
        self,
        filename: str,
        patient_id: str | None = None,
        run_admin_ai: bool = True,
        verify_patient_mdt_form: bool = True,
        unload_models: bool = True,
        callbacks: list | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """
        Index a newly uploaded `PatientMDTForm` PDF, verify its compliance, and associate
        it with its `Patient` record.
        """
        self.filename = filename
        self.form = self.form_cls(file=filename)
        self._reader = None
        try:
            patient = self.process_patient_association(
                target_patient_id=patient_id,
                run_admin_ai=run_admin_ai,
                verify_patient_mdt_form=verify_patient_mdt_form,
                callbacks=callbacks,
            )
            return self.form.to_persistence(), patient.to_persistence()
        finally:
            if unload_models:
                try:
                    from src.application.app_functions.llm import (
                        unload_active_models,
                    )

                    unload_active_models(self.config)
                except Exception:
                    pass

    def enqueue_batch(
        self,
        files_payload: list[dict[str, Any]],
        run_full_ai: bool = True,
        batch_id: str | None = None,
    ) -> dict[str, Any]:
        """Enqueue a batch of `PatientMDTForm` files into the priority processing queue."""
        from src.infrastructure.queue import QueueBroker

        clinical_count = max(1, len(self.form_cls.get_factual_clinical_models()))
        expert_count = max(1, len(self.form_cls.get_expert_models()))
        resolved_batch_id = (batch_id or "").strip() or f"batch_{uuid.uuid4().hex[:10]}"

        broker = QueueBroker(self.config)
        try:
            results: list[dict[str, Any]] = []
            enqueued_count = 0
            already_queued_count = 0
            for item in files_payload:
                fname = item["filename"]
                orig_name = item.get("original_filename")
                if orig_name:
                    self.mdt_form_repo.upsert_fields(
                        fname,
                        {"original_filename": str(orig_name)},
                        set_on_insert={"file": fname, "ui_date": datetime.now()},
                    )
                target_pid = item.get("patient_id")
                res = broker.enqueue_import_file(
                    filename=fname,
                    target_patient_id=target_pid,
                    batch_id=resolved_batch_id,
                    include_clinical=run_full_ai,
                    total_clinical_models=clinical_count,
                    total_expert_models=expert_count,
                )
                results.append(res)
                if res.get("already_queued"):
                    already_queued_count += 1
                else:
                    enqueued_count += 1
            return {
                "batch_id": resolved_batch_id,
                "enqueued_count": enqueued_count,
                "already_queued_count": already_queued_count,
                "results": results,
            }
        finally:
            broker.close()

    def get_batch_status(
        self,
        batch_id: str,
        queue_broker: Any | None = None,
    ) -> dict[str, Any]:
        """Return per-file processing status and progress for a given `batch_id`."""
        from src.infrastructure.queue import QueueBroker

        own_broker = queue_broker is None
        broker = queue_broker if queue_broker is not None else QueueBroker(self.config)
        try:
            batch_jobs = broker.get_queue_jobs(batch_id=batch_id, limit=500)
        finally:
            if own_broker and hasattr(broker, "close"):
                broker.close()

        def _job_created_ts(job: dict[str, Any]) -> float:
            val = job.get("created_at")
            if isinstance(val, datetime):
                return val.timestamp()
            if isinstance(val, (int, float)):
                return float(val)
            if isinstance(val, str):
                try:
                    return float(val)
                except ValueError:
                    try:
                        return datetime.fromisoformat(val).timestamp()
                    except ValueError:
                        return 0.0
            return 0.0

        tracked_files: list[str] = []
        seen_files: set[str] = set()
        for j in sorted(batch_jobs, key=_job_created_ts):
            fname = j.get("filename")
            if fname and fname not in seen_files:
                seen_files.add(fname)
                tracked_files.append(fname)

        rcp_docs: dict[str, dict[str, Any]] = {}
        if tracked_files:
            for d in self.mdt_form_repo.list_by_files(tracked_files):
                if "file" in d:
                    rcp_docs[d["file"]] = d

        patients_by_id: dict[str, Patient] = {
            p.patient_id: p for p in self.patient_repo.list_all()
        }

        files_out: list[dict[str, Any]] = []
        for fname in tracked_files:
            doc = rcp_docs.get(fname, {})
            file_jobs = [j for j in batch_jobs if j.get("filename") == fname]

            processing_status = doc.get("processing_status")
            step = doc.get("processing_step")
            raw_pct = doc.get("processing_progress_pct")
            pct = float(raw_pct) if raw_pct is not None else 0.0
            error = doc.get("processing_error")

            def _is_running_job(st: Any) -> bool:
                if not isinstance(st, str):
                    return False
                up = st.strip().upper()
                return up in ("RUNNING", "PROCESSING") or up.startswith("PROCESSING_")

            def _is_active_job(st: Any) -> bool:
                if not isinstance(st, str):
                    return False
                up = st.strip().upper()
                return (
                    _is_running_job(up) or up == "PENDING" or up.startswith("PENDING_")
                )

            active_jobs = [j for j in file_jobs if _is_active_job(j.get("status"))]
            failed_jobs = [j for j in file_jobs if j.get("status") == "FAILED"]

            if active_jobs:
                running_job = next(
                    (j for j in active_jobs if _is_running_job(j.get("status"))),
                    active_jobs[0],
                )
                if not processing_status:
                    processing_status = running_job.get("status")
                if not step:
                    step = running_job.get("current_step") or running_job.get(
                        "step_label"
                    )
                pct = max(pct, float(running_job.get("progress_pct") or 0.0))
            elif failed_jobs and not processing_status:
                processing_status = "FAILED"
                if not error:
                    error = failed_jobs[0].get("error_message") or failed_jobs[0].get(
                        "error"
                    )
            elif not processing_status and file_jobs:
                if all(j.get("status") == "COMPLETED" for j in file_jobs):
                    processing_status = RCPProcessingStatus.COMPLETED.value
                    pct = 100.0
                else:
                    processing_status = file_jobs[0].get("status")

            if processing_status == RCPProcessingStatus.COMPLETED.value:
                pct = 100.0

            patient_id = doc.get("patient_id")
            patient_label: str | None = None
            if patient_id and patient_id in patients_by_id:
                patient_label = patients_by_id[patient_id].display_label
            elif isinstance(doc.get("PatientAdministrative"), dict):
                admin = doc["PatientAdministrative"]
                if admin.get("first_name") or admin.get("last_name"):
                    patient_label = Patient.from_administrative(
                        admin, filename=fname, patient_id=patient_id
                    ).display_label

            files_out.append(
                {
                    "filename": fname,
                    "processing_status": processing_status,
                    "step": step,
                    "pct": round(pct, 1),
                    "patient_id": patient_id,
                    "patient_label": patient_label,
                    "error": error,
                }
            )

        overall_pct = (
            round(sum(f["pct"] for f in files_out) / len(files_out), 1)
            if files_out
            else 0.0
        )
        return {
            "batch_id": batch_id,
            "overall_pct": overall_pct,
            "files": files_out,
        }

    def get_form_status(
        self,
        filename: str,
        queue_broker: Any | None = None,
    ) -> dict[str, Any] | None:
        """Return lightweight processing status fields for a single `PatientMDTForm` `filename`."""
        doc = self.mdt_form_repo.get_by_file(filename)
        if doc is not None:
            status_val = doc.get("processing_status")
            raw_pct = doc.get("processing_progress_pct")
            if raw_pct is None and status_val == RCPProcessingStatus.COMPLETED.value:
                pct_val = 100.0
            elif raw_pct is not None:
                pct_val = float(raw_pct)
            else:
                pct_val = 0.0
            return {
                "filename": filename,
                "processing_status": status_val,
                "processing_step": doc.get("processing_step"),
                "processing_progress_pct": pct_val,
                "processing_error": doc.get("processing_error"),
                "patient_id": doc.get("patient_id"),
            }

        from src.infrastructure.queue import QueueBroker

        own_broker = queue_broker is None
        broker = queue_broker if queue_broker is not None else QueueBroker(self.config)
        try:
            file_jobs = broker.get_queue_jobs(filename=filename, limit=20)
        except Exception:
            file_jobs = []
        finally:
            if own_broker and hasattr(broker, "close"):
                broker.close()

        if not file_jobs:
            return None

        top_job = file_jobs[0]
        return {
            "filename": filename,
            "processing_status": top_job.get("status"),
            "processing_step": top_job.get("current_step") or top_job.get("step_label"),
            "processing_progress_pct": float(top_job.get("progress_pct") or 0.0),
            "processing_error": top_job.get("error_message") or top_job.get("error"),
            "patient_id": top_job.get("target_patient_id"),
        }

    def enqueue_rerun(
        self,
        filename: str,
        model_name: str | None = None,
        *,
        preserve_manual_edits: bool = True,
    ) -> dict[str, Any]:
        """Enqueue a full `PatientMDTForm` rerun or a single-section rerun into the processing queue."""
        from src.infrastructure.queue import QueueBroker

        clinical_count = max(1, len(self.form_cls.get_factual_clinical_models()))
        expert_count = max(1, len(self.form_cls.get_expert_models()))

        broker = QueueBroker(self.config)
        try:
            return broker.enqueue_rcp_rerun(
                filename=filename,
                model_name=model_name,
                total_clinical_models=clinical_count,
                total_expert_models=expert_count,
                preserve_manual_edits=preserve_manual_edits,
            )
        finally:
            broker.close()

    def get_active_jobs_state(self, filename: str) -> dict[str, Any]:
        """Return a summary of active queue jobs for a given `PatientMDTForm` `filename`."""
        from src.infrastructure.queue import QueueBroker

        broker = QueueBroker(self.config)
        try:
            active_jobs = broker.get_active_jobs_for_file(filename)
        finally:
            broker.close()

        has_full = any(
            j.get("job_type")
            in (
                JobType.WAVE1_ADMIN.value,
                JobType.WAVE2_CLINICAL.value,
                JobType.WAVE3_EXPERTS.value,
            )
            for j in active_jobs
        )
        active_models = [
            j["model_name"]
            for j in active_jobs
            if j.get("job_type") == JobType.SINGLE_MODEL.value and j.get("model_name")
        ]
        current_step = active_jobs[0].get("current_step") if active_jobs else None
        return {
            "has_any_job": len(active_jobs) > 0,
            "has_full_job": has_full,
            "active_models": active_models,
            "current_step": current_step,
            "jobs": active_jobs,
        }

    def build_patient_readers(
        self,
        filenames: list[str],
        preload_documents: bool = False,
    ) -> list[DocumentReader]:
        """
        Build the list of `DocumentReader` instances for a `PatientRecord` multi-document chat,
        attaching `.sections` on each reader for the `get_patient_ai_history` tool.
        Documents are loaded lazily on tool invocation unless `preload_documents=True`.
        """
        docs_by_file: dict[str, dict[str, Any]] = {}
        for d in self.mdt_form_repo.list_by_files(filenames):
            if "file" in d:
                docs_by_file[d["file"]] = d

        readers: list[DocumentReader] = []
        for fname in filenames:
            reader = DocumentReader(self.config, fname)
            if preload_documents:
                reader.read_document()
            reader.sections = docs_by_file.get(fname, {"file": fname})  # type: ignore[attr-defined]
            readers.append(reader)
        return readers
