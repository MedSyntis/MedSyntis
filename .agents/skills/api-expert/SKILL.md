---
name: api-expert
description: "Expert on the MedSyntis Cross-Domain FastAPI architecture (`application/app-api.py`, `application/src/routers/`, `application/src/models/`, `application/src/application/use_cases/`). Use when auditing, debugging, refactoring, testing, or extending REST and Server-Sent Events (SSE) API endpoints."
---

# MedSyntis API Expert Skill (`api-expert`)

This skill encapsulates full architectural knowledge of the **MedSyntis Cross-Domain FastAPI** (`application/app-api.py`, `application/src/routers/`, `application/src/models/`) and defines a concrete roadmap and ruleset for evolving and maintaining the API.

---

## 1. Current API Architecture Map

### Entrypoint & Lifespan (`application/app-api.py`)
- **App Metadata**: `MedSyntis Cross-Domain API` (`v1.1.0`), OpenAPI schema served at `/api/v1/openapi.json`, interactive docs at `/docs` and `/redoc` (disabled when `APP_DEV_MODE=false` unless explicitly enabled).
- **Lifespan Management**:
  1. Boots `InMemoryQueueManager` with `auto_start_workers=True`.
  2. Runs crash recovery from MongoDB (`queue_manager.recover_unfinished_from_mongodb()`).
  3. On shutdown: stops queue workers (`queue_manager.shutdown()`), unloads LLM weights from VRAM (`unload_active_models(app_conf)`), and closes process-wide MongoDB clients (`close_all_mongo_clients()`).
- **Public & Root Endpoints**:
  - `GET /health` -> `HealthResponse` (status, allowed domains, queue stats).
  - `GET /api/v1/me` -> `AuthSessionResponse` (authenticated user identity & role context).
  - `GET /api/v1/patients` -> `list[PatientCardResponse]` (root convenience alias for domain patient cards).

### Security & Multi-Domain Middleware (`application/src/routers/dependencies.py`)
- **Authentication (`verify_api_token`)**:
  - Protects all `/api/v1/*` routers via `Authorization: Bearer <token>` or `X-API-Key: <token>`.
  - Uses constant-time `hmac.compare_digest` against `APP_API_TOKEN` (`SecretStr`).
  - Mandatory whenever `APP_DEV_MODE=false` (enforced at startup).
- **Multi-Domain Routing (`AllowedDomainMiddleware` & `DomainConfigDep`)**:
  - Intercepts `/api/*` requests, extracts `?domain=...` or `X-MedSyntis-Domain`, validates against `APP_ALLOWED_DOMAINS` (e.g., `oncology`, `sma`), attaches `request.state.domain_config` via `@lru_cache` `get_domain_scoped_config(domain)`, and echoes `X-MedSyntis-Domain` in response headers.
- **Database Session & Service DI (`get_db` / `require_db` / `RecordServiceDep` / `ExtractionServiceDep`)**:
  - Yields a domain-scoped `Mongodb(config)` wrapper backed by the shared process-wide `MongoClient` pool and wires use-case services cleanly via `Annotated[..., Depends(...)]`.

### Versioned Routers (`/api/v1`)
All JSON endpoints return **strongly-typed Pydantic response models** (`application/src/models/`):

