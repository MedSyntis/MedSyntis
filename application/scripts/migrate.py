"""
Unified, idempotent MedSyntis migration script eliminating all legacy storage and schema formats.

Performs across all enabled clinical domains (without printing any patient PII to stdout):
1. Filesystem (`config.rcp.path`):
   - Deletes obsolete `*.bbox` sidecar files.
   - Renames legacy PDF filenames (`<stem>_<hash10>.pdf`, cleartext names, etc.) to opaque
     `doc_<sha256[:16]>.pdf` keys (deduplicating when the opaque file already exists).
2. MongoDB (`patients`, `rcp_info`, `document_cache`, `mdt_agendas`, `bug_reports`):
   - Migrates legacy cleartext `patient_id` slugs to SHA-256 pseudonymized IDs.
   - Rewrites PDF filename references (`file`, `files[]`, `entries[].filename`, `rcp_file`)
     to `doc_<sha256[:16]>.pdf` while preserving `original_filename` on `rcp_info`.
   - Migrates legacy section aliases (`Chemotherapy` -> `ChemotherapyTreament`,
     `RadiologicalExams` -> `RadiologicExams`, `PreviousSurgery` -> `PreviousCurativeSurgery`,
     `PlannedSurgery` -> `PlannedCurativeSurgery`) across sections, `manual_edits`,
     `manually_edited_sections`, and `execution_times`.
   - Isolates previously auto-merged unverified patients (`date_birth is None`) into canonical
     per-file provisional records (`Patient.build_id(..., fallback_file=f)`) and persists
     `identity_verification_required` explicitly on every `patients` document.
3. Vector Store (`Milvus`):
   - Renames legacy per-document collections (`utility.rename_collection`) to match the new
     opaque `doc_<sha256[:16]>.pdf` collection prefix without re-embedding.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import Any
import warnings

from slugify import slugify

# Ensure `application/` is on sys.path when invoked directly as `python scripts/migrate.py`
script_dir = os.path.dirname(os.path.abspath(__file__))
app_dir = os.path.abspath(os.path.join(script_dir, ".."))
if app_dir not in sys.path:
    sys.path.insert(0, app_dir)

from pymongo import MongoClient  # noqa: E402

from scripts.migrate_patient_ids import migrate_database_patient_ids  # noqa: E402
from src.application.config import AppConfig  # noqa: E402
from src.domain.oncology.agents import Agents as OncologyAgents  # noqa: E402
from src.domain.patient import Patient  # noqa: E402
from src.infrastructure.documents.mongodb import (  # noqa: E402
    _BSON_CODEC_OPTIONS,
    build_connection_string,
)
from src.infrastructure.vectorial.database import sanitize_collection_name  # noqa: E402

CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"

OPAQUE_PDF_RE = re.compile(r"^doc_[0-9a-f]{16}\.pdf$")

LEGACY_SECTION_ALIASES: dict[str, str] = {
    "Chemotherapy": "ChemotherapyTreament",
    "RadiologicalExams": "RadiologicExams",
    "PreviousSurgery": "PreviousCurativeSurgery",
    "PlannedSurgery": "PlannedCurativeSurgery",
}

LEGACY_ONCOLOGY_EXPERT_MAP: dict[str, str] = {
    "pancreas expert": "digestive surgeon expert",
    "oesophagus expert": "gastroenterologist expert",
    "hepatocellular expert": "medical oncologist expert",
    "radiotherapy": "radiation oncologist expert",
    "anatomopathologie": "pathologist expert",
}

LEGACY_ORGAN_EXPERT_KEYS: frozenset[str] = frozenset(
    {
        "pancreas expert",
        "oesophagus expert",
        "hepatocellular expert",
    }
)


def _migrate_expert_dict_keys(raw_map: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """
    Migrate deprecated organ-centric oncology expert keys to canonical practice-specialty keys,
    purging organ-specific non-relevant entries (`expert_relevant=False`) so another organ's
    negative opinion never pollutes a transverse practice specialty.
    """
    migrated: dict[str, Any] = {}
    changed = False
    for raw_key, val in raw_map.items():
        clean = str(raw_key).strip()
        low = clean.lower()
        target = LEGACY_ONCOLOGY_EXPERT_MAP.get(low)
        if target is not None:
            changed = True
            if (
                low in LEGACY_ORGAN_EXPERT_KEYS
                and isinstance(val, dict)
                and val.get("expert_relevant") is False
            ):
                continue
            if target not in migrated and target not in raw_map:
                migrated[target] = val
        else:
            migrated[raw_key] = val
    return migrated, changed


def is_opaque_pdf_filename(filename: str | None) -> bool:
    """Return True when `filename` matches the canonical `doc_<16hex>.pdf` format."""
    return bool(isinstance(filename, str) and OPAQUE_PDF_RE.match(filename.strip()))


def build_vector_collection_name(config: AppConfig, document_filename: str) -> str:
    """Compute the exact vector collection name used by `DocumentReader` for `document_filename`."""
    coll_prefix = sanitize_collection_name(slugify(document_filename, separator="_"))
    embedding_suffix = (
        config.llm.embeddings.replace("/", "_").replace(":", "_").replace("-", "_")
    )
    raw_coll_name = f"{coll_prefix}_{config.dbvec.collection}_{embedding_suffix}"
    return sanitize_collection_name(raw_coll_name)


def _fallback_opaque_filename(legacy_filename: str) -> str:
    """Deterministic opaque filename fallback when neither disk bytes nor OCR cache hash exist."""
    digest16 = hashlib.sha256(
        f"medsyntis:file:{legacy_filename.strip()}".encode("utf-8")
    ).hexdigest()[:16]
    return f"doc_{digest16}.pdf"


def migrate_filesystem_pdfs(
    rcp_path: str | Path,
    *,
    dry_run: bool = False,
) -> tuple[dict[str, str], dict[str, int]]:
    """
    Purge `*.bbox` sidecars and rename legacy PDF files in `rcp_path` to `doc_<sha256[:16]>.pdf`.

    Returns `(file_map, fs_stats)` where `file_map` maps `old_filename -> new_opaque_filename`.
    """
    stats = {
        "bbox_files_deleted": 0,
        "pdf_files_already_opaque": 0,
        "pdf_files_renamed": 0,
        "pdf_files_deduplicated": 0,
    }
    file_map: dict[str, str] = {}
    rcp_dir = Path(rcp_path)
    if not rcp_dir.exists() or not rcp_dir.is_dir():
        return file_map, stats

    for entry in sorted(rcp_dir.iterdir(), key=lambda p: p.name):
        if not entry.is_file():
            continue
        if entry.name.lower().endswith(".bbox"):
            stats["bbox_files_deleted"] += 1
            if not dry_run:
                entry.unlink(missing_ok=True)
            continue
        if not entry.name.lower().endswith(".pdf"):
            continue
        if is_opaque_pdf_filename(entry.name):
            stats["pdf_files_already_opaque"] += 1
            continue

        file_bytes = entry.read_bytes()
        digest16 = hashlib.sha256(file_bytes).hexdigest()[:16]
        new_name = f"doc_{digest16}.pdf"
        file_map[entry.name] = new_name

        target_path = rcp_dir / new_name
        if target_path.exists():
            stats["pdf_files_deduplicated"] += 1
            if not dry_run:
                entry.unlink(missing_ok=True)
        else:
            stats["pdf_files_renamed"] += 1
            if not dry_run:
                entry.rename(target_path)

    return file_map, stats


def migrate_milvus_collections(
    config: AppConfig,
    file_map: dict[str, str],
    *,
    dry_run: bool = False,
) -> dict[str, int]:
    """Rename or deduplicate per-document Milvus collections for migrated filenames."""
    stats = {
        "vector_collections_renamed": 0,
        "vector_collections_dropped_duplicate": 0,
    }
    if not file_map or config.dbvec.type.lower() != "milvus":
        return stats

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore")
        from pymilvus import connections, db, utility

    alias = f"medsyntis_migrate_{config.milvus.database}"
    connections.connect(
        alias=alias,
        host=config.milvus.host,
        port=config.milvus.port,
        token=config.milvus.token,
    )
    try:
        existing_dbs = db.list_database(using=alias)
        if config.milvus.database not in existing_dbs:
            return stats
        db.using_database(config.milvus.database, using=alias)

        for old_file, new_file in sorted(file_map.items()):
            old_coll = build_vector_collection_name(config, old_file)
            new_coll = build_vector_collection_name(config, new_file)
            if old_coll == new_coll:
                continue
            if not utility.has_collection(old_coll, using=alias):
                continue
            if utility.has_collection(new_coll, using=alias):
                stats["vector_collections_dropped_duplicate"] += 1
                if not dry_run:
                    utility.drop_collection(old_coll, using=alias)
            else:
                stats["vector_collections_renamed"] += 1
                if not dry_run:
                    utility.rename_collection(old_coll, new_coll, using=alias)
    finally:
        try:
            connections.disconnect(alias)
        except Exception:
            pass

    return stats


def _collect_missing_file_mappings(
    database: Any,
    file_map: dict[str, str],
) -> dict[str, str]:
    """Complete `file_map` for any legacy filenames in MongoDB whose PDFs were not on local disk."""
    resolved = dict(file_map)

    # 1. Prefer real SHA-256 hashes recorded in `document_cache`
    for cache_doc in list(database["document_cache"].find({})):
        c_file = cache_doc.get("file")
        c_hash = cache_doc.get("hash")
        if (
            isinstance(c_file, str)
            and c_file.strip()
            and not is_opaque_pdf_filename(c_file)
            and c_file not in resolved
            and isinstance(c_hash, str)
            and re.fullmatch(r"[0-9a-fA-F]{16,64}", c_hash.strip())
        ):
            resolved[c_file] = f"doc_{c_hash.strip()[:16].lower()}.pdf"

    # 2. Deterministic fallback for orphan filenames across collections
    orphan_candidates: list[str] = []
    for form_doc in list(database["rcp_info"].find({})):
        f_val = form_doc.get("file")
        if (
            isinstance(f_val, str)
            and f_val.strip()
            and not is_opaque_pdf_filename(f_val)
        ):
            orphan_candidates.append(f_val)
    for pat_doc in list(database["patients"].find({})):
        files = pat_doc.get("files")
        if isinstance(files, list):
            for f_val in files:
                if (
                    isinstance(f_val, str)
                    and f_val.strip()
                    and not is_opaque_pdf_filename(f_val)
                ):
                    orphan_candidates.append(f_val)
    for agenda_doc in list(database["mdt_agendas"].find({})):
        entries = agenda_doc.get("entries")
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    f_val = entry.get("filename")
                    if (
                        isinstance(f_val, str)
                        and f_val.strip()
                        and not is_opaque_pdf_filename(f_val)
                    ):
                        orphan_candidates.append(f_val)
    for bug_doc in list(database["bug_reports"].find({})):
        f_val = bug_doc.get("rcp_file")
        if (
            isinstance(f_val, str)
            and f_val.strip()
            and not is_opaque_pdf_filename(f_val)
        ):
            orphan_candidates.append(f_val)

    for cand in orphan_candidates:
        if cand not in resolved:
            resolved[cand] = _fallback_opaque_filename(cand)

    return resolved


def migrate_database_storage_and_schema(
    database: Any,
    *,
    file_map: dict[str, str] | None = None,
    dry_run: bool = False,
) -> tuple[dict[str, str], dict[str, int]]:
    """
    Migrate MongoDB collections (`patients`, `rcp_info`, `document_cache`, `mdt_agendas`, `bug_reports`)
    to canonical opaque filenames, canonical section names, and homonym-safe patient identities.
    """
    pid_stats = migrate_database_patient_ids(database, dry_run=dry_run)
    effective_map = _collect_missing_file_mappings(database, file_map or {})

    stats: dict[str, int] = {
        **pid_stats,
        "cache_docs_migrated": 0,
        "forms_file_migrated": 0,
        "forms_merged": 0,
        "forms_sections_migrated": 0,
        "forms_specialties_migrated": 0,
        "patients_files_migrated": 0,
        "unverified_patients_isolated": 0,
        "patients_flags_updated": 0,
        "agendas_files_migrated": 0,
        "agendas_specialties_migrated": 0,
        "bugs_files_migrated": 0,
    }

    # 1. `document_cache`: rewrite `file` to opaque filename
    cache_col = database["document_cache"]
    for cache_doc in list(cache_col.find({})):
        old_cfile = cache_doc.get("file")
        if not isinstance(old_cfile, str) or is_opaque_pdf_filename(old_cfile):
            continue
        new_cfile = effective_map.get(old_cfile)
        if new_cfile and new_cfile != old_cfile:
            if not dry_run:
                cache_col.update_one(
                    {"_id": cache_doc["_id"]},
                    {"$set": {"file": new_cfile}},
                )
            stats["cache_docs_migrated"] += 1

    # 2. `rcp_info`: rewrite `file` + `original_filename` + canonicalize legacy section aliases
    forms_col = database["rcp_info"]
    all_forms = list(forms_col.find({}))
    forms_by_file: dict[str, dict[str, Any]] = {
        str(d["file"]): d
        for d in all_forms
        if isinstance(d.get("file"), str) and is_opaque_pdf_filename(str(d.get("file")))
    }

    for form_doc in all_forms:
        old_file = form_doc.get("file")
        new_file = (
            effective_map.get(old_file, old_file)
            if isinstance(old_file, str)
            else old_file
        )
        set_fields: dict[str, Any] = {}
        unset_fields: dict[str, str] = {}
        section_migrated = False

        for legacy_sec, canonical_sec in LEGACY_SECTION_ALIASES.items():
            if legacy_sec in form_doc:
                if not form_doc.get(canonical_sec):
                    set_fields[canonical_sec] = form_doc[legacy_sec]
                unset_fields[legacy_sec] = ""
                section_migrated = True

        expert_ans = form_doc.get("ExpertAnswer")
        specialties_migrated = False
        if isinstance(expert_ans, dict):
            migrated_ea, ea_changed = _migrate_expert_dict_keys(expert_ans)
            if ea_changed:
                set_fields["ExpertAnswer"] = migrated_ea
                specialties_migrated = True

        manual_edits = form_doc.get("manual_edits")
        if isinstance(manual_edits, dict):
            updated_me = dict(manual_edits)
            me_changed = False
            for legacy_sec, canonical_sec in LEGACY_SECTION_ALIASES.items():
                if legacy_sec in updated_me:
                    if canonical_sec not in updated_me:
                        updated_me[canonical_sec] = updated_me[legacy_sec]
                    del updated_me[legacy_sec]
                    me_changed = True
            ea_trace = updated_me.get("ExpertAnswer")
            if isinstance(ea_trace, dict):
                trace_copy = dict(ea_trace)
                trace_changed = False
                for sub_k in ("human_value", "ai_original", "previous_ai_value"):
                    sub_v = trace_copy.get(sub_k)
                    if isinstance(sub_v, dict):
                        mig_sub, sub_changed = _migrate_expert_dict_keys(sub_v)
                        if sub_changed:
                            trace_copy[sub_k] = mig_sub
                            trace_changed = True
                archived_traces = trace_copy.get("archived_judge_traces")
                if isinstance(archived_traces, list) and archived_traces:
                    new_archived: list[Any] = []
                    arch_changed = False
                    for arch_item in archived_traces:
                        if not isinstance(arch_item, dict):
                            new_archived.append(arch_item)
                            continue
                        arch_copy = dict(arch_item)
                        for sub_k in ("human_value", "ai_original"):
                            sub_v = arch_copy.get(sub_k)
                            if isinstance(sub_v, dict):
                                mig_sub, sub_changed = _migrate_expert_dict_keys(sub_v)
                                if sub_changed:
                                    arch_copy[sub_k] = mig_sub
                                    arch_changed = True
                        new_archived.append(arch_copy)
                    if arch_changed:
                        trace_copy["archived_judge_traces"] = new_archived
                        trace_changed = True
                if trace_changed:
                    updated_me["ExpertAnswer"] = trace_copy
                    me_changed = True
                    specialties_migrated = True
            if me_changed:
                set_fields["manual_edits"] = updated_me
                section_migrated = True

        if specialties_migrated:
            stats["forms_specialties_migrated"] += 1

        edited_list = form_doc.get("manually_edited_sections")
        if isinstance(edited_list, list):
            new_edited: list[str] = []
            ed_changed = False
            for item in edited_list:
                if isinstance(item, str):
                    mapped_sec = LEGACY_SECTION_ALIASES.get(item, item)
                    if mapped_sec != item:
                        ed_changed = True
                    if mapped_sec not in new_edited:
                        new_edited.append(mapped_sec)
            if ed_changed:
                set_fields["manually_edited_sections"] = new_edited
                section_migrated = True

        exec_times = form_doc.get("execution_times")
        if isinstance(exec_times, dict):
            updated_et = dict(exec_times)
            et_changed = False
            for legacy_sec, canonical_sec in LEGACY_SECTION_ALIASES.items():
                if legacy_sec in updated_et:
                    if canonical_sec not in updated_et:
                        updated_et[canonical_sec] = updated_et[legacy_sec]
                    del updated_et[legacy_sec]
                    et_changed = True
            if et_changed:
                set_fields["execution_times"] = updated_et
                section_migrated = True

        if "bbox" in form_doc:
            unset_fields["bbox"] = ""
            section_migrated = True

        if section_migrated:
            stats["forms_sections_migrated"] += 1

        file_changed = (
            isinstance(old_file, str)
            and isinstance(new_file, str)
            and new_file != old_file
        )
        if file_changed and not form_doc.get("original_filename"):
            set_fields["original_filename"] = old_file

        if (
            file_changed
            and isinstance(new_file, str)
            and new_file in forms_by_file
            and forms_by_file[new_file].get("_id") != form_doc.get("_id")
        ):
            target_form = forms_by_file[new_file]
            merge_set: dict[str, Any] = {}
            if not target_form.get("original_filename") and (
                form_doc.get("original_filename") or old_file
            ):
                merge_set["original_filename"] = (
                    form_doc.get("original_filename") or old_file
                )
            if not dry_run:
                if merge_set:
                    forms_col.update_one(
                        {"_id": target_form["_id"]}, {"$set": merge_set}
                    )
                forms_col.delete_one({"_id": form_doc["_id"]})
            target_form.update(merge_set)
            stats["forms_merged"] += 1
            continue

        if file_changed and isinstance(new_file, str):
            set_fields["file"] = new_file
            stats["forms_file_migrated"] += 1

        if set_fields or unset_fields:
            if not dry_run:
                if unset_fields:
                    # Apply $set first, then $unset (compatible with both PyMongo and minimal test doubles)
                    if set_fields:
                        forms_col.update_one(
                            {"_id": form_doc["_id"]}, {"$set": set_fields}
                        )
                    forms_col.update_one(
                        {"_id": form_doc["_id"]}, {"$unset": unset_fields}
                    )
                else:
                    forms_col.update_one({"_id": form_doc["_id"]}, {"$set": set_fields})
            updated_copy = {k: v for k, v in form_doc.items() if k not in unset_fields}
            updated_copy.update(set_fields)
            if isinstance(new_file, str):
                forms_by_file[new_file] = updated_copy

    # 3. `patients`: rewrite `files[]`, isolate unverified homonym records, and persist `identity_verification_required`
    patients_col = database["patients"]
    all_patients = list(patients_col.find({}))
    existing_patients_by_id: dict[str, dict[str, Any]] = {
        str(d["patient_id"]): d
        for d in all_patients
        if isinstance(d.get("patient_id"), str) and d.get("patient_id")
    }
    file_to_new_pid: dict[str, str] = {}
    old_pid_to_default_pid: dict[str, str] = {}

    for pat_doc in all_patients:
        old_pid = str(pat_doc.get("patient_id") or "")
        if not old_pid:
            continue

        raw_files = (
            pat_doc.get("files") if isinstance(pat_doc.get("files"), list) else []
        )
        mapped_files: list[str] = []
        files_changed = False
        for f_item in raw_files:
            if isinstance(f_item, str) and f_item:
                mapped_f = effective_map.get(f_item, f_item)
                if mapped_f != f_item:
                    files_changed = True
                if mapped_f not in mapped_files:
                    mapped_files.append(mapped_f)
        if len(mapped_files) != len(raw_files):
            files_changed = True
        if files_changed:
            stats["patients_files_migrated"] += 1

        first_name = pat_doc.get("first_name")
        last_name = pat_doc.get("last_name")
        date_birth = pat_doc.get("date_birth")
        name_key = Patient.build_name_key(first_name=first_name, last_name=last_name)
        expected_verif_flag = date_birth is None or not name_key

        # Check if unverified patient has legacy homonym-unsafe ID or multiple merged files
        if date_birth is None and name_key:
            target_files = mapped_files if mapped_files else [None]
            expected_ids = [
                Patient.build_id(
                    first_name=first_name,
                    last_name=last_name,
                    date_birth=None,
                    fallback_file=f_entry,
                )
                for f_entry in target_files
            ]
            needs_isolation = len(expected_ids) > 1 or expected_ids[0] != old_pid
            if needs_isolation:
                for f_entry, target_pid in zip(target_files, expected_ids):
                    if f_entry:
                        file_to_new_pid[f_entry] = target_pid
                    old_pid_to_default_pid.setdefault(old_pid, target_pid)

                    new_pat_payload: dict[str, Any] = {
                        "patient_id": target_pid,
                        "name_key": name_key,
                        "identity_verification_required": True,
                        "first_name": first_name or "",
                        "last_name": last_name or "",
                        "born_name": pat_doc.get("born_name"),
                        "date_birth": None,
                        "gender": pat_doc.get("gender", "Not_given"),
                        "files": [f_entry] if f_entry else [],
                        "updated_at": datetime.now(),
                    }
                    if not dry_run:
                        existing_target = existing_patients_by_id.get(target_pid)
                        if existing_target is not None and existing_target.get(
                            "_id"
                        ) != pat_doc.get("_id"):
                            merged_f = list(existing_target.get("files") or [])
                            if f_entry and f_entry not in merged_f:
                                merged_f.append(f_entry)
                            patients_col.update_one(
                                {"_id": existing_target["_id"]},
                                {
                                    "$set": {
                                        "files": merged_f,
                                        "identity_verification_required": True,
                                        "updated_at": datetime.now(),
                                    }
                                },
                            )
                        else:
                            patients_col.insert_one(dict(new_pat_payload))
                    existing_patients_by_id[target_pid] = new_pat_payload

                if not dry_run:
                    patients_col.delete_one({"_id": pat_doc["_id"]})
                existing_patients_by_id.pop(old_pid, None)
                stats["unverified_patients_isolated"] += 1
                continue

        pat_updates: dict[str, Any] = {}
        if files_changed:
            pat_updates["files"] = mapped_files
        if pat_doc.get("identity_verification_required") is not expected_verif_flag:
            pat_updates["identity_verification_required"] = expected_verif_flag
            stats["patients_flags_updated"] += 1
        if pat_doc.get("name_key") != name_key:
            pat_updates["name_key"] = name_key

        if pat_updates:
            pat_updates["updated_at"] = datetime.now()
            if not dry_run:
                patients_col.update_one({"_id": pat_doc["_id"]}, {"$set": pat_updates})

    # Cascade isolated provisional `patient_id` updates onto `rcp_info`
    if file_to_new_pid or old_pid_to_default_pid:
        for form_doc in list(forms_col.find({})):
            f_name = form_doc.get("file")
            cur_pid = form_doc.get("patient_id")
            target_pid = (
                file_to_new_pid.get(str(f_name))
                if isinstance(f_name, str) and f_name in file_to_new_pid
                else (
                    old_pid_to_default_pid.get(str(cur_pid))
                    if isinstance(cur_pid, str)
                    else None
                )
            )
            if target_pid and target_pid != cur_pid:
                if not dry_run:
                    forms_col.update_one(
                        {"_id": form_doc["_id"]},
                        {"$set": {"patient_id": target_pid}},
                    )
                stats["forms_migrated"] += 1

    # 4. `mdt_agendas`: rewrite `attending_experts`, `entries[].filename`, and isolated `patient_id`s
    agendas_col = database["mdt_agendas"]
    canonical_onco_specialties = [
        ag.agent_name for ag in OncologyAgents().expert_agents
    ]
    canonical_onco_set = set(canonical_onco_specialties)
    for agenda_doc in list(agendas_col.find({})):
        agenda_updates: dict[str, Any] = {}
        ag_domain = str(agenda_doc.get("domain") or "").strip().lower()
        raw_attending = agenda_doc.get("attending_experts")
        if ag_domain == "oncology" and isinstance(raw_attending, list):
            has_non_canonical_exp = any(
                not isinstance(e, str) or e.strip() not in canonical_onco_set
                for e in raw_attending
            )
            if has_non_canonical_exp:
                kept = [
                    str(e).strip()
                    for e in raw_attending
                    if isinstance(e, str) and str(e).strip() in canonical_onco_set
                ]
                agenda_updates["attending_experts"] = (
                    list(dict.fromkeys(kept))
                    if len(kept) >= 3
                    else list(canonical_onco_specialties)
                )
                stats["agendas_specialties_migrated"] += 1

        entries = agenda_doc.get("entries")
        if isinstance(entries, list) and entries:
            changed = False
            new_entries: list[dict[str, Any]] = []
            seen_pids: set[str] = set()
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                entry_copy = dict(entry)
                ef_name = entry_copy.get("filename")
                if isinstance(ef_name, str) and ef_name in effective_map:
                    mapped_ef = effective_map[ef_name]
                    if mapped_ef != ef_name:
                        entry_copy["filename"] = mapped_ef
                        changed = True
                resolved_ef = entry_copy.get("filename")
                ep_id = entry_copy.get("patient_id")
                new_epid = (
                    file_to_new_pid.get(str(resolved_ef))
                    if isinstance(resolved_ef, str) and resolved_ef in file_to_new_pid
                    else (
                        old_pid_to_default_pid.get(str(ep_id))
                        if isinstance(ep_id, str)
                        else None
                    )
                )
                if new_epid and new_epid != ep_id:
                    entry_copy["patient_id"] = new_epid
                    changed = True
                final_pid = entry_copy.get("patient_id")
                if isinstance(final_pid, str) and final_pid:
                    if final_pid in seen_pids:
                        changed = True
                        continue
                    seen_pids.add(final_pid)
                new_entries.append(entry_copy)

            if changed:
                for idx, item in enumerate(new_entries):
                    item["manual_order"] = idx
                agenda_updates["entries"] = new_entries
                stats["agendas_files_migrated"] += 1

        if agenda_updates:
            agenda_updates["updated_at"] = datetime.now()
            if not dry_run:
                agendas_col.update_one(
                    {"_id": agenda_doc["_id"]},
                    {"$set": agenda_updates},
                )

    # 5. `bug_reports`: rewrite `rcp_file` and isolated `patient_id`s
    bugs_col = database["bug_reports"]
    for bug_doc in list(bugs_col.find({})):
        bug_set: dict[str, Any] = {}
        rcp_f = bug_doc.get("rcp_file")
        resolved_rcp_f = rcp_f
        if isinstance(rcp_f, str) and rcp_f in effective_map:
            mapped_rf = effective_map[rcp_f]
            if mapped_rf != rcp_f:
                bug_set["rcp_file"] = mapped_rf
                resolved_rcp_f = mapped_rf
        b_pid = bug_doc.get("patient_id")
        new_bpid = (
            file_to_new_pid.get(str(resolved_rcp_f))
            if isinstance(resolved_rcp_f, str) and resolved_rcp_f in file_to_new_pid
            else (
                old_pid_to_default_pid.get(str(b_pid))
                if isinstance(b_pid, str)
                else None
            )
        )
        if new_bpid and new_bpid != b_pid:
            bug_set["patient_id"] = new_bpid

        if bug_set:
            bug_set["updated_at"] = datetime.now()
            if not dry_run:
                bugs_col.update_one({"_id": bug_doc["_id"]}, {"$set": bug_set})
            stats["bugs_files_migrated"] += 1

    return effective_map, stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Migrate MedSyntis filesystem PDFs, MongoDB schemas/identities, and Milvus "
            "collections to canonical zero-legacy formats."
        )
    )
    parser.add_argument(
        "--domain",
        default=None,
        help="Optional domain to migrate (e.g., oncology, sma). Defaults to all enabled domains.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview all filesystem, MongoDB, and Milvus migrations without mutating state.",
    )
    parser.add_argument(
        "--skip-vectordb",
        action="store_true",
        help="Skip Milvus vector collection renaming.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit migration summary as JSON.",
    )
    args = parser.parse_args(argv)

    base_conf = AppConfig()
    base_conf.logs.level = "ERROR"

    target_domains = (
        [args.domain] if args.domain else list(base_conf.enabled_domains_list)
    )

    uri = build_connection_string(base_conf)
    client = MongoClient(uri, serverSelectionTimeoutMS=3000)
    try:
        client.admin.command("ping")
    except Exception as exc:
        client.close()
        print(
            f"{RED}Failed to connect to MongoDB ({base_conf.mongodb.host}:{base_conf.mongodb.port}): {exc}{RESET}\n"
            f"{YELLOW}Tip: start MongoDB first (e.g. 'make docker-up' locally or 'make start-prod' in production).{RESET}",
            file=sys.stderr,
        )
        return 1

    results_by_domain: dict[str, dict[str, int]] = {}
    vectordb_warnings: dict[str, str] = {}
    try:
        for dom in target_domains:
            dom_conf = base_conf.for_domain(dom)
            db_handle = client.get_database(
                dom_conf.mongodb.database,
                codec_options=_BSON_CODEC_OPTIONS,
            )
            fs_map, fs_stats = migrate_filesystem_pdfs(
                dom_conf.rcp.path,
                dry_run=args.dry_run,
            )
            effective_map, db_stats = migrate_database_storage_and_schema(
                db_handle,
                file_map=fs_map,
                dry_run=args.dry_run,
            )
            vec_stats = {
                "vector_collections_renamed": 0,
                "vector_collections_dropped_duplicate": 0,
            }
            if not args.skip_vectordb and effective_map:
                try:
                    vec_stats = migrate_milvus_collections(
                        dom_conf,
                        effective_map,
                        dry_run=args.dry_run,
                    )
                except Exception as vec_exc:
                    vectordb_warnings[dom] = type(vec_exc).__name__

            results_by_domain[dom] = {**fs_stats, **db_stats, **vec_stats}
    except ValueError as exc:
        print(f"{RED}{exc}{RESET}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"{RED}Migration failed: {exc}{RESET}", file=sys.stderr)
        return 1
    finally:
        client.close()

    if args.json:
        print(
            json.dumps(
                {
                    "dry_run": args.dry_run,
                    "domains": results_by_domain,
                    "vectordb_warnings": vectordb_warnings,
                },
                indent=2,
            )
        )
        return 0

    mode_banner = (
        f"{YELLOW}[DRY-RUN]{RESET} " if args.dry_run else f"{GREEN}[APPLIED]{RESET} "
    )
    print(
        f"{BOLD}{CYAN}=== MedSyntis Canonical Storage & Schema Migration ==={RESET} {mode_banner}"
    )
    for dom, counts in results_by_domain.items():
        print(
            f"  • {BOLD}{dom}{RESET}: "
            f"pdfs_renamed={GREEN}{counts['pdf_files_renamed']}{RESET} "
            f"(dedup={counts['pdf_files_deduplicated']}, opaque={counts['pdf_files_already_opaque']}), "
            f"bbox_deleted={GREEN}{counts['bbox_files_deleted']}{RESET}, "
            f"forms_file={GREEN}{counts['forms_file_migrated']}{RESET}, "
            f"forms_sections={GREEN}{counts['forms_sections_migrated']}{RESET}, "
            f"forms_specialties={GREEN}{counts['forms_specialties_migrated']}{RESET}, "
            f"agendas_specialties={GREEN}{counts['agendas_specialties_migrated']}{RESET}, "
            f"patients_id={GREEN}{counts['patients_migrated']}{RESET}, "
            f"unverified_isolated={YELLOW}{counts['unverified_patients_isolated']}{RESET}, "
            f"cache={GREEN}{counts['cache_docs_migrated']}{RESET}, "
            f"milvus_renamed={GREEN}{counts['vector_collections_renamed']}{RESET}"
        )
        if dom in vectordb_warnings:
            print(
                f"    {YELLOW}[WARN] VectorDB collection rename skipped ({vectordb_warnings[dom]}){RESET}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
