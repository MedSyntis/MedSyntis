# 💻 MedSyntis — Technical Architecture & Configuration Reference

This document provides a comprehensive technical reference for **MedSyntis**, detailing its Hexagonal / Domain-Driven Design (DDD) architecture across `web/` and `application/`, its dual vector and document storage layer, authentication mechanisms, and the complete reference of `pydantic-settings` (`AppConfig`) and Web UI environment variables.

---

## 🏗️ Hexagonal & Domain-Driven Design (DDD) Architecture

MedSyntis is organized into two cleanly decoupled workspaces communicating exclusively over versioned REST and Server-Sent Events (`/api/v1/*`):

1. **`web/` — Node.js `>=26` + Fastify 5 Material Design 3 Web UI (Hexagonal BFF + SSR + Vanilla JS)**: Server-side rendered clinical web interface enforcing strict `Content-Security-Policy` (`default-src 'self'`) and WCAG 2.2 AA accessibility.
2. **`application/` — Python `>=3.13` Cross-Domain FastAPI & Multi-Agent RAG Backend**: Implements pure DDD domain models (`src/domain/`), application use cases (`src/application/use_cases/`), infrastructure adapters (`src/infrastructure/`), and REST/SSE routers (`src/routers/`).

```
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  web/ (Node.js >= 26 + Fastify 5 + TypeScript — Material Design 3 UI)   │
   │  • src/domain/         (Triage rules, clinical catalog, i18n, types)    │
   │  • src/application/    (MedsyntisApiPort + Worklist, Dossier, Agenda)   │
   │  • src/infrastructure/ (HttpMedsyntisApiAdapter & InMemoryMedsyntisApiFake)│
   │  • src/ui/             (Fastify 5 BFF routes, M3 SSR templates, SSE)    │
   │  • public/             (M3 CSS tokens, Vanilla JS, 73 SVG icons sprite) │
   └────────────────────────────────────┬────────────────────────────────────┘
                                        │ REST & SSE (/api/v1/*)
                                        │ + X-MedSyntis-Domain / Proxy Secret
                                        ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  application/ (Python >= 3.13 — Cross-Domain FastAPI & Streamlit)       │
   │  • src/routers/        (patientmdtform, mdt_agenda, agents, resources,  │
   │                         queue, bug_reports, dependencies)               │
   │  • src/application/    (use_cases/, agent/, reader.py, config.py)       │
   │  • src/domain/         (PatientRecord, PatientMDTForm, MDTAgenda, etc.) │
   │  • src/infrastructure/ (Milvus v3.0.4, MongoDB 9.0, PriorityQueue, OCR) │
   └─────────────────────────────────────────────────────────────────────────┘
```

### 1. Module Breakdown under `web/` (Material Design 3 Web UI)
* **`src/domain/`**: Pure TypeScript clinical domain logic (`triage.ts` for urgency/completeness/orientation badges and longitudinal clinical deltas, `catalog.ts` for Oncology & SMA section metadata and suggested clinical prompts, `i18n.ts`, `types.ts`).
* **`src/application/`**:
  * **`ports/` (`MedsyntisApiPort`)**: Hexagonal port contract defining all backend operations (worklist, patient dossier resolution, section manual edits & rollbacks, missing items, MDT agenda scheduling, guidelines RAG, batch ingestion, GPU queue supervision, and bug reports).
  * **`use-cases/`**: `worklist.use-case.ts`, `patient-dossier.use-case.ts`, `guidelines.use-case.ts`, `ingest.use-case.ts`, `feedback.use-case.ts`, `queue-admin.use-case.ts`.
