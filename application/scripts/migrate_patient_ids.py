"""
One-shot, idempotent MongoDB migration converting legacy cleartext `patient_id` slugs
into deterministic SHA-256 pseudonymized identifiers (`pat_<16hex>` / `patient_<16hex>`).

Updates `patients`, `rcp_info` (`PatientMDTForm`), `mdt_agendas`, and `bug_reports`
across all configured MedSyntis domains without printing any patient PII to stdout.
"""

import argparse
from datetime import datetime
import hashlib
import json
import os
import sys
from typing import Any

from slugify import slugify

# Ensure `application/` is on sys.path when invoked directly as `python scripts/migrate_patient_ids.py`
script_dir = os.path.dirname(os.path.abspath(__file__))
app_dir = os.path.abspath(os.path.join(script_dir, ".."))
if app_dir not in sys.path:
    sys.path.insert(0, app_dir)

from pymongo import MongoClient  # noqa: E402

from src.application.config import AppConfig  # noqa: E402
from src.domain.patient import Patient  # noqa: E402
from src.infrastructure.documents.mongodb import (  # noqa: E402
    _BSON_CODEC_OPTIONS,
    build_connection_string,
)

CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"


def hash_legacy_patient_slug(legacy_id: str) -> str:
    """
    Deterministically convert a legacy cleartext `patient_id` slug into its canonical
    SHA-256 pseudonymized identifier (`pat_<16hex>` or `patient_<16hex>`).
    """
    cleaned = legacy_id.strip()
    if Patient.is_pseudonymized_id(cleaned):
        return cleaned
    if cleaned.startswith("patient_"):
        raw_suffix = cleaned.removeprefix("patient_")
        file_slug = slugify(raw_suffix or "unknown", separator="_")
        digest = hashlib.sha256(
            f"medsyntis:unidentified:{file_slug}".encode("utf-8")
        ).hexdigest()[:16]
        return f"patient_{digest}"
    canonical = cleaned.lower()
    digest = hashlib.sha256(
        f"medsyntis:patient:{canonical}".encode("utf-8")
    ).hexdigest()[:16]
    return f"pat_{digest}"


def _compute_patient_doc_target_id(doc: dict[str, Any], old_id: str) -> str:
    """Compute the canonical pseudonymized `patient_id` for a `patients` collection document."""
    if Patient.is_pseudonymized_id(old_id):
        return old_id
    first_name = doc.get("first_name")
    last_name = doc.get("last_name")
    date_birth = doc.get("date_birth")
    files = doc.get("files") if isinstance(doc.get("files"), list) else []
    fallback_file = files[0] if files else None
    if not fallback_file and old_id.startswith("patient_"):
        fallback_file = old_id.removeprefix("patient_")
    if first_name or last_name or fallback_file:
        return Patient.build_id(
            first_name=first_name,
            last_name=last_name,
            date_birth=date_birth,
            fallback_file=fallback_file,
        )
    return hash_legacy_patient_slug(old_id)


def _merge_file_lists(primary: Any, secondary: Any) -> list[str]:
    merged: list[str] = []
    for source in (primary, secondary):
        if isinstance(source, list):
            for item in source:
                if isinstance(item, str) and item and item not in merged:
                    merged.append(item)
    return merged


