# 🔌 REST & SSE API v1 Specification — MedSyntis

This document specifies all versioned REST and Server-Sent Events (SSE) endpoints exposed by the **MedSyntis Cross-Domain FastAPI Backend** (`application/app-api.py`).

---

## 🚀 Quickstart & Interactive OpenAPI Documentation

Start the FastAPI backend locally from `application/`:

```bash
cd application
uv run python app-api.py
# Or with hot-reload during development:
uv run uvicorn app-api:app --reload --host 127.0.0.1 --port 8000
```

When `APP_API_DOCS_ENABLED=true` (default in local dev), interactive documentation is available at:
* **Swagger UI**: `http://127.0.0.1:8000/docs`
* **ReDoc**: `http://127.0.0.1:8000/redoc`
* **OpenAPI 3.1 JSON Schema**: `GET /api/v1/openapi.json`

### Source Code Structure
* **Application Entrypoint & Middlewares**: [`application/app-api.py`](../../application/app-api.py)
* **Security, Auth & Domain Routing Dependencies**: [`application/src/routers/dependencies.py`](../../application/src/routers/dependencies.py)
* **Versioned Routers (`/api/v1/*`)**:
  * [`application/src/routers/patientmdtform.py`](../../application/src/routers/patientmdtform.py) (`/api/v1/patientmdtform`)
  * [`application/src/routers/mdt_agenda.py`](../../application/src/routers/mdt_agenda.py) (`/api/v1/mdt-agenda`)
  * [`application/src/routers/agents.py`](../../application/src/routers/agents.py) (`/api/v1/agents`)
  * [`application/src/routers/resources.py`](../../application/src/routers/resources.py) (`/api/v1/resources`)
  * [`application/src/routers/queue.py`](../../application/src/routers/queue.py) (`/api/v1/queue`)
  * [`application/src/routers/bug_reports.py`](../../application/src/routers/bug_reports.py) (`/api/v1/bug-reports`)
* **Pydantic Request/Response Schemas**: [`application/src/models/`](../../application/src/models/)

---

## 🔐 Authentication, Zero-Trust Headers & Multi-Domain Routing

### 1. API Token Authentication (`verify_api_token`)
Every `/api/v1/*` endpoint requires the shared `APP_API_TOKEN` (mandatory whenever `APP_DEV_MODE=false`), passed via either:
* `Authorization: Bearer <APP_API_TOKEN>`
* `X-API-Key: <APP_API_TOKEN>`

### 2. Zero-Trust User Identity & Admin Authorization (`get_current_user_info` & `require_admin`)
When requests are forwarded by the Fastify BFF (`web/`) or OAuth2-Proxy / Caddy in `oauth_proxy` mode, user identity is resolved from:
* `X-MedSyntis-User`: Authenticated username or email.
* `X-MedSyntis-User-Name`: Optional display name.
* `X-MedSyntis-Proxy-Secret`: Shared secret compared in constant time (`hmac.compare_digest`) against `APP_PROXY_SECRET`.

Destructive endpoints protected by `require_admin` (`DELETE /api/v1/patientmdtform/patients/{patient_id}`, queue retry/cancel/clean/lock release) verify that the authenticated user belongs to `APP_ADMIN_USERS` whenever user headers are present.

### 3. Multi-Domain Routing (`AllowedDomainMiddleware`)
All `/api/v1/*` endpoints dynamically scope MongoDB (`MedSyntis_{domain}`), Milvus (`medsyntisDocs_{domain}_{embedding}`), file storage (`ressources/PatientMDTForm/{domain}`), and specialist agents to the requested clinical domain (`oncology` or `sma`), resolved in priority order from:
1. Query parameter: `?domain=oncology` or `?domain=sma`
2. HTTP header: `X-MedSyntis-Domain: oncology` or `X-MedSyntis-Domain: sma`
3. Instance default: `APP_DOMAIN` (defaults to `oncology`)

Every `/api/v1/*` response echoes the resolved domain in the `X-MedSyntis-Domain` response header. If an unauthorized domain is requested (not in `APP_ALLOWED_DOMAINS`), the middleware returns `HTTP 400 Bad Request`.

---