* **`src/infrastructure/`**:
  * **`HttpMedsyntisApiAdapter`**: Production HTTP/REST & SSE adapter targeting the Python FastAPI backend (`/api/v1/*`) with Bearer token authentication (`APP_API_TOKEN`), zero-trust proxy secret forwarding (`X-MedSyntis-Proxy-Secret`), and domain header propagation (`X-MedSyntis-Domain`).
  * **`InMemoryMedsyntisApiFake`**: Deterministic in-memory clinical fixture adapter (Digestive Oncology & SMA) activated only when explicitly requested via `WEB_FAKE_API_FALLBACK=true` or `APP_USE_FAKE_ONLY=true` for standalone UI development, Vitest integration tests, and Playwright E2E tests.
* **`src/ui/`**:
  * **`server.ts`**: Fastify 5 BFF server with strict zero-CDN `Content-Security-Policy` (`default-src 'self'`), cookie/session handling, host-based or query-based clinical domain resolution (`oncology` / `sma`), zero-trust `X-MedSyntis-Proxy-Secret` verification in `oauth_proxy` mode, and SSE proxy streaming.
  * **`templates.ts` & `components/`**: Server-Side Rendered (SSR) Material Design 3 views (`Worklist`, `Next MDT Session Agenda`, `Longitudinal Patient Dossier`, `AI Co-Pilot Side Sheet`, `Scientific Guidelines`, `AI Experts Catalog`, `GPU Queue Monitor`, `Bug Reports`).
* **`public/`**: Self-hosted M3 design tokens (`public/css/tokens.css`, `public/css/components.css`), progressive-enhancement Vanilla JS client (`public/js/app.js`), and a **73-icon SVG sprite** (`public/img/icons.svg`).

### 2. Module Breakdown under `application/` (Python FastAPI & Multi-Agent Backend)
* **`src/domain/`**: Pure domain entities, value objects, and repository contracts (`patient.py`, `patient_mdt_form.py`, `common/patient_mdt_common_form.py`, `oncology/patient_mdt_oncologic_form.py` for `PatientMDTOncologicForm`, `sma/patient_mdt_sma_form.py` for `PatientMDTSmaForm`, `patient_dashboard.py`, `mdt_agenda.py`, `bug_report.py`, `agents.py` & domain `agents/`, `repositories.py`).
* **`src/application/`**:
  * **`use_cases/`**:
    * `patient_record.py` (`PatientRecordService`): Deterministic `patient_id` computation from normalized `(last_name, first_name, date_birth)`, patient card synthesis, longitudinal dashboard & summary state, dossier resolution, manual section updates (`manual_edits`), section rollback to original AI extraction, missing-item visibility toggling, and administrative identity reconciliation.
    * `patient_mdt_form_extraction.py` (`PatientMDTFormExtractionService`): Orchestrates PDF SHA-256 duplicate detection, 3-wave extraction (`Wave 1` Administrative, `Wave 2` Clinical & Completeness, `Wave 3` Specialist Opinions & Care Orientation), and `preserve_manual_edits` enforcement.
    * `mdt_agenda.py` (`MDTAgendaService`): Schedules the Next MDT Session Agenda across 4 sorting strategies (`hybrid`, `expert_grouping`, `urgency_first`, `manual`), computes specialist attendance windows and quorum warnings, handles `defer_incomplete_files`, and manages case pinning/reordering.
    * `queue_executor.py`: Dispatches asynchronous extraction and longitudinal summary jobs onto domain-scoped services inside the `PriorityQueue`.
  * **`agent/`**: LangChain multi-expert coordinator (`agent.py`) and context-isolated tools (`tools.py` with `Context` for single-MDT form RAG and `PatientContext` for longitudinal multi-MDT patient history queries).
  * **`reader.py` & `ressources.py`**: Document chunking and vector indexing pipeline for patient records and scientific guidelines (TNCD / PNDS).
  * **`config.py`**: Centralized `pydantic-settings` configuration (`AppConfig`) with domain-scoped overrides (`AppConfig.for_domain(domain)`).