def migrate_database_patient_ids(
    database: Any,
    *,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    Migrate all non-pseudonymized `patient_id` values inside a single MongoDB database.

    Covers:
    - `patients`: rewrites `patient_id` in place, or merges `files` / `record_summary` into
      an existing pseudonymized document before deleting the legacy duplicate.
    - `rcp_info`: rewrites `patient_id` on `PatientMDTForm` documents.
    - `mdt_agendas`: rewrites `entries[].patient_id`, deduplicates collided entries, and
      renormalizes `manual_order`.
    - `bug_reports`: rewrites `patient_id` on linked bug reports.
    """
    stats = {
        "patients_already_pseudonymized": 0,
        "patients_migrated": 0,
        "patients_merged": 0,
        "forms_migrated": 0,
        "agendas_updated": 0,
        "bugs_migrated": 0,
    }
    id_map: dict[str, str] = {}

    # 1. Migrate `patients` collection
    patients_col = database["patients"]
    all_patients = list(patients_col.find({}))
    existing_by_id: dict[str, dict[str, Any]] = {
        str(d["patient_id"]): d
        for d in all_patients
        if isinstance(d.get("patient_id"), str) and d.get("patient_id")
    }

    for doc in all_patients:
        old_id = doc.get("patient_id")
        if not isinstance(old_id, str) or not old_id.strip():
            continue
        if Patient.is_pseudonymized_id(old_id):
            stats["patients_already_pseudonymized"] += 1
            continue

        new_id = _compute_patient_doc_target_id(doc, old_id)
        id_map[old_id] = new_id

        target_existing = existing_by_id.get(new_id)
        if target_existing is not None and target_existing.get("_id") != doc.get("_id"):
            merged_files = _merge_file_lists(
                target_existing.get("files"), doc.get("files")
            )
            update_fields: dict[str, Any] = {
                "files": merged_files,
                "updated_at": datetime.now(),
            }
            for field in ("first_name", "last_name", "born_name", "date_birth"):
                if not target_existing.get(field) and doc.get(field):
                    update_fields[field] = doc[field]
            if (
                not target_existing.get("record_summary")
                and doc.get("record_summary") is not None
            ):
                update_fields["record_summary"] = doc["record_summary"]

            if not dry_run:
                patients_col.update_one(
                    {"_id": target_existing["_id"]},
                    {"$set": update_fields},
                )
                patients_col.delete_one({"_id": doc["_id"]})
            target_existing.update(update_fields)
            existing_by_id.pop(old_id, None)
            stats["patients_merged"] += 1
        else:
            if not dry_run:
                patients_col.update_one(
                    {"_id": doc["_id"]},
                    {"$set": {"patient_id": new_id, "updated_at": datetime.now()}},
                )
            updated_doc = dict(doc)
            updated_doc["patient_id"] = new_id
            existing_by_id.pop(old_id, None)
            existing_by_id[new_id] = updated_doc
            stats["patients_migrated"] += 1

    # 2. Migrate `rcp_info` (`PatientMDTForm`) collection
    forms_col = database["rcp_info"]
    for form_doc in list(forms_col.find({})):
        old_pid = form_doc.get("patient_id")
        if not isinstance(old_pid, str) or not old_pid.strip():
            continue
        if Patient.is_pseudonymized_id(old_pid):
            continue

        new_pid = id_map.get(old_pid)
        if not new_pid:
            admin = form_doc.get("PatientAdministrative")
            if isinstance(admin, dict) and (
                admin.get("first_name") or admin.get("last_name")
            ):
                new_pid = Patient.build_id(
                    first_name=admin.get("first_name"),
                    last_name=admin.get("last_name"),
                    date_birth=admin.get("date_birth"),
                    fallback_file=form_doc.get("file"),
                )
            else:
                new_pid = hash_legacy_patient_slug(old_pid)
            id_map[old_pid] = new_pid

        if not dry_run:
            forms_col.update_one(
                {"_id": form_doc["_id"]},
                {"$set": {"patient_id": new_pid}},
            )
        stats["forms_migrated"] += 1

    # 3. Migrate `mdt_agendas` collection
    agendas_col = database["mdt_agendas"]
    for agenda_doc in list(agendas_col.find({})):
        entries = agenda_doc.get("entries")
        if not isinstance(entries, list) or not entries:
            continue

        changed = False
        new_entries: list[dict[str, Any]] = []
        seen_pids: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            entry_copy = dict(entry)
            ep_id = entry_copy.get("patient_id")
            if isinstance(ep_id, str) and ep_id.strip():
                if not Patient.is_pseudonymized_id(ep_id):
                    mapped = id_map.get(ep_id) or hash_legacy_patient_slug(ep_id)
                    id_map[ep_id] = mapped
                    entry_copy["patient_id"] = mapped
                    changed = True
                resolved_pid = entry_copy["patient_id"]
                if resolved_pid in seen_pids:
                    changed = True
                    continue
                seen_pids.add(resolved_pid)
            new_entries.append(entry_copy)

        if changed:
            for idx, item in enumerate(new_entries):
                item["manual_order"] = idx
            if not dry_run:
                agendas_col.update_one(
                    {"_id": agenda_doc["_id"]},
                    {
                        "$set": {
                            "entries": new_entries,
                            "updated_at": datetime.now(),
                        }
                    },
                )
            stats["agendas_updated"] += 1

    # 4. Migrate `bug_reports` collection
    bugs_col = database["bug_reports"]
    for bug_doc in list(bugs_col.find({})):
        old_bpid = bug_doc.get("patient_id")
        if not isinstance(old_bpid, str) or not old_bpid.strip():
            continue
        if Patient.is_pseudonymized_id(old_bpid):
            continue

        new_bpid = id_map.get(old_bpid) or hash_legacy_patient_slug(old_bpid)
        id_map[old_bpid] = new_bpid
        if not dry_run:
            bugs_col.update_one(
                {"_id": bug_doc["_id"]},
                {"$set": {"patient_id": new_bpid, "updated_at": datetime.now()}},
            )
        stats["bugs_migrated"] += 1

    return stats


def resolve_target_database_names(
    base_conf: AppConfig,
    existing_db_names: list[str],
    domain_filter: str | None = None,
) -> list[str]:
    """Resolve the ordered, deduplicated list of MongoDB database names to migrate."""
    if domain_filter:
        dom_conf = base_conf.for_domain(domain_filter)
        return [dom_conf.mongodb.database]

    targets: list[str] = []
    for dom in base_conf.enabled_domains_list:
        dom_db = base_conf.for_domain(dom).mongodb.database
        if dom_db not in targets:
            targets.append(dom_db)

    raw_base = base_conf._strip_domain_suffix(
        base_conf.mongodb.database, (base_conf.domain or "").strip().lower()
    )
    if raw_base and raw_base in existing_db_names and raw_base not in targets:
        targets.append(raw_base)
    return targets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Migrate legacy cleartext patient_id values in MongoDB to SHA-256 "
            "pseudonymized identifiers (pat_<16hex> / patient_<16hex>)."
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
        help="Inspect collections and report counts without writing changes to MongoDB.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit migration summary as JSON.",
    )
    args = parser.parse_args(argv)

    base_conf = AppConfig()
    base_conf.logs.level = "ERROR"

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

    results_by_db: dict[str, dict[str, int]] = {}
    try:
        existing_dbs = client.list_database_names()
        target_dbs = resolve_target_database_names(
            base_conf, existing_dbs, domain_filter=args.domain
        )
        for db_name in target_dbs:
            db_handle = client.get_database(db_name, codec_options=_BSON_CODEC_OPTIONS)
            results_by_db[db_name] = migrate_database_patient_ids(
                db_handle, dry_run=args.dry_run
            )
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
                {"dry_run": args.dry_run, "databases": results_by_db},
                indent=2,
            )
        )
        return 0

    mode_banner = (
        f"{YELLOW}[DRY-RUN]{RESET} " if args.dry_run else f"{GREEN}[APPLIED]{RESET} "
    )
    print(
        f"{BOLD}{CYAN}=== MedSyntis Patient ID Pseudonymization Migration ==={RESET} {mode_banner}"
    )
    for db_name, counts in results_by_db.items():
        print(
            f"  • {BOLD}{db_name}{RESET}: "
            f"patients migrated={GREEN}{counts['patients_migrated']}{RESET}, "
            f"merged={YELLOW}{counts['patients_merged']}{RESET}, "
            f"already_pseudonymized={counts['patients_already_pseudonymized']}, "
            f"forms={GREEN}{counts['forms_migrated']}{RESET}, "
            f"agendas={GREEN}{counts['agendas_updated']}{RESET}, "
            f"bugs={GREEN}{counts['bugs_migrated']}{RESET}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