## 1. System & Identity Endpoints

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Public | Returns API liveness (`status: "ok"`), `allowed_domains`, and live `PriorityQueue` stats (`HealthResponse`). |
| `GET` | `/api/v1/me` | `APP_API_TOKEN` | Returns `{username, display_name, is_admin}` resolved from `X-MedSyntis-User` and `X-MedSyntis-Proxy-Secret` (`MeResponse`). |
| `GET` | `/api/v1/patients` | `APP_API_TOKEN` | Returns the raw list of `Patient` records for the active domain (`list[PatientListItemResponse]`). Query param: `identified_only: bool = false` (excludes temporary `patient_*` / `Inconnu` records when `true`). |

---

## 2. Patient Records & `PatientMDTForm` Endpoints (`/api/v1/patientmdtform`)

### Summary Table

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/patientmdtform` | List all `PatientMDTForm` cards (`list[RCPCardResponse]`) for the active domain. |
| `GET` | `/api/v1/patientmdtform/patients` | List longitudinal patient summary cards (`list[PatientCardResponse]`) synthesized from each patient's latest analyzed MDT form. |
| `GET` | `/api/v1/patientmdtform/patients/{patient_id}` | Get full patient dossier details (`patient`, `latest_file`, and chronological `rcps` list) (`PatientDetailResponse`). |
| `GET` | `/api/v1/patientmdtform/patients/{patient_id}/dashboard` | Return the longitudinal `PatientRecord` dashboard with multi-year raw clinical metric series and global summary state (`PatientDashboardResponse`). |
| `GET` | `/api/v1/patientmdtform/patients/{patient_id}/summary` | Return the global longitudinal summary state and obsolescence flags for `{patient_id}` (`PatientRecordSummaryStateResponse`). |
| `POST` | `/api/v1/patientmdtform/patients/{patient_id}/summary` | Enqueue an on-demand global `PatientRecord` longitudinal summary synthesis job (`{force: bool = false}` -> `PatientSummaryTriggerResponse`). |
| `DELETE` | `/api/v1/patientmdtform/patients/{patient_id}` | Delete a patient dossier and all its associated MDT forms and PDF files (`require_admin`, `MessageResponse`). |
| `POST` | `/api/v1/patientmdtform/patients/{patient_id}/chat` | Chat with a specialist agent across the **entire longitudinal patient dossier** (`ChatRequest` -> `ChatResponse`). |
| `GET` | `/api/v1/patientmdtform/schema` | Return the domain's `PatientMDTForm` schema (clinical sections, editability, specialist agents, and enums) (`DomainFormSchemaResponse`). |
| `GET` | `/api/v1/patientmdtform/resolve` | Resolve a `PatientRecord`, its enriched chronological `rcps`, `selected_file`, and `latest_file` by `?patient_id=...` and/or `?file=...` (`PatientResolveResponse`). |
| `GET` | `/api/v1/patientmdtform/batches/{batch_id}` | Get per-file processing status and progress percentage for an upload `batch_id` (`BatchStatusResponse`). |
| `GET` | `/api/v1/patientmdtform/{filename}` | Retrieve the complete structured `PatientMDTForm` document enriched with `metrics` and `mdt_date` (`PatientMDTFormDetailResponse`). |
| `GET` | `/api/v1/patientmdtform/{filename}/status` | Retrieve lightweight extraction status (`processing_status`, `processing_step`, `processing_progress_pct`, `processing_error`, `patient_id`) (`PatientMDTFormStatusResponse`). |
| `GET` | `/api/v1/patientmdtform/{filename}/jobs-state` | Retrieve active `PriorityQueue` jobs and currently running model names for `{filename}` (`ActiveJobsStateResponse`). |
| `GET` | `/api/v1/patientmdtform/{filename}/pdf` | Download or stream inline (`?inline=true`) the source PDF or its bounding-box highlighted variant (`?variant=bbox`). |
| `POST` | `/api/v1/patientmdtform/upload` | Upload a PDF (`multipart/form-data`), check SHA-256 duplicates, and enqueue 3-wave extraction (`UploadResponse`). |
| `POST` | `/api/v1/patientmdtform/{filename}/process` | Enqueue or run full-form or single-section (`model_name`) AI extraction while respecting `preserve_manual_edits` (`ProcessResponse`). |
| `POST` | `/api/v1/patientmdtform/{filename}/chat` | Chat with a specialist agent scoped to a single `PatientMDTForm` document (`ChatRequest` -> `ChatResponse`). |
| `PATCH` | `/api/v1/patientmdtform/{filename}/sections/{section_name}` | Save a human-in-the-loop manual edit (`manual_edits`) on a clinical, completeness, or orientation section (`PatientMDTFormDetailResponse`). |
| `POST` | `/api/v1/patientmdtform/{filename}/sections/{section_name}/rollback` | Rollback a manually edited section back to its original AI extraction (`PatientMDTFormDetailResponse`). |
| `PATCH` | `/api/v1/patientmdtform/{filename}/missing-items` | Toggle visibility of individual missing items (`toggle_item`) or hide/restore all missing items (`PatientMDTFormDetailResponse`). |
| `PATCH` | `/api/v1/patientmdtform/{filename}/administrative` | Update patient administrative identity (`first_name`, `last_name`, `born_name`, `date_birth`, `date_rcp`, `gender`) and synchronize `PatientRecord` (`AdministrativeUpdateResponse`). |
| `POST` | `/api/v1/patientmdtform/{filename}/link-patient` | Re-link a `PatientMDTForm` to an existing `target_patient_id` (`AdministrativeUpdateResponse`). |
| `DELETE` | `/api/v1/patientmdtform/{filename}` | Delete a single `PatientMDTForm` record from MongoDB and disk (`MessageResponse`). |

### Key Payload Examples

#### Upload a Patient MDT PDF (`POST /api/v1/patientmdtform/upload`)
* **Content-Type**: `multipart/form-data`
* **Form Fields**:
  * `file`: PDF binary (max 50 MB, validated for `%PDF-` magic header).
  * `patient_id` *(optional)*: Target patient ID (if omitted, Wave 1 administrative extraction automatically links or creates the patient).
  * `run_full_ai` *(optional, default `true`)*: Run all 3 extraction waves (`true`) or Wave 1 identification only (`false`).
  * `batch_id` *(optional)*: Client or batch correlation identifier.

#### Trigger Longitudinal Patient Summary (`POST /api/v1/patientmdtform/patients/{patient_id}/summary`)
```json
{
  "force": false
}
```

#### Trigger Full or Single-Section Reprocessing (`POST /api/v1/patientmdtform/{filename}/process`)
```json
{
  "model_name": "Chemotherapy",
  "preserve_manual_edits": true
}
```
*(Pass `"model_name": null` to re-run all sections of the form).*

#### Manually Edit a Section (`PATCH /api/v1/patientmdtform/{filename}/sections/{section_name}`)
```json
{
  "section_data": {
    "chemotherapy_name": "Modified FOLFIRINOX (8 cycles validated by MDT)"
  },
  "edited_by": "Dr. Martin"
}
```

#### Update Missing Items Visibility (`PATCH /api/v1/patientmdtform/{filename}/missing-items`)
```json
{
  "toggle_item": "Definitive EUS biopsy pathology report",
  "hide_missing_items": false,
  "edited_by": "MDT Secretariat"
}
```

#### Update Administrative Identity (`PATCH /api/v1/patientmdtform/{filename}/administrative`)
```json
{
  "first_name": "Marion",
  "last_name": "ROUSSEL",
  "born_name": "DUPONT",
  "date_birth": "1968-04-12",
  "date_rcp": "2026-07-20",
  "gender": "F",
  "apply_to_all_patient_forms": true,
  "edited_by": "MDT Secretariat"
}
```

#### Link Form to Existing Patient (`POST /api/v1/patientmdtform/{filename}/link-patient`)
```json
{
  "target_patient_id": "roussel_marion_1968_04_12",
  "override_date_rcp": "2026-07-20",
  "edited_by": "MDT Secretariat"
}
```

---

## 3. Specialist AI Agents Endpoints (`/api/v1/agents`)

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/agents` | List all configured specialist agents for the active domain (`name`, `system_prompt`, `models`, `resources`) (`list[AgentDetailResponse]`). |
| `GET` | `/api/v1/agents/{agent_name}` | Retrieve full metadata and system prompt for a specific agent (`AgentDetailResponse`). |