* **`src/infrastructure/`**:
  * **`vectorial/`**: Milvus (`milvus.py`) and Chroma (`chroma.py`) vector store adapters.
  * **`documents/`**: MongoDB connection pool (`mongodb.py`) and domain-scoped repositories (`repositories.py`).
  * **`queue/`**: Thread-safe in-process / cross-domain GPU `PriorityQueue` manager (`InMemoryQueueManager`, `QueueBroker`) with real-time SSE token streaming (`stream_job_thinking`) and startup crash recovery from MongoDB.
  * **`parsers/`**: Multi-engine PDF layout and OCR parsers (`Docling`, `PyMuPDF`, `OpenParse`, and local `Ollama OCR` with `granite3.2-vision`).
* **`src/routers/`**: Versioned FastAPI routers mounted under `/api/v1` (`patientmdtform.py`, `mdt_agenda.py`, `agents.py`, `resources.py`, `queue.py`, `bug_reports.py`, `dependencies.py`).
* **`src/ui/`**: Deprecated / legacy Streamlit dashboard (`app-ui.py`), superseded by `web/`. Note: importing `streamlit` outside `src/ui/` and `app-ui.py` is strictly prohibited by architectural rules.

---

## 🗄️ Database & Storage Layer

MedSyntis isolates data per clinical domain (`oncology`, `sma`) across both its vector database and document store:

### 1. Vector Search Database — Milvus Standalone `v3.0.4`
* **Driver & Integration**: `pymilvus>=3.0.2` and `langchain-milvus>=0.4.0` connecting to **Milvus Standalone `v3.0.4`** on port `19530` (with `etcd` and `minio`).
* **Domain & Embedding Scoped Collections**: Documents and scientific guidelines (TNCD / PNDS) are indexed into domain- and embedding-specific collections named:
  ```text
  medsyntisDocs_{domain}_{embedding}
  ```
  (with base database `medsyntis`).
* **Alternative**: `ChromaDB` (`chromadb>=1.5.9`, `langchain-chroma`) is supported for lightweight single-process testing via `APP_DATABASESVECTORIAL_TYPE="chroma"`.

### 2. Document & Metadata Store — MongoDB `9.0`
* **Driver & Integration**: `pymongo>=4.19.0` connecting to a **MongoDB 9.0** single-node Replica Set (`rs0`) on port `27017`.
* **Domain-Scoped Databases**: Each clinical domain uses an isolated database named **`MedSyntis_{domain}`** (e.g., `MedSyntis_oncology`, `MedSyntis_sma`), containing five core collections:
  * **`patients`**: Longitudinal patient dossiers (`patient_id`, `first_name`, `last_name`, `born_name`, `date_birth`, `gender`, `files`, `updated_at`).
  * **`rcp_info`**: Structured `PatientMDTForm` extractions (`file`, `patient_id`, `file_hash`, `processing_status`, `processing_step`, `processing_progress_pct`, `manual_edits`, `hidden_missing_items`, `PatientAdministrative`, clinical sections, `MTDCompleted`, `CareOrientationProposal`, `ExpertAnswer`, etc.).
  * **`document_cache`**: Cached Markdown and layout extractions keyed by document hash and parser type to avoid redundant OCR.
  * **`mdt_agendas`**: Next MDT Session Agenda state (`session_date`, `sort_strategy`, `defer_incomplete_files`, `attending_experts`, `enrolled_patients`, `pinned_patient_ids`).
  * **`bug_reports`**: Clinical and UI feedback reports (`bug_id`, `title`, `description`, `category`, `severity`, `status`, `page`, `patient_id`, `rcp_file`, `reporter`).

---

## ⚙️ Backend Environment Variables Reference (`application/src/application/config.py`)

`AppConfig` uses `pydantic-settings` to parse environment variables (and `.env` files). Below are the exact environment variable names, types, default values, and descriptions grouped by subsystem.

