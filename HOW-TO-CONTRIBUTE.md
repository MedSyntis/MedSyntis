# 🤝 Contributor & Development Guide — MedSyntis

Thank you for your interest in contributing to **MedSyntis**! MedSyntis is an open-source, 100% local-first clinical synthesis assistant designed to help healthcare professionals prepare and run Multidisciplinary Team Meetings (**MDT / RCP**) in **Digestive Oncology (TNCD)** and **Spinal Muscular Atrophy — SMA (PNDS)**.

To join the community and start contributing:
1. Join our official Discord server: [Join the MedSyntis Discord Community](https://discord.gg/C2RPhyn9x8)
2. Introduce yourself in the `#ask-to-join` channel so we can grant contributor permissions.

---

## 📋 Contribution Workflow

1. **Find or Open an Issue**: Pick an existing GitHub Issue (Story, Feature, or Bug) or open a new one using our 100% English issue templates (`.github/ISSUE_TEMPLATE/`).
2. **Branching Convention**: Create a dedicated branch from `main` using a descriptive prefix (`feature/short-description`, `fix/short-description`, `docs/short-description`).
3. **Architecture & Ubiquitous Language**:
   * Follow **Domain-Driven Design (DDD)** and **Hexagonal / Clean Architecture** boundaries across both `application/` (Python) and `web/` (TypeScript).
   * Write **100% English** code identifiers, comments, docstrings, and commit messages.
   * Use the Ubiquitous Language term **`PatientMDTForm`** (`patient_mdt_form` / `mdt_form`) in code identifiers and domain models.
   * Target **`web/` (Material Design 3 Fastify Web UI)** for all new frontend features—`web/` is the **primary clinical interface**, whereas `application/src/ui/` (`application/app-ui.py`, Streamlit) is **deprecated / legacy**.
   * Never import `streamlit` outside `application/src/ui/` and `application/app-ui.py`.
4. **Test-Driven Development (TDD)**: Follow the `Red -> Green -> Refactor` cycle and ensure all linters, type checks, unit tests, WCAG contrast checks, E2E tests, and `prek` hooks pass before opening a Pull Request.

---

## 🛡️ Golden Rules for Contributors

> [!CAUTION] **Strict Patient Data Privacy (100% Local-First Execution)**
> * **Never call external cloud APIs** (such as OpenAI, Anthropic, Google Cloud, or hosted embedding services) in production code.
> * All document parsing, OCR, vector indexing, and LLM reasoning must run **100% locally** via local Docker services (Milvus, MongoDB) and local LLM inference servers (LiteLLM + `llama.cpp` / `Ollama`).
> * `AppConfig` enforces local-only LLM hosts by default (`APP_ALLOW_REMOTE_LLM=False`).

---

## 💻 Prerequisites

Make sure the following tools are installed on your workstation:

* **Python**: **`>=3.13`** (strictly enforced in `application/pyproject.toml`).
* **Python Package Manager**: [**`uv`**](https://github.com/astral-sh/uv) for fast, deterministic dependency management (`uv.lock`).
* **Node.js**: **`>=26`** (with `npm`) for the Material Design 3 Web UI (`web/`).
* **Containers**: **Docker** & **Docker Compose** (with `nvidia-container-toolkit` if running GPU inference inside Docker).
* **Hardware Recommendation**: A dedicated NVIDIA GPU with at least **12 GB to 24 GB VRAM** (e.g., NVIDIA L4 24 GB) is recommended for local LLM reasoning, or a CPU-only setup / local `WEB_FAKE_API_FALLBACK=true` mode for frontend and API development.

---

## 🚀 1. Quickstart with `Makefile` (Recommended)

From the **repository root**, the `Makefile` automates environment initialization, Docker orchestration, and service startup:

```bash
# 1. Install Python (uv sync) & Node.js (npm) dependencies, prepare Docker volumes, and initialize Milvus v3.0
make init

# 2. Start local infrastructure containers (Milvus Standalone on :19530 + MongoDB Replica Set on :27017)
make docker-up

# 3. Start the Cross-Domain FastAPI backend (:8000) + Material Design 3 Web UI (:3000)
make start-web

# (Optional) Start the Cross-Domain FastAPI backend (:8000) + Legacy Streamlit UI (:8501)
make start-ui

# 4. Check the live status of all local ports and services
make status

# 5. Stop all running application processes and Docker containers
make stop
```

---

## 🐳 2. Manual Infrastructure & Dependency Setup

If you prefer running each step manually without `make`:

### A. Start Milvus Standalone & MongoDB via Docker Compose
From the repository root:

```bash
# Prepare local volume directories
mkdir -p dist/docker/compose/volumes/{mongodb,mongodb_config,milvus,etcd,minio,logs}

# 1. Start Milvus Standalone (etcd + minio + milvus-standalone on port 19530)
docker compose -f dist/docker/compose/milvus-standalone-docker-compose.yml up -d

# 2. Start MongoDB Replica Set (port 27017) and optional local LLM containers
docker compose -f dist/docker/compose/docker-compose.yml up -d
```

Verify that the containers are healthy:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### B. Install Python Dependencies (`application/`)
```bash
cd application
uv sync
```

### C. Install Node.js Dependencies (`web/`)
From the repository root:
```bash
npm --prefix web ci
```

---

## 🤖 3. Local LLM Setup (LiteLLM Gateway + `llama.cpp` / `Ollama`)

By default, MedSyntis connects to an OpenAI-compatible **LiteLLM Gateway** on `http://127.0.0.1:4000` (or directly to a local **Ollama** instance on `http://127.0.0.1:11434`), configured via `APP_CONFIGLLM_*` environment variables.

### Option A: Default LiteLLM Gateway + `llama.cpp` (Port `4000`)
In production and full-stack Docker environments (`dist/docker/compose/docker-compose.yml` with `--profile llamacpp` or `docker-compose.prod.yml`), LiteLLM routes requests on port `4000` to:
* `openai/agents` (`APP_CONFIGLLM_MODELS="openai/agents"`): Local `llama.cpp` reasoning server (e.g., `Ornith-1.5-35B-A3B-IQ4_XS.gguf`).
* `openai/embeddings` (`APP_CONFIGLLM_EMBEDDINGS="openai/embeddings"`): Local CPU/GPU `llama.cpp` embedding server (`bge-m3-Q4_K_M.gguf`).

### Option B: Local Native Ollama (Port `11434`)
If you run a native **Ollama** server locally:
1. Pull the recommended models:
   ```bash
   make pull-models
   # Equivalent to:
   ollama pull nomic-embed-text
   ollama pull granite3.2-vision
   ollama pull mistral-nemo
   ```
2. Export the `APP_CONFIGLLM_*` variables when starting FastAPI or Streamlit:
   ```bash
   export APP_CONFIGLLM_TYPE="Ollama"
   export APP_CONFIGLLM_URL="http://127.0.0.1"
   export APP_CONFIGLLM_PORT="11434"
   export APP_CONFIGLLM_MODELS="mistral-nemo"
   export APP_CONFIGLLM_OCRMODELS="granite3.2-vision"
   export APP_CONFIGLLM_EMBEDDINGS="nomic-embed-text"
   export APP_CONFIGLLM_EMBEDDINGS_PORT="11434"
   ```

| Application Role | Environment Variable | Default (`LiteLLM` on `:4000`) | Local `Ollama` Example (`:11434`) |
| :--- | :--- | :--- | :--- |
| **LLM Backend Type** | `APP_CONFIGLLM_TYPE` | `LiteLLM` | `Ollama` |
| **LLM Server URL** | `APP_CONFIGLLM_URL` | `http://127.0.0.1` | `http://127.0.0.1` |
| **LLM Server Port** | `APP_CONFIGLLM_PORT` | `4000` | `11434` |
| **Clinical Reasoning** | `APP_CONFIGLLM_MODELS` | `openai/agents` | `mistral-nemo` |
| **Vision & Local OCR** | `APP_CONFIGLLM_OCRMODELS` | `granite3.2-vision` | `granite3.2-vision` |
| **Vector Embeddings** | `APP_CONFIGLLM_EMBEDDINGS` | `openai/embeddings` | `nomic-embed-text` |
| **Reasoning Mode** | `APP_CONFIGLLM_REASONING` | `True` | `True` |

---

## 🖥️ 4. Running the Application Servers

### A. Cross-Domain FastAPI Backend (`application/app-api.py`)
```bash
cd application
uv run python app-api.py
# Or with auto-reload during API development:
uv run uvicorn app-api:app --reload --host 127.0.0.1 --port 8000
```
* Interactive Swagger UI: `http://127.0.0.1:8000/docs`
* OpenAPI v3 JSON Schema: `http://127.0.0.1:8000/api/v1/openapi.json`

### B. Material Design 3 Web UI (`web/` — Primary Clinical Interface)
1. **Connected to the Live FastAPI Backend (`http://127.0.0.1:8000`)**:
   ```bash
   npm --prefix web run dev
   ```
   Open **`http://127.0.0.1:3000`** in your browser.
2. **Standalone Frontend Development Mode (Without FastAPI / Docker)**:
   Set `WEB_FAKE_API_FALLBACK=true` (or `APP_USE_FAKE_ONLY=true`) to use the deterministic in-memory clinical fixture adapter (`InMemoryMedsyntisApiFake`) covering both Digestive Oncology and SMA:
   ```bash
   WEB_FAKE_API_FALLBACK=true npm --prefix web run dev
   ```

### C. Legacy Streamlit Dashboard (`application/app-ui.py` — Deprecated)
> [!NOTE]
> The Streamlit dashboard (`application/src/ui/`) is **deprecated** in favor of the Material Design 3 Web UI (`web/`) and is kept only for legacy compatibility.

```bash
cd application
uv run streamlit run app-ui.py --server.port=8501
```
Open **`http://localhost:8501`** in your browser.

---

## ✅ 5. Quality Gates & Automated Test Suites

Every Pull Request must pass all Python and Web UI quality gates:

### A. Python Backend Quality Gates (`application/`)
```bash
# 1. Lint Python code with Ruff
cd application && uv run ruff check src/

# 2. Check / apply PEP8 formatting with Ruff
cd application && uv run ruff format --check src/

# 3. Run static type checking with Pyrefly
cd application && uv run pyrefly check

# 4. Run the full Pytest unit & integration test suite
cd application && uv run pytest
```

### B. Material Design 3 Web UI Quality Gates (`web/`)
```bash
# 1. Run Biome linter, TypeScript typechecker (tsc --noEmit), and WCAG 2.2 AA contrast audit
npm --prefix web run lint

# 2. Run Vitest unit & Fastify BFF integration tests
npm --prefix web run test

# 3. Run Playwright End-to-End (E2E) clinical & mobile journeys
npm --prefix web run e2e
```

### C. Pre-Commit Hooks (`prek`)
Run all repository hooks (Ruff, Biome, formatting, and secret checks) before committing:
```bash
prek run
# Or across all repository files:
make hooks-all
```

---

## 📚 Further Reading

* [🩺 Clinical User Guide (`docs/guide_clinique.md`)](docs/guide_clinique.md)
* [💻 Technical Architecture & Configuration Reference (`docs/guide_technique.md`)](docs/guide_technique.md)
* [🔌 REST & SSE API v1 Specification (`docs/api/endpoints.md`)](docs/api/endpoints.md)
* [🎨 Material Design 3 Web UI Design System (`web/docs/design-system.md`)](web/docs/design-system.md)
* [🤖 AI Agent & DDD Guidelines (`AGENTS.md`)](AGENTS.md)