*(Note: Interactive specialist agent chat is scoped strictly to a document or patient context via `POST /api/v1/patientmdtform/{filename}/chat`, `POST /api/v1/patientmdtform/patients/{patient_id}/chat`, or `POST /api/v1/resources/{filename}/chat`.)*

---

## 4. Clinical Reference Guidelines Endpoints (`/api/v1/resources`)

Used to manage, view, index, and query national scientific guidelines (**TNCD** in Digestive Oncology, **PNDS** in SMA).

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/resources` | List all guideline PDFs in the domain's resources directory with `is_indexed`, `size_bytes`, and `updated_at` (`list[ResourceIndexResponse]`). |
| `GET` | `/api/v1/resources/{filename}/file` | Serve a clinical guideline PDF (or dynamically resolved citation target, with optional `?form_file=...` fallback) inline (`application/pdf`). |
| `POST` | `/api/v1/resources/upload` | Upload a new scientific reference PDF (`multipart/form-data`, max 50 MB) into the domain's resources directory (`ResourceIndexResponse`). |
| `POST` | `/api/v1/resources/{filename}/index` | Parse, chunk, and index a clinical reference PDF into the domain's Milvus/Chroma vector store (`ResourceIndexedResponse`). |
| `POST` | `/api/v1/resources/{filename}/chat` | Query an indexed clinical guideline via the `Ressource Assistant` RAG agent (`ResourceChatRequest` -> `ChatResponse`). |
| `DELETE` | `/api/v1/resources/{filename}` | Delete a clinical reference PDF from the domain's resources directory (`ResourceDeleteResponse`). |

---

## 5. Next MDT Session Agenda Endpoints (`/api/v1/mdt-agenda`)

Manages pre-MDT session scheduling, specialist quorum calculation, and passage-order optimization (`MDTAgendaDetailResponse`).

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/mdt-agenda` | Get the active Next MDT Agenda (`session_date`, `sort_strategy`, `defer_incomplete_files`, `attending_experts`, scheduled `items`, `expert_windows`, `candidates`, and quorum counters). |
| `PATCH` | `/api/v1/mdt-agenda` | Update agenda options (`session_date`, `clear_session_date`, `sort_strategy`, `defer_incomplete_files`, `attending_experts`, `toggle_expert`, `patient_ids`, `reset_enrolled_patients`). |
| `POST` | `/api/v1/mdt-agenda/schedule` | One-click session onboarding: initializes `session_date`, `sort_strategy` (defaults to `"hybrid"`), `defer_incomplete_files`, `attending_experts`, and enrolled `patient_ids`. |
| `POST` | `/api/v1/mdt-agenda/patients` | Enroll one (`patient_id`), several (`patient_ids`), or filtered candidate patients (`add_all_candidates`, `enroll_all_candidates`, `filter_mode`: `"all" \| "urgent" \| "complete"`). |
| `DELETE` | `/api/v1/mdt-agenda/patients/{patient_id}` | Remove a single patient from the Next MDT Agenda (returns them to the candidate pool). |
| `DELETE` | `/api/v1/mdt-agenda/patients` | Clear all enrolled patients from the Next MDT Agenda. |
| `POST` | `/api/v1/mdt-agenda/patients/{patient_id}/move` | Move an enrolled patient (`direction`: `"up" \| "down"`, or `target_position`) and/or pin/unpin their slot (`pinned: true \| false`). |
| `PUT` | `/api/v1/mdt-agenda/reorder` | Explicitly reorder enrolled patients (`patient_ids` array, `switch_to_manual: bool = true`). |