### 1. Top-Level Application & Multi-Domain Settings (`APP_*`)

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`APP_DOMAIN`** | `str` | `"oncology"` | Default clinical domain (`oncology` or `sma`). |
| **`APP_ALLOWED_DOMAINS`** | `str` | `"oncology,sma"` | Comma-separated list of active clinical domains enabled on the Cross-Domain API and Queue. |
| **`APP_LANGUAGE`** | `str` | `"french"` | Default language for AI extraction and prompts (`french` or `english`). |
| **`APP_DEV_MODE`** | `bool` | `True` | Development mode toggle. When `False`, `APP_API_TOKEN` is strictly mandatory at startup. |
| **`APP_AUTH_MODE`** | `str` | `"local"` | Authentication mode: `"local"` (local YAML credentials) or `"oauth_proxy"` (Zero-Trust reverse proxy headers). |
| **`APP_API_TOKEN`** | `SecretStr \| None` | `None` | Shared secret token required on `/api/v1/*` via `Authorization: Bearer <token>` or `X-API-Key`. Mandatory when `APP_DEV_MODE=false`. |
| **`APP_PROXY_SECRET`** | `SecretStr \| None` | `None` | Shared secret verified via `hmac.compare_digest` against the `X-MedSyntis-Proxy-Secret` header in `oauth_proxy` mode. |
| **`APP_ADMIN_USERS`** | `str` | `""` | Comma-separated usernames/emails granted admin rights (queue management, patient deletion). When empty in local dev, authenticated users have admin access. |
| **`APP_ALLOW_REMOTE_LLM`** | `bool` | `False` | Security guardrail: when `False` (default), `AppConfig` rejects any non-local/non-private LLM URL to guarantee patient data stays on-premise. |