1. **`/api/v1/patientmdtform`** (`application/src/routers/patientmdtform.py`, schemas in `application/src/models/rcp.py` & `patient_mdt_form.py`):
   - `GET ""` -> `list[RCPCardResponse]`: Summary cards for all `PatientMDTForm` records in the domain.
   - `GET /schema` -> `DomainSchemaResponse`: Domain-scoped section metadata, titles, poles, and ordering.
   - `GET /resolve` -> `ResolvedPatientMDTFormResponse`: Resolves a record identifier or filename to its canonical `PatientMDTForm`.
   - `GET /batches/{batch_id}` -> `BatchStatusResponse`: Upload/extraction batch progress across queued files.
   - `GET /patients` -> `list[PatientCardResponse]`: Aggregated patient cards from their latest analyzed `PatientMDTForm`.
   - `GET /patients/{patient_id}` -> `PatientDetailResponse`: Patient identity + chronological history of all `PatientMDTForm` documents.
   - `GET /patients/{patient_id}/dashboard` -> `PatientDashboardResponse`: Unified clinical dashboard payload (timeline, longitudinal deltas, synoptic triage, expert opinions).
   - `GET /patients/{patient_id}/summary` -> `PatientRecordSummaryStateResponse`: Cached longitudinal multi-MDT clinical summary state.
   - `POST /patients/{patient_id}/summary` -> `PatientSummaryTriggerResponse`: Enqueues or triggers longitudinal patient summary generation.
   - `DELETE /patients/{patient_id}` -> `MessageResponse`: Cascades deletion across `PatientRecord`, `PatientMDTForm` docs, cache, vector store chunks, and PDF files.
   - `POST /patients/{patient_id}/chat` -> `ChatResponse`: Multi-document clinical agent chat across a patient's full history.
   - `GET /{filename}` -> `PatientMDTFormDetailResponse`: Strongly-typed full `PatientMDTForm` document.
   - `GET /{filename}/status` -> `PatientMDTFormStatusResponse`: Current extraction status and completion summary.
   - `GET /{filename}/jobs-state` -> `PatientMDTFormJobsStateResponse`: Active and recent queue job states for a document.
   - `DELETE /{filename}` -> `MessageResponse`: Deletes a single `PatientMDTForm` and synchronizes the parent `PatientRecord`.
   - `POST /upload` -> `UploadResponse`: Streams upload in 64 KB chunks (50 MB cap), verifies `%PDF-` magic header, deduplicates by SHA-256 (`resolve_upload`), writes to disk, and enqueues into `PriorityQueue`.
   - `POST /{filename}/process` -> `ProcessResponse`: Reprocesses a single clinical section (`model_name`) or the entire form (`preserve_manual_edits`).
   - `POST /{filename}/chat` -> `ChatResponse`: Single-document agent chat.
   - `GET /{filename}/pdf` -> `FileResponse`: Streams original PDF (`safe_path` traversal protection).
   - `PATCH /{filename}/missing-items` -> `PatientMDTFormDetailResponse`: Updates completeness/missing-items checklist state.
   - `PATCH /{filename}/sections/{section_name}` -> `PatientMDTFormDetailResponse`: Manual clinical override with `manually_edited_sections` tracking and audit metadata (`edited_by`).
   - `POST /{filename}/sections/{section_name}/rollback` -> `PatientMDTFormDetailResponse`: Restores a manually overridden section back to the AI-extracted baseline.
   - `PATCH /{filename}/administrative` -> `AdministrativeUpdateResponse`: Updates patient identity and optionally propagates across all linked forms.
   - `POST /{filename}/link-patient` -> `LinkPatientResponse`: Re-links a form to an existing `PatientRecord`.

2. **`/api/v1/mdt-agenda`** (`application/src/routers/mdt_agenda.py`, schemas in `application/src/models/mdt_agenda.py`):
   - `GET ""` -> `MDTAgendaDetailResponse`: Active Next MDT Agenda, scheduled items, specialist windows, and candidate pool.
   - `PATCH ""` -> `MDTAgendaDetailResponse`: Updates session date, sort strategy (`hybrid`, `urgency`, `quorum`, `manual`), attending experts, or enrolled patients.
   - `POST /schedule` -> `MDTAgendaDetailResponse`: Schedules a new MDT meeting session.
   - `POST /patients` -> `MDTAgendaDetailResponse`: Enrolls one, multiple, or all candidate patients and recomputes passage order.
   - `DELETE /patients/{patient_id}` & `DELETE /patients` -> `MDTAgendaDetailResponse`: Removes one or all enrolled patients.
   - `POST /patients/{patient_id}/move` -> `MDTAgendaDetailResponse`: Moves an enrolled patient up/down or pins/unpins their slot.
   - `PUT /reorder` -> `MDTAgendaDetailResponse`: Explicitly reorders enrolled patients.

3. **`/api/v1/queue`** (`application/src/routers/queue.py`, schemas in `application/src/models/queue.py`):
   - `GET /domains` -> `QueueDomainsResponse`
   - `GET /stats` -> `QueueStatsResponse` (`pending`, `processing`, `completed`, `failed`, `cancelled`, `active_locks`, `allowed_domains`)
   - `GET /jobs` -> `list[QueueJobResponse]` (filters: `domain`, `status`, `batch_id`, `filename`, `limit`)
   - `GET /thinking` & `GET /jobs/{job_id}/thinking` -> `QueueThinkingResponse`
   - `GET /thinking/stream` & `GET /jobs/{job_id}/thinking/stream` -> `EventSourceResponse` (`ServerSentEvent` streaming `<think>` deltas, heartbeats, and completion)
   - `POST /enqueue-import` & `POST /rerun` -> `EnqueueResponse`
   - `POST /jobs/{job_id}/retry` -> `QueueJobResponse`
   - `DELETE /jobs/{job_id}` -> `JobDeletedResponse`
   - `POST /clean` -> `QueueCleanResponse` (`QueueCleanMode`: `completed`, `failed`, `reset_stuck`, `retry_failed`, `pending`, `all`)
   - `GET /locks` -> `list[GpuLeaseResponse]` & `DELETE /locks` -> `ReleaseLocksResponse`