### Agenda Options Update Example (`PATCH /api/v1/mdt-agenda`)
```json
{
  "session_date": "2026-11-20",
  "sort_strategy": "hybrid",
  "defer_incomplete_files": true,
  "attending_experts": ["pancreas expert", "colon expert"]
}
```
Supported `sort_strategy` values:
* `"hybrid"`: Specialty grouping with urgent cases prioritized at the top of each group.
* `"expert_grouping"`: Contiguous specialist passage windows to minimize physician attendance time.
* `"urgency_first"`: Strict descending clinical urgency score.
* `"manual"`: Custom coordinator order.

---

## 6. GPU PriorityQueue & Live SSE Streaming Endpoints (`/api/v1/queue`)

Coordinates multi-domain 3-wave extraction jobs across shared GPU hardware and streams real-time LLM reasoning tokens via Server-Sent Events (`EventSourceResponse`).

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/queue/stats` | Retrieve `PriorityQueue` metrics (`pending`, `processing`, `completed`, `failed`, `cancelled`, `active_locks`, `batch_size`, `hardware_profile`, `allowed_domains`) (`QueueStatsResponse`). Optional `?domain=...`. |
| `GET` | `/api/v1/queue/domains` | Return `{default_domain, allowed_domains}` configured on the Cross-Domain Queue (`QueueDomainsResponse`). |
| `GET` | `/api/v1/queue/jobs` | List queue jobs filterable by `?domain=...`, `?status=...`, `?batch_id=...`, `?filename=...`, and `?limit=100` (`list[QueueJobResponse]`). |
| `GET` | `/api/v1/queue/jobs/{job_id}` | Retrieve details of a specific queue job (`QueueJobResponse`). |
| `GET` | `/api/v1/queue/thinking` | Get a snapshot of live AI reasoning tokens for the active job (or `?job_id=...` / `?domain=...`) (`QueueThinkingResponse`). |
| `GET` | `/api/v1/queue/thinking/stream` | **SSE Stream (`text/event-stream`)** emitting live `QueueThinkingStreamEvent` reasoning tokens for the active task or `?job_id=...`. |
| `GET` | `/api/v1/queue/jobs/{job_id}/thinking` | Get a snapshot of live AI reasoning tokens for `{job_id}` (`QueueThinkingResponse`). |
| `GET` | `/api/v1/queue/jobs/{job_id}/thinking/stream` | **SSE Stream (`text/event-stream`)** emitting live `QueueThinkingStreamEvent` reasoning tokens for `{job_id}`. |
| `POST` | `/api/v1/queue/enqueue-import` | Enqueue an imported `PatientMDTForm` (`Wave 1` + `Wave 2` + `Wave 3`) into the `PriorityQueue` (`EnqueueResponse`). |
| `POST` | `/api/v1/queue/rerun` | Enqueue a full-form or single-section (`model_name`) rerun while preserving `manual_edits` (`EnqueueResponse`). |
| `POST` | `/api/v1/queue/jobs/retry` & `POST /api/v1/queue/jobs/{job_id}/retry` | Re-enqueue a failed or cancelled job by `?job_id=...` or path `{job_id}` (`require_admin`, `QueueJobResponse`). |
| `DELETE` | `/api/v1/queue/jobs` & `DELETE /api/v1/queue/jobs/{job_id}` | Cancel or delete a job by `?job_id=...` or path `{job_id}` and release its GPU lease (`require_admin`, `JobDeletedResponse`). |
| `POST` | `/api/v1/queue/clean` | Clean queue jobs according to `QueueCleanMode` (`"completed"`, `"failed"`, `"reset_stuck"`, `"retry_failed"`, `"pending"`, or `"all"`) (`require_admin`, `QueueCleanResponse`). |
| `GET` | `/api/v1/queue/locks` | List active GPU hardware execution leases (`list[GpuLeaseResponse]`). |
| `DELETE` | `/api/v1/queue/locks` | Force-release GPU leases by `?lease_id=...`, `?job_id=...`, `?domain=...`, or `?force_all=true` (`require_admin`, `ReleaseLocksResponse`). |

---

## 7. Clinical & UI Bug Reports Endpoints (`/api/v1/bug-reports`)

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/bug-reports` | List bug reports and clinical feedback for the active domain, optionally filtered by `?status=...`, `?severity=...`, or `?category=...` (`list[BugReportResponse]`). |
| `POST` | `/api/v1/bug-reports` | Create a new bug report (`title`, `description`, `category`, `severity`, `page`, `patient_id`, `rcp_file`, `steps_to_reproduce`, `reporter`) (`BugReportResponse`). |
| `PATCH` | `/api/v1/bug-reports/{report_id}/status` | Update the resolution status of a bug report (`status`: `"open"`, `"in_progress"`, `"resolved"`, `"closed"`) (`BugReportResponse`). |
| `DELETE` | `/api/v1/bug-reports/{report_id}` | Delete a bug report by its `report_id` (`BugReportDeleteResponse`). |