### 2. Logging Settings (`APP_LOG_*`)

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`APP_LOG_LEVEL`** | `str` | `"INFO"` | Application log level (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`). |
| **`APP_LOG_TYPE`** | `str` | `"text"` | Log output format: `"text"` (human-readable) or `"json"` (structured JSON logs). |
| **`APP_LOG_SERVICE`** | `str` | Auto-detected (`"api"` / `"ui"` / `"app"`) | Runtime service tag injected into every log record. |
| **`APP_LOG_FILE`** | `str \| None` | `None` | Optional file path enabling `RotatingFileHandler`. |
| **`APP_LOG_MAX_BYTES`** | `int` | `10485760` (10 MB) | Maximum size in bytes before log file rotation. |
| **`APP_LOG_BACKUP_COUNT`** | `int` | `5` | Number of rotated log files retained on disk. |
| **`APP_LOG_LANGCHAINDEBUG`** | `bool` | `False` | Enable verbose internal LangChain debug logging. |

### 3. Local LLM & Inference Settings (`APP_CONFIGLLM_*`)

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`APP_CONFIGLLM_TYPE`** | `str` | `"LiteLLM"` | LLM backend type (`LiteLLM`, `Ollama`, `OpenAI`, `vLLM`). |
| **`APP_CONFIGLLM_URL`** | `str` | `"http://127.0.0.1"` | Base URL of the local LLM inference server or LiteLLM gateway. |
| **`APP_CONFIGLLM_URI`** | `str` | `"/"` | URI path prefix for OpenAI-compatible endpoints. |
| **`APP_CONFIGLLM_PORT`** | `str` | `"4000"` | TCP port of the LLM server (`4000` for LiteLLM, `11434` for Ollama). |
| **`APP_CONFIGLLM_MODELS`** | `str` | `"openai/agents"` | Model identifier used for clinical extraction and specialist reasoning. |
| **`APP_CONFIGLLM_OCRMODELS`** | `str` | `"granite3.2-vision"` | Vision-Language Model (VLM) identifier for local OCR tasks. |
| **`APP_CONFIGLLM_TEMP`** | `float` | `1.0` | Sampling temperature for LLM generation. |
| **`APP_CONFIGLLM_EMBEDDINGS`** | `str` | `"openai/embeddings"` | Embedding model identifier for vectorizing documents and guidelines. |
| **`APP_CONFIGLLM_EMBEDDINGS_PORT`** | `str` | `"4000"` | TCP port of the embeddings server. |
| **`APP_CONFIGLLM_REASONING`** | `bool` | `True` | Enable chain-of-thought / reasoning token streaming for LLM agents. |
| **`APP_CONFIGLLM_API_KEY`** | `str` | `"ollama"` | API key for the local LLM gateway (also accepts `LITELLM_API_KEY`, `OPENAI_API_KEY`, or `LLAMACPP_API_KEY`). |

### 4. Vector Store & Milvus Settings (`APP_DATABASESVECTORIAL_*` & `APP_MILVUSDB_*`)

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`APP_DATABASESVECTORIAL_TYPE`** | `str` | `"milvus"` | Vector database engine (`"milvus"` or `"chroma"`). |
| **`APP_DATABASESVECTORIAL_COLLECTION`** | `str` | `"medsyntisDocs"` | Base prefix for domain/embedding vector collections (`medsyntisDocs_{domain}_{embedding}`). |
| **`APP_MILVUSDB_HOST`** | `str` | `"localhost"` | Hostname or IP address of the Milvus Standalone server. |
| **`APP_MILVUSDB_PORT`** | `str` | `"19530"` | TCP port of the Milvus Standalone server. |
| **`APP_MILVUSDB_DATABASE`** | `str` | `"medsyntis"` | Target Milvus database name. |
| **`APP_MILVUSDB_TOKEN`** | `str` | `"root:Milvus"` | Milvus authentication credentials (`username:password`). |
| **`APP_MILVUSDB_SCHEME`** | `str` | `"http"` | Connection protocol scheme (`http` or `https`). |

### 5. MongoDB Settings (`APP_MONGODB_*`)

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`APP_MONGODB_HOST`** | `str` | `"127.0.0.1"` | Hostname or IP address of the MongoDB server. |
| **`APP_MONGODB_PORT`** | `str` | `"27017"` | TCP port of the MongoDB server. |
| **`APP_MONGODB_USER`** | `str` | `"root"` | MongoDB authentication username. |
| **`APP_MONGODB_PASSWORD`** | `str` | `"root"` | MongoDB authentication password. |
| **`APP_MONGODB_DATABASE`** | `str` | `"MedSyntis"` | Base name for domain-scoped metadata databases (`MedSyntis_{domain}`). |
| **`APP_MONGODB_VECTORDATABASE`** | `str` | `"MedSyntisVector"` | Base name for MongoDB vector storage (`MedSyntisVector_{domain}`). |

### 6. MDT / RCP Document Pipeline Settings (`APP_RCP_*`)

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`APP_RCP_PATH`** | `Path` | `"ressources/PatientMDTForm"` | Base directory storing patient MDT PDF records (automatically scoped per domain: `ressources/PatientMDTForm/{domain}`). |
| **`APP_RCP_ADDITIONAL_PATH`** | `Path` | `"ressources/documents"` | Base directory storing scientific reference PDFs such as TNCD and PNDS (`ressources/documents/{domain}`). |
| **`APP_RCP_DOC_TYPE`** | `str` | `"docling"` | Document layout parser (`docling`, `pymupdf`, `pypdf`, `openparse`, `ollama-ocr`). |
| **`APP_RCP_DOCLING_DEVICE`** | `str` | `"cpu"` | Hardware execution device for Docling layout inference (`cpu`, `cuda`, `mps`, `auto`). Keep on `cpu` to reserve GPU VRAM for the LLM. |
| **`APP_RCP_CHUNK_SIZE`** | `int` | `1000` | Maximum character length per text chunk during vector ingestion. |
| **`APP_RCP_CHUNK_OVERLAP`** | `int` | `150` | Character overlap between consecutive text chunks. |
| **`APP_RCP_MANUAL_QUERY`** | `bool` | `False` | Enable interactive CLI query debugging mode. |
| **`APP_RCP_DISPLAY_TYPE`** | `str` | `"mongodb"` | Persistence backend for the UI/API (`mongodb`). |

### 7. GPU PriorityQueue Settings (`APP_QUEUE_*`)

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`APP_QUEUE_ENABLED`** | `bool` | `True` | Enable asynchronous background processing via `PriorityQueue`. |
| **`APP_QUEUE_HARDWARE_PROFILE`** | `str` | `"l4_24gb"` | Hardware concurrency preset (`l4_24gb` -> 1 worker, `a100_80gb` -> 4 workers, `cpu_only` -> 1 worker, `custom`). |
| **`APP_QUEUE_BATCH_SIZE`** | `int` | `1` | Maximum concurrent MDT files processed in parallel by the worker pool. |
| **`APP_QUEUE_MAX_RETRIES`** | `int` | `2` | Maximum automatic retries when an extraction job fails. |
| **`APP_QUEUE_API_URL`** | `str` | `"http://127.0.0.1:8000"` | URL of the Cross-Domain FastAPI service hosting the central `PriorityQueue`. |

### 8. FastAPI Server & HTTP Security Settings (`APP_API_*`)

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`APP_API_HOST`** | `str` | `"127.0.0.1"` | Bind address for Uvicorn (`127.0.0.1` by default; `0.0.0.0` inside private container networks). |
| **`APP_API_PORT`** | `int` | `8000` | Listening TCP port for the FastAPI server. |
| **`APP_API_WORKERS`** | `int` | `1` | Number of Uvicorn worker processes (keep at `1` when using the integrated in-process `PriorityQueue`). |
| **`APP_API_DOCS_ENABLED`** | `bool` | `True` | Enable `/docs`, `/redoc`, and `/api/v1/openapi.json`. |
| **`APP_API_DOCS_REQUIRE_AUTH`** | `bool` | `False` | Require `APP_API_TOKEN` authentication on `/docs`, `/redoc`, and `/api/v1/openapi.json`. |
| **`APP_API_CORS_ENABLED`** | `bool` | `True` | Enable `CORSMiddleware`. |
| **`APP_API_CORS_ORIGINS`** | `str` | `"http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:8501,http://localhost:8501"` | Comma-separated list of allowed CORS origins. |
| **`APP_API_CORS_ALLOW_CREDENTIALS`** | `bool` | `True` | Allow credentials and `Authorization` headers in CORS requests. |
| **`APP_API_CORS_ALLOW_METHODS`** | `str` | `"GET,POST,PUT,PATCH,DELETE,OPTIONS"` | Allowed HTTP methods for CORS. |
| **`APP_API_CORS_ALLOW_HEADERS`** | `str` | `"Authorization,Content-Type,X-API-Key,X-MedSyntis-Domain,..."` | Allowed HTTP request headers for CORS. |
| **`APP_API_TRUSTED_HOSTS`** | `str` | `"*"` | Comma-separated allowed `Host` header patterns for `TrustedHostMiddleware`. |
| **`APP_API_SECURITY_HEADERS_ENABLED`** | `bool` | `True` | Inject strict hospital-grade security headers (`CSP`, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Cache-Control: no-store`, `HSTS`). |
| **`APP_API_MAX_BODY_BYTES`** | `int` | `52428800` (50 MB) | Maximum request body size before rejecting with `HTTP 413 Content Too Large`. |
| **`APP_API_RATE_LIMIT_ENABLED`** | `bool` | `False` | Enable sliding-window per-IP rate limiting (`HTTP 429`). |
| **`APP_API_RATE_LIMIT_REQUESTS`** | `int` | `300` | Maximum requests allowed per IP within `APP_API_RATE_LIMIT_WINDOW_SECONDS`. |
| **`APP_API_RATE_LIMIT_WINDOW_SECONDS`** | `int` | `60` | Sliding-window duration in seconds for rate limiting. |