4. **`/api/v1/agents`** (`application/src/routers/agents.py`, schemas in `application/src/models/agents.py`):
   - `GET ""` -> `list[AgentSummaryResponse]` & `GET /{agent_name}` -> `AgentDetailResponse` (system prompt, LLM models, attached clinical reference resources).

5. **`/api/v1/resources`** (`application/src/routers/resources.py`, schemas in `application/src/models/resources.py`):
   - `GET ""` -> `list[ResourceIndexResponse]`
   - `GET /{filename}/file` -> `FileResponse` (streams scientific reference PDF/Markdown file safely)
   - `POST /upload` -> `ResourceUploadResponse`
   - `POST /{filename}/index` -> `ResourceIndexedResponse`
   - `POST /{filename}/chat` -> `ChatResponse`
   - `DELETE /{filename}` -> `MessageResponse`

6. **`/api/v1/bug-reports`** (`application/src/routers/bug_reports.py`, schemas in `application/src/models/bug_reports.py`):
   - `GET ""` -> `list[BugReportResponse]` (filters: `status`, `category`, `severity`, `limit`)
   - `POST ""` -> `BugReportResponse` (`201 Created`)
   - `PATCH /{report_id}/status` -> `BugReportResponse`
   - `DELETE /{report_id}` -> `MessageResponse`

---

## 2. Continuous Improvement Priorities

When extending or refactoring the API, uphold these architectural standards:

1. **Zero Untyped Dict Responses**:
   - Every endpoint must declare an explicit Pydantic `response_model` in `application/src/models/` so OpenAPI 3.1 contracts (`test_api_openapi.py`) stay complete and internal MongoDB fields are never leaked.
2. **Pure FastAPI Dependency Injection (`Annotated[..., Depends(...)]`)**:
   - Inject domain configuration (`DomainConfigDep`), database handles (`require_db`), and application use-case services (`RecordServiceDep`, `ExtractionServiceDep`, `MDTAgendaServiceDep`) through FastAPI dependencies rather than instantiating `AppConfig()` or repositories ad-hoc inside route handlers.
3. **Real-Time SSE Streaming & Non-Blocking GPU Scheduling**:
   - Route heavy LLM extraction and embedding workloads through `InMemoryQueueManager` (`PriorityQueue`) so single-GPU VRAM access remains serialized across domains, and prefer `EventSourceResponse` (`ServerSentEvent`) for long-running streaming endpoints.
4. **Standardized Error Mapping & Ubiquitous Language**:
   - Map domain exceptions (`NonPatientMDTFormError`, `UnsafePathError`, `ValueError`, `KeyError`) consistently to HTTP status codes without leaking stack traces, and enforce `PatientMDTForm` (`patient_mdt_form`) plus 100% English docstrings/comments (`ubiquitous-language-english` skill).

---

## 3. Testing & Verification Workflow (Strict TDD)

From the repository root (or inside `application/`):

1. **Write Failing Contract / Integration Tests First (`Red`)**:
   - Add tests in `application/tests/test_api_*.py` using `fastapi.testclient.TestClient(app)` without starting background workers unless explicitly testing lifespan behavior.
   - Verify OpenAPI and auth contracts: `uv run --project application pytest application/tests/test_api_openapi.py application/tests/test_api_auth.py`.
2. **Implement & Pass (`Green`)**:
   - Keep routers thin (`application/src/routers/`); place business orchestration in `application/src/application/use_cases/`.
3. **Lint, Format & Full Test Suite (`Refactor`)**:
   - `uv run --project application ruff check application/src/ application/tests/ application/app-api.py`
   - `uv run --project application ruff format --check application/src/ application/tests/ application/app-api.py`
   - `uv run --project application pytest application/tests/`