---

## 🌐 Material Design 3 Web UI Environment Variables (`web/src/config.ts`)

The Node.js Fastify 5 BFF server (`web/`) validates its environment configuration via Zod (`web/src/config.ts`):

| Environment Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`PORT_WEB`** | `int` | `3000` | Listening TCP port for the Fastify 5 Web UI server (fallback: `PORT`). |
| **`HOST_WEB`** | `str` | `"127.0.0.1"` | Bind address for the Fastify server (`127.0.0.1` in local dev, `0.0.0.0` in Docker). |
| **`APP_API_URL`** | `str` | `"http://127.0.0.1:8000"` | Upstream Python FastAPI base URL (fallback: `APP_QUEUE_API_URL`). |
| **`APP_API_TOKEN`** | `str` | `""` | Shared Bearer token sent to the FastAPI backend (`Authorization: Bearer <token>`). |
| **`APP_DOMAIN`** | `str` | `"oncology"` | Default clinical domain (`oncology` or `sma`). |
| **`APP_ALLOWED_DOMAINS`** | `str` | `"oncology,sma"` | Comma-separated list of enabled clinical domains. |
| **`APP_AUTH_MODE`** | `str` | `"local"` | Authentication mode: `"local"` or `"oauth_proxy"`. |
| **`APP_PROXY_SECRET`** | `str` | `""` | Shared secret verified on incoming proxy requests and forwarded to FastAPI via `X-MedSyntis-Proxy-Secret`. |
| **`APP_ADMIN_USERS`** | `str` | `""` | Comma-separated list of usernames/emails granted admin privileges in the Web UI. |
| **`WEB_FAKE_API_FALLBACK`** | `bool` | `false` | When `true`, enables fallback to `InMemoryMedsyntisApiFake` if FastAPI is unreachable. Disabled (`false`) by default so the Web UI connects strictly to the real backend. |
| **`APP_USE_FAKE_ONLY`** | `bool` | `false` | When `true`, forces the Web UI to use `InMemoryMedsyntisApiFake` exclusively (used for automated Vitest & Playwright suites). |
| **`APP_LANGUAGE`** | `str` | `"fr"` | Default UI locale (`"fr"` or `"en"`). |
| **`APP_THEME`** | `str` | `"auto"` | Default WCAG 2.2 AA color theme (`"auto"`, `"light"`, or `"dark"`). |

---

## 🔐 Authentication & Zero-Trust Security Architecture

MedSyntis supports two authentication modes configured via `APP_AUTH_MODE`:

### 1. Local Authentication Mode (`APP_AUTH_MODE="local"`)
Used for local development and standalone hospital intranet deployments:
* **Configuration Files**:
  * Production / standard local credentials: `application/config/auth_config.yaml`
  * Development credentials (`APP_DEV_MODE=true`): `application/config/auth_config_dev.yaml`
* **User Management Script**: Passwords are hashed using **Bcrypt**. You can add or update local users interactively using `application/scripts/add_user.py`:
  ```bash
  cd application
  uv run python scripts/add_user.py
  ```

### 2. Zero-Trust Reverse Proxy SSO Mode (`APP_AUTH_MODE="oauth_proxy"`)
Used in production Docker stacks (`dist/docker/compose/docker-compose.prod.yml`) behind **Caddy TLS** and **OAuth2-Proxy**:
1. **Caddy (`dist/docker/compose/Caddyfile`)** terminates TLS (`https://oncologic.<domain>` and `https://sma.<domain>`) and authenticates every request against `oauth2-proxy` via `forward_auth`.
2. Upon successful SSO authentication, Caddy strips any client-supplied identity headers and injects trusted headers:
   * `X-MedSyntis-User` (authenticated email/username)
   * `X-MedSyntis-User-Name` (display name)
   * `X-MedSyntis-Proxy-Secret` (shared secret matching `APP_PROXY_SECRET`)
   * `X-MedSyntis-Domain` (`oncology` or `sma` derived from the virtual host)
3. Both the Fastify BFF (`web/`) and FastAPI (`application/src/routers/dependencies.py`) verify `X-MedSyntis-Proxy-Secret` in constant time (`hmac.compare_digest`) before trusting user identity or granting `require_admin` privileges.
