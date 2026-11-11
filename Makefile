# ==============================================================================
# MedSyntis Makefile
# Service orchestration, local development, quality gates, and production ops
# ==============================================================================

SHELL := /bin/bash
export PATH := $(HOME)/.local/bin:$(HOME)/google-cloud-sdk/bin:$(PATH)

# Detect uv, gcloud, and current deploy user (member of the 'docker' group)
UV := $(shell command -v uv 2>/dev/null || echo $(HOME)/.local/bin/uv)
GCLOUD := $(shell command -v gcloud 2>/dev/null || echo $(HOME)/google-cloud-sdk/bin/gcloud)
DEPLOY_USER ?= $(shell id -un)

# Workspace directories
APP_DIR := application
WEB_DIR := web

# Configurable host/port settings
PORT_UI ?= 8501
PORT_WEB ?= 3000
HOST_WEB ?= 127.0.0.1
PORT_API ?= 8000
HOST_API ?= 127.0.0.1
CLOUDRUN_SERVICE ?= llama-cpp-chat
CLOUDRUN_PORT ?= 8080

# Production configuration (NVIDIA L4 24G — Multi-Domain oncology & sma)
ENV_PROD ?= $(CURDIR)/.env.prod
PROD_BASE_DOMAIN ?= medsyntis.fr
COMPOSE_MILVUS := dist/docker/compose/milvus-standalone-docker-compose.yml
COMPOSE_DEV := dist/docker/compose/docker-compose.yml
COMPOSE_PROD := dist/docker/compose/docker-compose.prod.yml
DEV_VOLUME_DIR ?= $(CURDIR)/dist/docker/compose/volumes
DOCKER_VOLUME_DIRECTORY ?= $(shell grep -E '^DOCKER_VOLUME_DIRECTORY=' "$(ENV_PROD)" 2>/dev/null | cut -d= -f2 || echo /data/medsyntis/common)
MODELS_DIR ?= $(DOCKER_VOLUME_DIRECTORY)/models
BACKUP_DIR ?= /data/medsyntis/backups
CHAT_MODEL_URL := https://huggingface.co/bartowski/Ornith-1.5-35B-A3B-GGUF/resolve/main/Ornith-1.5-35B-A3B-IQ4_XS.gguf
CHAT_MODEL_FILE := $(MODELS_DIR)/Ornith-1.5-35B-A3B-IQ4_XS.gguf
EMBED_MODEL_URL := https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf
EMBED_MODEL_FILE := $(MODELS_DIR)/bge-m3-Q4_K_M.gguf

# Terminal colors
CYAN  := \033[36m
GREEN := \033[32m
YELLOW:= \033[33m
RED   := \033[31m
RESET := \033[0m

.DEFAULT_GOAL := help

.PHONY: help init update install install-web upgrade upgrade-web start-api start-ui start-web start-worker start-ui-dev start-web-dev start-dev cloudrun-proxy cloudrun-proxy-stop stop test test-web coverage lint lint-web format format-web hooks hooks-all e2e-web build-web docker-build-api docker-build-ui docker-build-web mongo-init docker-up docker-up-proxy docker-down docker-update docker-status pull-models clean status get-bugs patient-id-migrate api ui web worker ui-dev web-dev proxy proxy-stop dev init-prod sudoers-prod pull-models-prod logrotate-prod mongo-init-prod build-prod docker-up-prod docker-down-prod start-prod start-prod-st stop-prod restart-prod prod-update prod-update-all status-prod logs-prod backup-prod up-prod down-prod prod pprod

## Show available Makefile targets
help:
	@echo -e "$(CYAN)Usage: make <target>$(RESET)"
	@echo ""
	@echo -e "$(GREEN)Development Targets:$(RESET)"
	@echo -e "  $(YELLOW)make init$(RESET)                Initialize full dev environment (uv sync + npm ci + volumes + Milvus v3.0 init)"
	@echo -e "  $(YELLOW)make update$(RESET)              Upgrade Python/Node.js packages and Docker images (Milvus v3.0, MongoDB)"
	@echo -e "  $(YELLOW)make install$(RESET)             Install Python dependencies via uv sync"
	@echo -e "  $(YELLOW)make install-web$(RESET)         Install locked Node.js dependencies for the M3 Web UI (npm ci)"
	@echo -e "  $(YELLOW)make upgrade$(RESET)             Upgrade all Python (uv) and Node.js (npm) dependencies"
	@echo -e "  $(YELLOW)make upgrade-web$(RESET)         Upgrade Node.js dependencies in $(WEB_DIR)/"
	@echo -e "  $(YELLOW)make start-api$(RESET)           Start Cross-Domain FastAPI server (port $(PORT_API))"
	@echo -e "  $(YELLOW)make start-web$(RESET)           Start Cross-Domain FastAPI + Primary M3 Web UI Fastify server (port $(PORT_WEB))"
	@echo -e "  $(YELLOW)make start-ui$(RESET)            Start Cross-Domain FastAPI + Legacy Streamlit UI (port $(PORT_UI))"
	@echo -e "  $(YELLOW)make start-web-dev$(RESET)       Start Docker proxy stack + Cloud Run benchmark proxy (requires APP_ALLOW_REMOTE_LLM=true) + Web UI"
	@echo -e "  $(YELLOW)make start-ui-dev$(RESET)        Start Docker proxy stack + Cloud Run benchmark proxy (requires APP_ALLOW_REMOTE_LLM=true) + Legacy Streamlit"
	@echo -e "  $(YELLOW)make cloudrun-proxy$(RESET)      Start background Cloud Run proxy on port $(CLOUDRUN_PORT) (synthetic data only; requires APP_ALLOW_REMOTE_LLM=true)"
	@echo -e "  $(YELLOW)make cloudrun-proxy-stop$(RESET) Stop Cloud Run proxy"
	@echo -e "  $(YELLOW)make stop$(RESET)                Stop Web/Streamlit UI, FastAPI, Cloud Run proxy, and local Docker services"
	@echo ""
	@echo -e "$(GREEN)Production Targets (NVIDIA L4 24G + Zero-Trust SSO + Multi-Domain):$(RESET)"
	@echo -e "  $(YELLOW)make init-prod$(RESET)           Initialize production host (sudoers, .env.prod, volumes, Milvus v3.0, logrotate, GGUF models)"
	@echo -e "  $(YELLOW)make sudoers-prod$(RESET)        Validate and install /etc/sudoers.d/medsyntis (mode 0440) for $(DEPLOY_USER)"
	@echo -e "  $(YELLOW)make logrotate-prod$(RESET)      Generate and install /etc/logrotate.d/medsyntis for $(DOCKER_VOLUME_DIRECTORY)/logs"
	@echo -e "  $(YELLOW)make pull-models-prod$(RESET)    Download Ornith-1.5-35B-A3B-IQ4_XS.gguf and bge-m3-Q4_K_M.gguf into $(MODELS_DIR)"
	@echo -e "  $(YELLOW)make start-prod$(RESET)          Start prod stack (Milvus, Mongo, L4 LLM, M3 Web UI oncology/sma, OAuth2 Proxy, Caddy)"
	@echo -e "  $(YELLOW)make start-prod-st$(RESET)       Start prod stack + optional legacy Streamlit services (oncologic-st/sma-st)"
	@echo -e "  $(YELLOW)make stop-prod$(RESET)           Stop all production containers (preserving persistent data volumes)"
	@echo -e "  $(YELLOW)make restart-prod$(RESET)        Restart Web M3, API, LiteLLM, OAuth2 Proxy, and Caddy without unloading GPU VRAM"
	@echo -e "  $(YELLOW)make prod-update$(RESET)         git pull + update Milvus & app images + hot-recreate containers while keeping LLM in VRAM"
	@echo -e "  $(YELLOW)make prod-update-all$(RESET)     Full update of the entire production Docker stack (including LLM & infra)"
	@echo -e "  $(YELLOW)make backup-prod$(RESET)         Create encrypted-ready compressed backup of MongoDB (mongodump) and Milvus/domain volumes"
	@echo -e "  $(YELLOW)make status-prod$(RESET)         Display production service health, LLM readiness, and NVIDIA L4 VRAM usage"
	@echo -e "  $(YELLOW)make logs-prod$(RESET)           Stream real-time logs from the production stack"
	@echo ""
	@echo -e "$(GREEN)Quality & Test Targets:$(RESET)"
	@echo -e "  $(YELLOW)make test$(RESET)                Run Python unit & integration tests (Pytest on $(APP_DIR)/tests/)"
	@echo -e "  $(YELLOW)make test-web$(RESET)            Run Vitest unit & integration tests in $(WEB_DIR)/"
	@echo -e "  $(YELLOW)make coverage$(RESET)            Run Pytest coverage report against $(APP_DIR)/tests/"
	@echo -e "  $(YELLOW)make lint$(RESET)                Check Python code with Ruff"
	@echo -e "  $(YELLOW)make lint-web$(RESET)            Check $(WEB_DIR)/ TypeScript/CSS with Biome, tsc --noEmit, and WCAG contrast audit"
	@echo -e "  $(YELLOW)make format$(RESET)              Format Python code with Ruff"
	@echo -e "  $(YELLOW)make format-web$(RESET)          Format $(WEB_DIR)/ code with Biome"
	@echo -e "  $(YELLOW)make hooks$(RESET)               Run Git pre-commit hooks (prek) on staged/modified files"
	@echo -e "  $(YELLOW)make hooks-all$(RESET)           Run all Git pre-commit hooks (prek) across the entire repository"
	@echo -e "  $(YELLOW)make e2e-web$(RESET)             Run Playwright E2E clinical & mobile journeys in $(WEB_DIR)/"
	@echo -e "  $(YELLOW)make get-bugs$(RESET)            Fetch and display bug reports stored in MongoDB"
	@echo -e "  $(YELLOW)make patient-id-migrate$(RESET)  Migrate legacy cleartext patient_id slugs in MongoDB to SHA-256 IDs (DRY_RUN=1 to preview)"
	@echo ""
	@echo -e "$(GREEN)Infrastructure & Local Ollama Targets:$(RESET)"
	@echo -e "  $(YELLOW)make docker-up$(RESET)           Start local Milvus Standalone and MongoDB via Docker Compose"
	@echo -e "  $(YELLOW)make docker-up-proxy$(RESET)     Start local Docker stack in proxy mode (Milvus + MongoDB + embeddings)"
	@echo -e "  $(YELLOW)make docker-update$(RESET)       Pull latest local Docker images (Milvus v3.0, MongoDB) and recreate running containers"
	@echo -e "  $(YELLOW)make docker-down$(RESET)         Stop local Milvus and MongoDB containers"
	@echo -e "  $(YELLOW)make docker-status$(RESET)       Show running Docker containers and port mappings"
	@echo -e "  $(YELLOW)make pull-models$(RESET)         Pull recommended local Ollama models"
	@echo -e "  $(YELLOW)make status$(RESET)              Show listening status of all local MedSyntis ports"
	@echo -e "  $(YELLOW)make clean$(RESET)               Remove Python/Web build and test caches"
	@echo ""

## Initialize local development environment (Python & Node.js dependencies, least-privilege volumes, Milvus v3.0 init)
init: install install-web
	@echo -e "$(CYAN)--> Preparing local development Docker volume directories ($(DEV_VOLUME_DIR))...$(RESET)"
	@mkdir -p $(DEV_VOLUME_DIR)/{mongodb,mongodb_config,milvus,etcd,minio,logs}
	@chmod 750 $(DEV_VOLUME_DIR)/{mongodb,mongodb_config,milvus,etcd,minio,logs} 2>/dev/null || true
	@echo -e "$(CYAN)--> Pulling Docker images (Milvus v3.0 & MongoDB) and initializing Milvus volume ownership...$(RESET)"
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_MILVUS) pull
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_MILVUS) run --rm milvus-volume-init
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_DEV) pull
	@echo -e "$(GREEN)--> Development environment initialization complete.$(RESET)"

## Upgrade Python (uv) & Node.js (npm) dependencies as well as local Docker images (Milvus v3.0, MongoDB)
update: upgrade docker-update
	@echo -e "$(GREEN)--> Full update (Python/Node.js packages + Docker infrastructure) complete.$(RESET)"

## Install Python virtual environment, locked dependencies, and Git hooks
install:
	@echo -e "$(CYAN)--> Installing Python dependencies via uv sync...$(RESET)"
	cd $(APP_DIR) && $(UV) sync
	@if [ -d .git ]; then \
		if command -v prek >/dev/null 2>&1; then \
			prek install -f >/dev/null 2>&1 || true; \
		elif [ -x $(APP_DIR)/.venv/bin/prek ]; then \
			$(APP_DIR)/.venv/bin/prek install -f >/dev/null 2>&1 || true; \
		else \
			$(UV) run --project $(APP_DIR) prek install -f >/dev/null 2>&1 || true; \
		fi; \
	fi

## Install locked Node.js dependencies for the Material Design 3 Web UI
install-web:
	@echo -e "$(CYAN)--> Installing locked Node.js dependencies for Web UI ($(WEB_DIR))...$(RESET)"
	npm ci --prefix $(WEB_DIR)

## Upgrade Node.js dependencies in web/
upgrade-web:
	@echo -e "$(CYAN)--> Upgrading Node.js dependencies for Web UI ($(WEB_DIR))...$(RESET)"
	npm update --prefix $(WEB_DIR)

## Upgrade all Python and Node.js packages and synchronize lockfiles
upgrade: upgrade-web
	@echo -e "$(CYAN)--> Upgrading Python packages via uv lock --upgrade && uv sync...$(RESET)"
	cd $(APP_DIR) && $(UV) lock --upgrade && $(UV) sync

## Start the Cross-Domain FastAPI server (with integrated PriorityQueue worker)
start-api:
	@echo -e "$(CYAN)--> Starting Cross-Domain FastAPI server on http://$(HOST_API):$(PORT_API)...$(RESET)"
	cd $(APP_DIR) && $(UV) run python app-api.py

## Start Cross-Domain FastAPI (integrated Queue) and Legacy Streamlit UI
start-ui:
	@echo -e "$(CYAN)--> Starting Cross-Domain FastAPI and Legacy Streamlit UI on http://localhost:$(PORT_UI)...$(RESET)"
	@pkill -f "[p]ython.*app-api.py" 2>/dev/null || true
	@cd $(APP_DIR); \
	unset VIRTUAL_ENV; \
	export PYTHONUNBUFFERED=1; \
	export APP_QUEUE_API_URL=http://127.0.0.1:$(PORT_API); \
	$(UV) run python -u app-api.py & \
	API_PID=$$!; \
	trap "kill $$API_PID 2>/dev/null || true" INT TERM EXIT; \
	$(UV) run streamlit run app-ui.py --server.port=$(PORT_UI)

## Start Cross-Domain FastAPI (background) and Primary M3 Web UI Fastify server on http://localhost:$(PORT_WEB)
start-web:
	@echo -e "$(CYAN)--> Starting Cross-Domain FastAPI and M3 Web UI Fastify server on http://localhost:$(PORT_WEB)...$(RESET)"
	@pkill -f "[p]ython.*app-api.py" 2>/dev/null || true
	@pkill -f "[t]sx.*src/main.ts" 2>/dev/null || true
	@unset VIRTUAL_ENV; \
	export PYTHONUNBUFFERED=1; \
	export APP_QUEUE_API_URL=http://127.0.0.1:$(PORT_API); \
	(cd $(APP_DIR) && $(UV) run python -u app-api.py) & \
	API_PID=$$!; \
	trap "kill $$API_PID 2>/dev/null || true" INT TERM EXIT; \
	WEB_FAKE_API_FALLBACK=false APP_API_URL=http://127.0.0.1:$(PORT_API) PORT_WEB=$(PORT_WEB) HOST_WEB=$(HOST_WEB) npm --prefix $(WEB_DIR) run dev

## Alias start-worker to start-api (the PriorityQueue worker runs in-process inside app-api.py)
start-worker: start-api

## Start Legacy Streamlit UI connected to Cloud Run benchmark proxy (synthetic data only; requires APP_ALLOW_REMOTE_LLM=true)
start-ui-dev:
	@if [ "$(APP_ALLOW_REMOTE_LLM)" != "true" ]; then \
		echo -e "  [$(RED)GDPR/HDS BLOCK$(RESET)] Remote Cloud Run LLM proxy requires explicit APP_ALLOW_REMOTE_LLM=true."; \
		echo -e "  [$(RED)WARNING$(RESET)] NEVER use Cloud Run proxy with real patient data (PHI). Use synthetic data only."; \
		exit 1; \
	fi
	@$(MAKE) cloudrun-proxy APP_ALLOW_REMOTE_LLM=true
	@$(MAKE) docker-up-proxy
	@echo -e "$(CYAN)--> Checking llama.cpp health over Cloud Run proxy (http://127.0.0.1:$(CLOUDRUN_PORT)/health)...$(RESET)"
	@READY=0; \
	for i in {1..15}; do \
		if curl -sf "http://127.0.0.1:$(CLOUDRUN_PORT)/health" >/dev/null 2>&1; then \
			READY=1; \
			echo -e "  [$(GREEN)READY$(RESET)] Remote llama.cpp healthcheck succeeded."; \
			break; \
		fi; \
		sleep 1; \
	done; \
	if [ $$READY -eq 0 ]; then \
		echo -e "  [$(YELLOW)WARNING$(RESET)] llama.cpp has not answered /health yet (cold-start model loading may still be in progress)."; \
	fi
	@APP_ALLOW_REMOTE_LLM=true \
	APP_CONFIGLLM_TYPE=litellm \
	APP_CONFIGLLM_URL=http://127.0.0.1 \
	$(MAKE) start-ui

## Start Primary M3 Web UI connected to Cloud Run benchmark proxy (synthetic data only; requires APP_ALLOW_REMOTE_LLM=true)
start-web-dev:
	@if [ "$(APP_ALLOW_REMOTE_LLM)" != "true" ]; then \
		echo -e "  [$(RED)GDPR/HDS BLOCK$(RESET)] Remote Cloud Run LLM proxy requires explicit APP_ALLOW_REMOTE_LLM=true."; \
		echo -e "  [$(RED)WARNING$(RESET)] NEVER use Cloud Run proxy with real patient data (PHI). Use synthetic data only."; \
		exit 1; \
	fi
	@$(MAKE) cloudrun-proxy APP_ALLOW_REMOTE_LLM=true
	@$(MAKE) docker-up-proxy
	@echo -e "$(CYAN)--> Checking llama.cpp health over Cloud Run proxy (http://127.0.0.1:$(CLOUDRUN_PORT)/health)...$(RESET)"
	@READY=0; \
	for i in {1..15}; do \
		if curl -sf "http://127.0.0.1:$(CLOUDRUN_PORT)/health" >/dev/null 2>&1; then \
			READY=1; \
			echo -e "  [$(GREEN)READY$(RESET)] Remote llama.cpp healthcheck succeeded."; \
			break; \
		fi; \
		sleep 1; \
	done; \
	if [ $$READY -eq 0 ]; then \
		echo -e "  [$(YELLOW)WARNING$(RESET)] llama.cpp has not answered /health yet (cold-start model loading may still be in progress)."; \
	fi
	@APP_ALLOW_REMOTE_LLM=true \
	APP_CONFIGLLM_TYPE=litellm \
	APP_CONFIGLLM_URL=http://127.0.0.1 \
	$(MAKE) start-web

## Launch Cloud Run benchmark proxy in background (synthetic data only; requires APP_ALLOW_REMOTE_LLM=true)
cloudrun-proxy:
	@if [ "$(APP_ALLOW_REMOTE_LLM)" != "true" ]; then \
		echo -e "  [$(RED)GDPR/HDS BLOCK$(RESET)] Refusing to open Cloud Run LLM tunnel without APP_ALLOW_REMOTE_LLM=true."; \
		echo -e "  [$(RED)WARNING$(RESET)] Forwarding real patient health data (PHI) to remote cloud endpoints violates GDPR/HDS local-only rules."; \
		echo -e "  To benchmark with synthetic/anonymized data only, run: APP_ALLOW_REMOTE_LLM=true make cloudrun-proxy"; \
		exit 1; \
	fi
	@echo -e "$(CYAN)--> Verifying GCP authentication (gcloud)...$(RESET)"
	@if ! $(GCLOUD) auth print-access-token --quiet >/dev/null 2>&1; then \
		echo -e "  [$(YELLOW)AUTH$(RESET)] GCP session missing or expired. Running 'gcloud auth login'..."; \
		pkill -f "[g]cloud.*run.*services.*proxy" 2>/dev/null || true; \
		$(GCLOUD) auth login || { echo -e "  [$(RED)ERROR$(RESET)] GCP authentication failed."; exit 1; }; \
	else \
		echo -e "  [$(GREEN)OK$(RESET)] Valid GCP session."; \
	fi
	@if ss -tlnp 2>/dev/null | grep -q ":$(CLOUDRUN_PORT) "; then \
		echo -e "  [$(GREEN)OK$(RESET)] Cloud Run proxy already listening on 127.0.0.1:$(CLOUDRUN_PORT)"; \
	else \
		echo -e "$(CYAN)--> Starting background Cloud Run proxy to $(CLOUDRUN_SERVICE) on 127.0.0.1:$(CLOUDRUN_PORT)...$(RESET)"; \
		umask 077 && nohup $(GCLOUD) run services proxy $(CLOUDRUN_SERVICE) --port=$(CLOUDRUN_PORT) --quiet > /tmp/medsyntis-cloudrun-proxy.log 2>&1 & \
		echo -n "  Waiting for proxy socket and /health"; \
		READY=0; \
		for i in {1..15}; do \
			if ss -tlnp 2>/dev/null | grep -q ":$(CLOUDRUN_PORT) " && curl -sf "http://127.0.0.1:$(CLOUDRUN_PORT)/health" >/dev/null 2>&1; then \
				READY=1; \
				echo -e " [$(GREEN)READY$(RESET)]"; \
				break; \
			fi; \
			echo -n "."; \
			sleep 1; \
		done; \
		if [ $$READY -eq 0 ]; then \
			echo -e "\n  [$(YELLOW)WARNING$(RESET)] Proxy or remote /health not ready yet on port $(CLOUDRUN_PORT). Recent logs (/tmp/medsyntis-cloudrun-proxy.log):"; \
			cat /tmp/medsyntis-cloudrun-proxy.log 2>/dev/null || true; \
		fi; \
	fi

## Stop Cloud Run proxy
cloudrun-proxy-stop:
	@echo -e "$(YELLOW)--> Stopping Cloud Run proxy...$(RESET)"
	@if pgrep -f "[g]cloud.*run.*services.*proxy" >/dev/null 2>&1; then \
		pkill -f "[g]cloud.*run.*services.*proxy" 2>/dev/null && echo -e "  [$(RED)STOPPED$(RESET)] Cloud Run Proxy"; \
	else \
		echo -e "  [$(GREEN)OK$(RESET)] Cloud Run Proxy is not running"; \
	fi

# Shortcuts and aliases
api: start-api
ui: start-ui
web: start-web
worker: start-worker
ui-dev: start-ui-dev
web-dev: start-web-dev
start-dev: start-web-dev
start: start-web
proxy: cloudrun-proxy
proxy-stop: cloudrun-proxy-stop

## Start FastAPI + M3 Web UI in local development mode
dev:
	@echo -e "$(CYAN)--> Starting full local development mode (FastAPI + M3 Web UI)...$(RESET)"
	@$(MAKE) stop >/dev/null 2>&1
	@$(MAKE) start-web

## Stop active local processes (Streamlit, Web UI Node.js, FastAPI, Cloud Run proxy, and Docker containers)
stop: cloudrun-proxy-stop docker-down
	@echo -e "$(YELLOW)--> Stopping local application processes...$(RESET)"
	@if pgrep -f "[s]treamlit run app-ui.py" >/dev/null 2>&1; then \
		pkill -f "[s]treamlit run app-ui.py" 2>/dev/null && echo -e "  [$(RED)STOPPED$(RESET)] Legacy Streamlit UI"; \
	else \
		echo -e "  [$(GREEN)OK$(RESET)] Legacy Streamlit UI is not running"; \
	fi
	@if pgrep -f "[t]sx.*src/main.ts|[n]ode.*dist/main.js" >/dev/null 2>&1; then \
		pkill -f "[t]sx.*src/main.ts|[n]ode.*dist/main.js" 2>/dev/null && echo -e "  [$(RED)STOPPED$(RESET)] Web UI (Node.js Fastify)"; \
	else \
		echo -e "  [$(GREEN)OK$(RESET)] Web UI (Node.js Fastify) is not running"; \
	fi
	@if pgrep -f "[p]ython.*app-api.py" >/dev/null 2>&1; then \
		pkill -f "[p]ython.*app-api.py" 2>/dev/null && echo -e "  [$(RED)STOPPED$(RESET)] FastAPI App"; \
	else \
		echo -e "  [$(GREEN)OK$(RESET)] FastAPI App is not running"; \
	fi
	@echo -e "$(GREEN)Done.$(RESET)"

## Run Python test suite (Pytest on application/tests/)
test:
	@echo -e "$(CYAN)--> Running Pytest suite ($(APP_DIR)/tests/)...$(RESET)"
	cd $(APP_DIR) && $(UV) run pytest tests/

## Run Vitest unit & integration tests in web/
test-web:
	@echo -e "$(CYAN)--> Running Vitest unit & integration tests ($(WEB_DIR))...$(RESET)"
	npm --prefix $(WEB_DIR) run test

## Measure Python test coverage on application/tests/
coverage:
	@echo -e "$(CYAN)--> Running Pytest coverage on $(APP_DIR)/tests/...$(RESET)"
	cd $(APP_DIR) && PYTHONPATH=. $(UV) run pytest --cov=src --cov-report=term-missing $(CURDIR)/$(APP_DIR)/tests/

## Lint Python code with Ruff
lint:
	@echo -e "$(CYAN)--> Running Ruff linter on $(APP_DIR)/src/...$(RESET)"
	cd $(APP_DIR) && $(UV) run ruff check src/

## Lint TypeScript/CSS in web/ with Biome, tsc --noEmit, and check-contrast.mjs
lint-web:
	@echo -e "$(CYAN)--> Running Biome, TypeScript typecheck, and WCAG contrast check on $(WEB_DIR)/...$(RESET)"
	npm --prefix $(WEB_DIR) run lint

## Format Python code with Ruff
format:
	@echo -e "$(CYAN)--> Formatting $(APP_DIR)/src/ with Ruff...$(RESET)"
	cd $(APP_DIR) && $(UV) run ruff format src/

## Format web/ code with Biome
format-web:
	@echo -e "$(CYAN)--> Formatting $(WEB_DIR)/ with Biome...$(RESET)"
	npm --prefix $(WEB_DIR) run format

## Run Git pre-commit hooks (prek) on modified files
hooks:
	@if command -v prek >/dev/null 2>&1; then \
		prek run; \
	elif [ -x $(APP_DIR)/.venv/bin/prek ]; then \
		$(APP_DIR)/.venv/bin/prek run; \
	else \
		$(UV) run --project $(APP_DIR) prek run; \
	fi

## Run all Git pre-commit hooks (prek) across all repository files
hooks-all:
	@if command -v prek >/dev/null 2>&1; then \
		prek run --all-files; \
	elif [ -x $(APP_DIR)/.venv/bin/prek ]; then \
		$(APP_DIR)/.venv/bin/prek run --all-files; \
	else \
		$(UV) run --project $(APP_DIR) prek run --all-files; \
	fi

## Run Playwright E2E tests in web/
e2e-web:
	@echo -e "$(CYAN)--> Running Playwright E2E tests ($(WEB_DIR))...$(RESET)"
	npm --prefix $(WEB_DIR) run e2e

## Compile TypeScript in web/ to web/dist/
build-web:
	@echo -e "$(CYAN)--> Building TypeScript bundle in $(WEB_DIR)/...$(RESET)"
	npm --prefix $(WEB_DIR) run build

## Build dedicated Cross-Domain FastAPI Docker image (dist/docker/Dockerfile.api)
docker-build-api:
	@echo -e "$(CYAN)--> Building API Docker image ($${MEDSYNTIS_API_IMAGE:-ghcr.io/medsyntis/medsyntis-api}:$${MEDSYNTIS_TAG:-latest})...$(RESET)"
	docker build -f dist/docker/Dockerfile.api -t $${MEDSYNTIS_API_IMAGE:-ghcr.io/medsyntis/medsyntis-api}:$${MEDSYNTIS_TAG:-latest} .
	@echo -e "$(GREEN)--> API Docker image built successfully.$(RESET)"

## Build optional legacy Streamlit Docker image (dist/docker/Dockerfile)
docker-build-ui:
	@echo -e "$(CYAN)--> Building legacy Streamlit Docker image ($${MEDSYNTIS_IMAGE:-ghcr.io/medsyntis/medsyntis}:$${MEDSYNTIS_TAG:-latest})...$(RESET)"
	docker build -f dist/docker/Dockerfile -t $${MEDSYNTIS_IMAGE:-ghcr.io/medsyntis/medsyntis}:$${MEDSYNTIS_TAG:-latest} .
	@echo -e "$(GREEN)--> Legacy Streamlit Docker image built successfully.$(RESET)"

## Build hardened M3 Web UI Node.js Docker image (dist/docker/Dockerfile.web)
docker-build-web:
	@echo -e "$(CYAN)--> Building Web UI Docker image ($${MEDSYNTIS_WEB_IMAGE:-ghcr.io/medsyntis/medsyntis-web}:$${MEDSYNTIS_TAG:-latest})...$(RESET)"
	docker build -f dist/docker/Dockerfile.web -t $${MEDSYNTIS_WEB_IMAGE:-ghcr.io/medsyntis/medsyntis-web}:$${MEDSYNTIS_TAG:-latest} .
	@echo -e "$(GREEN)--> Web UI Docker image built successfully.$(RESET)"

## Fetch and display bug reports stored in MongoDB
get-bugs:
	@echo -e "$(CYAN)--> Fetching bug reports from MongoDB...$(RESET)"
	@cd $(APP_DIR) && $(UV) run python scripts/get_bugs.py

## Migrate legacy cleartext patient_id values in MongoDB to SHA-256 pseudonymized IDs (set DRY_RUN=1 to preview, DOMAIN=oncology to filter)
patient-id-migrate:
	@echo -e "$(CYAN)--> Migrating legacy cleartext patient_id records in MongoDB to SHA-256 pseudonymized IDs...$(RESET)"
	@MIGRATE_ARGS=""; \
	if [ "$(DRY_RUN)" = "1" ] || [ "$(DRY_RUN)" = "true" ]; then MIGRATE_ARGS="$$MIGRATE_ARGS --dry-run"; fi; \
	if [ -n "$(DOMAIN)" ]; then MIGRATE_ARGS="$$MIGRATE_ARGS --domain $(DOMAIN)"; fi; \
	if [ -x "$(APP_DIR)/.venv/bin/python" ] || command -v "$(UV)" >/dev/null 2>&1; then \
		cd $(APP_DIR) && $(UV) run python scripts/migrate_patient_ids.py $$MIGRATE_ARGS; \
	elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^medsyntis-api$$'; then \
		docker exec medsyntis-api uv run --no-sync python scripts/migrate_patient_ids.py $$MIGRATE_ARGS; \
	else \
		echo -e "  [$(RED)ERROR$(RESET)] Neither local uv/virtualenv nor running medsyntis-api container found."; \
		exit 1; \
	fi

## Initialize local MongoDB Replica Set (rs0) if needed
mongo-init:
	@echo -e "$(CYAN)--> Initializing / verifying local MongoDB Replica Set (rs0)...$(RESET)"
	@cd $(APP_DIR) && $(UV) run python -c "import sys; from pymongo import MongoClient; \
c = MongoClient('mongodb://root:root@127.0.0.1:27017/?directConnection=true&authSource=admin', serverSelectionTimeoutMS=2000); \
h = c.admin.command('hello'); \
(print('  [OK] MongoDB Replica Set already active (Primary ready)'), sys.exit(0)) if h.get('isWritablePrimary') else None; \
c.admin.command('replSetInitiate', {'_id': 'rs0', 'members': [{'_id': 0, 'host': '127.0.0.1:27017'}]}); \
print('  [OK] MongoDB Replica Set (rs0) initialized successfully')" 2>/dev/null || echo -e "  [$(GREEN)OK$(RESET)] MongoDB Replica Set ready."

## Start local Docker infrastructure services (Milvus & MongoDB)
docker-up:
	@mkdir -p $(DEV_VOLUME_DIR)/{mongodb,mongodb_config,milvus,etcd,minio,logs}
	@chmod 750 $(DEV_VOLUME_DIR)/{mongodb,mongodb_config,milvus,etcd,minio,logs} 2>/dev/null || true
	@echo -e "$(CYAN)--> Starting Milvus Standalone...$(RESET)"
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_MILVUS) up -d
	@echo -e "$(CYAN)--> Starting common services (MongoDB)...$(RESET)"
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_DEV) up -d

## Start local Docker containers in proxy mode (Milvus, MongoDB, embeddings — without local chat LLM)
docker-up-proxy:
	@mkdir -p $(DEV_VOLUME_DIR)/{mongodb,mongodb_config,milvus,etcd,minio,logs}
	@chmod 750 $(DEV_VOLUME_DIR)/{mongodb,mongodb_config,milvus,etcd,minio,logs} 2>/dev/null || true
	@echo -e "$(CYAN)--> Starting Milvus Standalone...$(RESET)"
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_MILVUS) up -d
	@echo -e "$(CYAN)--> Starting proxy-mode services (MongoDB + LiteLLM + embeddings)...$(RESET)"
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_DEV) --profile llamacpp up -d

## Pull latest local Docker images (Milvus v3.0 & MongoDB) and recreate active containers
docker-update:
	@mkdir -p $(DEV_VOLUME_DIR)/{mongodb,mongodb_config,milvus,etcd,minio,logs}
	@chmod 750 $(DEV_VOLUME_DIR)/{mongodb,mongodb_config,milvus,etcd,minio,logs} 2>/dev/null || true
	@echo -e "$(CYAN)--> Pulling updated Docker images (Milvus Standalone v3.0 & MongoDB)...$(RESET)"
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_MILVUS) pull
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_MILVUS) run --rm milvus-volume-init
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_DEV) pull
	@if docker ps --format '{{.Names}}' | grep -q '^milvus-standalone$$'; then \
		echo -e "$(CYAN)--> Recreating active Milvus containers...$(RESET)"; \
		DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_MILVUS) up -d; \
	fi
	@if docker ps --format '{{.Names}}' | grep -q '^medsyntis-mongod$$'; then \
		echo -e "$(CYAN)--> Recreating active MongoDB container...$(RESET)"; \
		DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_DEV) up -d; \
	fi

## Stop local Docker infrastructure containers
docker-down:
	@echo -e "$(YELLOW)--> Stopping local Docker containers...$(RESET)"
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_MILVUS) down --remove-orphans
	DOCKER_VOLUME_DIRECTORY=$(DEV_VOLUME_DIR) docker compose -f $(COMPOSE_DEV) down --remove-orphans

## Check status of running Docker containers
docker-status:
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

## Pull recommended local Ollama models
pull-models:
	@echo -e "$(CYAN)--> Pulling local Ollama models (Embeddings, VLM OCR, Reasoning)...$(RESET)"
	ollama pull nomic-embed-text
	ollama pull granite3.2-vision
	ollama pull mistral-nemo

## Show listening status of local MedSyntis ports and services
status:
	@echo -e "$(CYAN)=== MedSyntis Local Service Status ===$(RESET)"
	@echo -n "FastAPI (port $(PORT_API))        : "
	@ss -tlnp 2>/dev/null | grep -q ":$(PORT_API) " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "Web UI M3 (port $(PORT_WEB))      : "
	@ss -tlnp 2>/dev/null | grep -q ":$(PORT_WEB) " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "Streamlit Legacy (port $(PORT_UI)) : "
	@ss -tlnp 2>/dev/null | grep -q ":$(PORT_UI) " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "Cloud Run Proxy (port $(CLOUDRUN_PORT)) : "
	@ss -tlnp 2>/dev/null | grep -q ":$(CLOUDRUN_PORT) " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "Milvus (port 19530)       : "
	@ss -tlnp 2>/dev/null | grep -q ":19530 " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "MongoDB (port 27017)      : "
	@ss -tlnp 2>/dev/null | grep -q ":27017 " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "Local Ollama (port 11434) : "
	@ss -tlnp 2>/dev/null | grep -q ":11434 " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"

## Clean temporary build artifacts and test caches
clean:
	@echo -e "$(YELLOW)--> Cleaning caches and build artifacts...$(RESET)"
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".ruff_cache" -exec rm -rf {} + 2>/dev/null || true
	rm -rf $(WEB_DIR)/dist $(WEB_DIR)/playwright-report $(WEB_DIR)/test-results 2>/dev/null || true
	@echo -e "$(GREEN)Caches cleaned successfully.$(RESET)"

# ==============================================================================
# Production Targets (NVIDIA L4 24G + Zero-Trust SSO + Caddy TLS)
# ==============================================================================

## Initialize production host (sudoers, randomized .env.prod, least-privilege volumes, Milvus v3.0, logrotate, GGUF models)
init-prod:
	@echo -e "$(CYAN)--> Checking production host prerequisites...$(RESET)"
	@command -v docker >/dev/null 2>&1 || { echo -e "  [$(RED)ERROR$(RESET)] Docker is not installed."; exit 1; }
	@$(MAKE) sudoers-prod
	@if command -v nvidia-smi >/dev/null 2>&1; then \
		echo -e "  [$(GREEN)OK$(RESET)] NVIDIA GPU detected: $$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -n1)"; \
	else \
		echo -e "  [$(YELLOW)WARNING$(RESET)] nvidia-smi not found. Verify NVIDIA drivers and nvidia-container-toolkit."; \
	fi
	@echo -e "$(CYAN)--> Creating persistent volume and clinical domain directories (least-privilege permissions)...$(RESET)"
	@mkdir -p "$(DOCKER_VOLUME_DIRECTORY)"/{mongodb,mongodb_config,milvus,etcd,minio,models,logs,queue,caddy_data,caddy_config} 2>/dev/null || true
	@mkdir -p /data/medsyntis/oncologic/{mtd,documents} /data/medsyntis/sma/{mtd,documents} 2>/dev/null || true
	@mkdir -p application/ressources/PatientMDTForm/{oncology,sma} application/ressources/documents/{oncology,sma}
	@chmod 750 "$(DOCKER_VOLUME_DIRECTORY)"/{mongodb,mongodb_config,milvus,etcd,minio,models,logs,queue} 2>/dev/null || true
	@chmod 700 "$(DOCKER_VOLUME_DIRECTORY)"/{caddy_data,caddy_config} 2>/dev/null || true
	@chmod 750 /data/medsyntis/oncologic/{mtd,documents} /data/medsyntis/sma/{mtd,documents} 2>/dev/null || true
	@if [ ! -f "$(ENV_PROD)" ]; then \
		echo -e "$(CYAN)--> Generating $(ENV_PROD) from .env.prod.example with randomized secrets (mode 0600)...$(RESET)"; \
		umask 077 && cp .env.prod.example "$(ENV_PROD)" && chmod 0600 "$(ENV_PROD)"; \
		COOKIE_SEC=$$(openssl rand -base64 32 | tr -- '+/' '-_'); \
		MONGO_PASS=$$(openssl rand -hex 24); \
		LITELLM_KEY="sk-$$(openssl rand -hex 32)"; \
		sed -i "s|OAUTH2_PROXY_COOKIE_SECRET=.*|OAUTH2_PROXY_COOKIE_SECRET=$${COOKIE_SEC}|" "$(ENV_PROD)"; \
		sed -i "s|APP_MONGODB_PASSWORD=.*|APP_MONGODB_PASSWORD=$${MONGO_PASS}|" "$(ENV_PROD)"; \
		sed -i "s|LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY=$${LITELLM_KEY}|" "$(ENV_PROD)"; \
		sed -i "s|APP_API_TOKEN=.*|APP_API_TOKEN=$$(openssl rand -hex 32)|" "$(ENV_PROD)"; \
		sed -i "s|APP_PROXY_SECRET=.*|APP_PROXY_SECRET=$$(openssl rand -hex 32)|" "$(ENV_PROD)"; \
		echo -e "  [$(YELLOW)ACTION REQUIRED$(RESET)] Configure OAUTH2_PROXY_CLIENT_ID, OAUTH2_PROXY_CLIENT_SECRET, and OIDC/GitHub org restrictions in $(ENV_PROD)"; \
	else \
		chmod 0600 "$(ENV_PROD)" 2>/dev/null || true; \
		echo -e "  [$(GREEN)OK$(RESET)] $(ENV_PROD) already exists."; \
	fi
	@echo -e "$(CYAN)--> Initializing Milvus v3.0 volume ownership (milvus-volume-init)...$(RESET)"
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_MILVUS) pull
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_MILVUS) run --rm milvus-volume-init
	@$(MAKE) logrotate-prod
	@$(MAKE) pull-models-prod
	@echo -e "$(GREEN)--> Production initialization complete.$(RESET)"

## Validate and install /etc/sudoers.d/medsyntis (mode 0440) using a secure 0600 temporary file
sudoers-prod:
	@echo -e "$(CYAN)--> Configuring /etc/sudoers.d/medsyntis for deploy user '$(DEPLOY_USER)'...$(RESET)"
	@TMP_SUDOERS=$$(mktemp) && \
	chmod 0600 "$$TMP_SUDOERS" && \
	trap 'rm -f "$$TMP_SUDOERS"' EXIT && \
	sed "s|__DEPLOY_USER__|$(DEPLOY_USER)|g" dist/sudoers/medsyntis > "$$TMP_SUDOERS" && \
	if sudo visudo -cf "$$TMP_SUDOERS" >/dev/null 2>&1; then \
		sudo install -o root -g root -m 0440 "$$TMP_SUDOERS" /etc/sudoers.d/medsyntis && \
		echo -e "  [$(GREEN)OK$(RESET)] Validated and installed /etc/sudoers.d/medsyntis (mode 0440, root:root)."; \
	else \
		echo -e "  [$(YELLOW)INFO$(RESET)] Could not install /etc/sudoers.d/medsyntis automatically (requires interactive sudo)."; \
	fi

## Generate and install /etc/logrotate.d/medsyntis targeting $(DOCKER_VOLUME_DIRECTORY)/logs
logrotate-prod:
	@echo -e "$(CYAN)--> Configuring logrotate for MedSyntis logs ($(DOCKER_VOLUME_DIRECTORY)/logs)...$(RESET)"
	@mkdir -p "$(DOCKER_VOLUME_DIRECTORY)/logs" 2>/dev/null || true
	@chmod 750 "$(DOCKER_VOLUME_DIRECTORY)/logs" 2>/dev/null || true
	@TMP_LOGROTATE=$$(mktemp) && \
	chmod 0600 "$$TMP_LOGROTATE" && \
	trap 'rm -f "$$TMP_LOGROTATE"' EXIT && \
	sed "s|__MEDSYNTIS_LOG_DIR__|$(DOCKER_VOLUME_DIRECTORY)/logs|g" dist/logrotate/medsyntis > "$$TMP_LOGROTATE" && \
	if sudo install -o root -g root -m 0644 "$$TMP_LOGROTATE" /etc/logrotate.d/medsyntis 2>/dev/null; then \
		echo -e "  [$(GREEN)OK$(RESET)] Installed /etc/logrotate.d/medsyntis for $(DOCKER_VOLUME_DIRECTORY)/logs (mode 0644, root:root)."; \
	else \
		echo -e "  [$(YELLOW)INFO$(RESET)] Run as root/sudo to install /etc/logrotate.d/medsyntis targeting $(DOCKER_VOLUME_DIRECTORY)/logs."; \
	fi

## Download production GGUF models (Ornith-1.5-35B-A3B-IQ4_XS.gguf & bge-m3-Q4_K_M.gguf) into $(MODELS_DIR)
pull-models-prod:
	@mkdir -p "$(MODELS_DIR)"
	@chmod 750 "$(MODELS_DIR)" 2>/dev/null || true
	@echo -e "$(CYAN)--> Checking / downloading embeddings GGUF ($(EMBED_MODEL_FILE))...$(RESET)"
	@if [ -f "$(EMBED_MODEL_FILE)" ]; then \
		echo -e "  [$(GREEN)OK$(RESET)] $(EMBED_MODEL_FILE) already present."; \
	else \
		curl -fL -C - -o "$(EMBED_MODEL_FILE).part" "$(EMBED_MODEL_URL)" && mv "$(EMBED_MODEL_FILE).part" "$(EMBED_MODEL_FILE)" && chmod 0644 "$(EMBED_MODEL_FILE)"; \
		echo -e "  [$(GREEN)OK$(RESET)] Downloaded $(EMBED_MODEL_FILE)."; \
	fi
	@echo -e "$(CYAN)--> Checking / downloading L4 reasoning GGUF ($(CHAT_MODEL_FILE), ~19.3 GB)...$(RESET)"
	@if [ -f "$(CHAT_MODEL_FILE)" ]; then \
		echo -e "  [$(GREEN)OK$(RESET)] $(CHAT_MODEL_FILE) already present."; \
	else \
		curl -fL -C - -o "$(CHAT_MODEL_FILE).part" "$(CHAT_MODEL_URL)" && mv "$(CHAT_MODEL_FILE).part" "$(CHAT_MODEL_FILE)" && chmod 0644 "$(CHAT_MODEL_FILE)"; \
		echo -e "  [$(GREEN)OK$(RESET)] Downloaded $(CHAT_MODEL_FILE)."; \
	fi

## Initialize MongoDB Replica Set (rs0) inside the production mongod container
mongo-init-prod:
	@if [ ! -f "$(ENV_PROD)" ]; then \
		echo -e "  [$(RED)ERROR$(RESET)] Missing $(ENV_PROD). Run 'make init-prod' first."; \
		exit 1; \
	fi
	@echo -e "$(CYAN)--> Initializing / verifying production MongoDB Replica Set (rs0)...$(RESET)"
	@for i in {1..15}; do \
		if docker exec medsyntis-mongod mongosh --quiet --eval "db.runCommand({ ping: 1 })" >/dev/null 2>&1; then \
			break; \
		fi; \
		sleep 1; \
	done
	@MONGO_USER=$$(grep -E '^APP_MONGODB_USER=' "$(ENV_PROD)" | cut -d= -f2); \
	MONGO_PASS=$$(grep -E '^APP_MONGODB_PASSWORD=' "$(ENV_PROD)" | cut -d= -f2); \
	docker exec -e MONGO_PASS="$$MONGO_PASS" medsyntis-mongod sh -c 'mongosh --quiet -u "'"$${MONGO_USER:-root}"'" -p "$$MONGO_PASS" --authenticationDatabase admin --eval '\'' \
		try { \
			var s = rs.status(); \
			if (s.ok === 1) { print("  [OK] MongoDB Replica Set (rs0) already active."); quit(0); } \
		} catch (e) {} \
		rs.initiate({_id: "rs0", members: [{_id: 0, host: "127.0.0.1:27017"}]}); \
		print("  [OK] MongoDB Replica Set (rs0) initialized."); \
	'\''' 2>/dev/null || echo -e "  [$(GREEN)OK$(RESET)] MongoDB Replica Set ready."

## Build production Docker images in parallel (FastAPI + M3 Web UI; set WITH_STREAMLIT=1 for legacy Streamlit)
build-prod:
	@echo -e "$(CYAN)--> Building production Docker images in parallel (API + Web M3)...$(RESET)"
	@$(MAKE) docker-build-api & PID_API=$$!; \
	$(MAKE) docker-build-web & PID_WEB=$$!; \
	PID_UI=""; \
	if [ "$(WITH_STREAMLIT)" = "1" ]; then \
		$(MAKE) docker-build-ui & PID_UI=$$!; \
	fi; \
	FAIL=0; \
	wait $$PID_API || FAIL=1; \
	wait $$PID_WEB || FAIL=1; \
	if [ -n "$$PID_UI" ]; then wait $$PID_UI || FAIL=1; fi; \
	if [ $$FAIL -ne 0 ]; then \
		echo -e "$(RED)--> Parallel Docker image build failed.$(RESET)"; \
		exit 1; \
	fi
	@echo -e "$(GREEN)--> Production Docker images built successfully.$(RESET)"

## Start production Docker containers (API + M3 Web UI oncology & sma; set WITH_STREAMLIT=1 for optional Streamlit *-st)
docker-up-prod:
	@if [ ! -f "$(ENV_PROD)" ]; then \
		echo -e "  [$(RED)ERROR$(RESET)] Missing $(ENV_PROD). Run 'make init-prod' and configure SSO secrets first."; \
		exit 1; \
	fi
	@if grep -qE '<YOUR_SSO_CLIENT_ID>|<YOUR_SSO_CLIENT_SECRET>|<GENERATE_STRONG_SECRET>|votre_github_client_id' "$(ENV_PROD)"; then \
		echo -e "  [$(RED)ERROR$(RESET)] Unconfigured placeholder secrets remain in $(ENV_PROD) (check OAUTH2_PROXY_* and APP_MONGODB_PASSWORD)."; \
		exit 1; \
	fi
	@mkdir -p "$(DOCKER_VOLUME_DIRECTORY)"/{mongodb,mongodb_config,milvus,etcd,minio,models,logs,queue,caddy_data,caddy_config} 2>/dev/null || true
	@mkdir -p /data/medsyntis/oncologic/{mtd,documents} /data/medsyntis/sma/{mtd,documents} 2>/dev/null || true
	@chmod 750 "$(DOCKER_VOLUME_DIRECTORY)"/{mongodb,mongodb_config,milvus,etcd,minio,models,logs,queue} 2>/dev/null || true
	@chmod 700 "$(DOCKER_VOLUME_DIRECTORY)"/{caddy_data,caddy_config} 2>/dev/null || true
	@echo -e "$(CYAN)--> Starting Milvus Standalone...$(RESET)"
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_MILVUS) up -d
	@echo -e "$(CYAN)--> Starting MedSyntis production stack (L4 GPU + API + M3 Web UI + OAuth2 Proxy + Caddy)...$(RESET)"
	@if [ "$(WITH_STREAMLIT)" = "1" ]; then \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) --profile streamlit up -d --no-build; \
	else \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) up -d --no-build; \
	fi
	@docker exec medsyntis-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true

## Start production stack including optional legacy Streamlit services (oncologic-st & sma-st)
start-prod-st:
	@$(MAKE) start-prod WITH_STREAMLIT=1

## Start full production stack and wait for local LLM readiness
start-prod: docker-up-prod
	@echo -e "$(CYAN)--> Waiting for Ornith-1.5-35B-A3B to load onto L4 GPU VRAM...$(RESET)"
	@READY=0; \
	for i in {1..60}; do \
		if (curl -sf -m 2 http://127.0.0.1:8080/health 2>/dev/null || docker exec llama-cpp-chat-server curl -sf -m 2 http://127.0.0.1:8080/health 2>/dev/null) | grep -q '"status":"ok"'; then \
			READY=1; \
			echo -e "\n  [$(GREEN)READY$(RESET)] llama.cpp Chat server (Ornith-1.5-35B-A3B) is operational on L4 GPU."; \
			break; \
		fi; \
		if [ $$i -eq 1 ]; then \
			echo -n "  Loading weights into VRAM (typically 20–60s)"; \
		else \
			echo -n "."; \
		fi; \
		sleep 2; \
	done; \
	if [ $$READY -eq 0 ]; then \
		echo -e "\n  [$(YELLOW)INFO$(RESET)] Model loading continues in the background (check 'make logs-prod')."; \
	fi
	@BASE_DOM=$$(grep -E '^PROD_BASE_DOMAIN=' "$(ENV_PROD)" 2>/dev/null | cut -d= -f2 || echo "$(PROD_BASE_DOMAIN)"); \
	BASE_DOM=$${BASE_DOM:-$(PROD_BASE_DOMAIN)}; \
	echo -e "$(GREEN)======================================================================$(RESET)"; \
	echo -e "  MedSyntis Production Active:"; \
	echo -e "     • Oncology (Primary Web M3)   : $(CYAN)https://oncologic.$${BASE_DOM}$(RESET)"; \
	echo -e "     • SMA (Primary Web M3)        : $(CYAN)https://sma.$${BASE_DOM}$(RESET)"; \
	if docker ps --format '{{.Names}}' | grep -q '^medsyntis-ui-'; then \
		echo -e "     • Oncology (Legacy Streamlit) : $(CYAN)https://oncologic-st.$${BASE_DOM}$(RESET)"; \
		echo -e "     • SMA (Legacy Streamlit)      : $(CYAN)https://sma-st.$${BASE_DOM}$(RESET)"; \
	fi; \
	echo -e "$(GREEN)======================================================================$(RESET)"

## Stop all production containers (preserving persistent data volumes)
stop-prod:
	@echo -e "$(YELLOW)--> Stopping MedSyntis production stack...$(RESET)"
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) --profile streamlit down --remove-orphans
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_MILVUS) down --remove-orphans
	@echo -e "$(GREEN)--> Production stack stopped.$(RESET)"

docker-down-prod: stop-prod
up-prod: start-prod
down-prod: stop-prod
prod: start-prod
pprod: start-prod

## Restart application & proxy containers without unloading LLM weights from GPU VRAM
restart-prod:
	@echo -e "$(CYAN)--> Restarting application and ingress services (Web M3, API, LiteLLM, OAuth2 Proxy, Caddy) while preserving GPU VRAM...$(RESET)"
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) restart litellm medsyntis-web medsyntis-api oauth2-proxy caddy
	@if docker ps --format '{{.Names}}' | grep -q '^medsyntis-ui-'; then \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) --profile streamlit restart medsyntis-ui-oncology medsyntis-ui-sma; \
	fi
	@echo -e "$(GREEN)--> Application services restarted.$(RESET)"

## Pull latest Git changes, Milvus v3.0, and app Docker images without unloading LLM weights from GPU VRAM
prod-update:
	@echo -e "$(CYAN)--> [1/5] Pulling fast-forward Git updates (git pull --ff-only)...$(RESET)"
	git pull --ff-only
	@echo -e "$(CYAN)--> [2/5] Updating Milvus Standalone (v3.0)...$(RESET)"
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_MILVUS) pull
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_MILVUS) up -d
	@echo -e "$(CYAN)--> [3/5] Pulling latest application images (medsyntis-api, medsyntis-web, oauth2-proxy, caddy, litellm)...$(RESET)"
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) pull medsyntis-api medsyntis-web oauth2-proxy caddy litellm
	@echo -e "$(CYAN)--> [4/5] Hot-recreating application containers (LLM retained in GPU VRAM)...$(RESET)"
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) up -d --no-deps medsyntis-web medsyntis-api oauth2-proxy caddy litellm
	@if docker ps --format '{{.Names}}' | grep -q '^medsyntis-ui-'; then \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) --profile streamlit pull medsyntis-ui-oncology medsyntis-ui-sma; \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) --profile streamlit up -d --no-deps medsyntis-ui-oncology medsyntis-ui-sma; \
	fi
	@docker exec medsyntis-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) restart caddy
	@echo -e "$(CYAN)--> [5/5] Pruning dangling Docker images...$(RESET)"
	@docker image prune -f >/dev/null 2>&1 || true
	@$(MAKE) status-prod
	@echo -e "$(GREEN)--> Production update (prod-update) completed successfully.$(RESET)"

## Update the entire production Docker stack (including LLM, Milvus, MongoDB, and Web M3)
prod-update-all:
	@echo -e "$(CYAN)--> Performing full production stack update (infra + LLM + Web M3)...$(RESET)"
	git pull --ff-only
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_MILVUS) pull
	@if docker ps --format '{{.Names}}' | grep -q '^medsyntis-ui-'; then \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) --profile streamlit pull; \
	else \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) pull; \
	fi
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_MILVUS) up -d
	@if docker ps --format '{{.Names}}' | grep -q '^medsyntis-ui-'; then \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) --profile streamlit up -d --no-build; \
	else \
		docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) up -d --no-build; \
	fi
	@docker exec medsyntis-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) restart caddy
	@docker image prune -f >/dev/null 2>&1 || true
	@$(MAKE) status-prod

## Create timestamped production backup (mongodump archive + Milvus/domain PDF tar archive + SHA-256 checksums)
backup-prod:
	@if [ ! -f "$(ENV_PROD)" ]; then \
		echo -e "  [$(RED)ERROR$(RESET)] Missing $(ENV_PROD). Cannot run production backup."; \
		exit 1; \
	fi
	@TS=$$(date -u +"%Y%m%dT%H%M%SZ"); \
	DEST="$(BACKUP_DIR)/$$TS"; \
	umask 077 && mkdir -p "$$DEST" && chmod 0700 "$$DEST"; \
	echo -e "$(CYAN)--> [1/3] Dumping MongoDB databases to $$DEST/mongodb.archive.gz...$(RESET)"; \
	MONGO_USER=$$(grep -E '^APP_MONGODB_USER=' "$(ENV_PROD)" | cut -d= -f2); \
	MONGO_PASS=$$(grep -E '^APP_MONGODB_PASSWORD=' "$(ENV_PROD)" | cut -d= -f2); \
	docker exec -e MONGO_PASS="$$MONGO_PASS" medsyntis-mongod sh -c 'mongodump --quiet --username "'"$${MONGO_USER:-root}"'" --password "$$MONGO_PASS" --authenticationDatabase admin --archive --gzip' > "$$DEST/mongodb.archive.gz"; \
	echo -e "$(CYAN)--> [2/3] Archiving Milvus metadata & clinical PDF volumes to $$DEST/medsyntis-volumes.tar.gz...$(RESET)"; \
	ONCO_DIR=$$(grep -E '^HOST_ONCOLOGIC_DIR=' "$(ENV_PROD)" | cut -d= -f2 || echo "/data/medsyntis/oncologic"); \
	SMA_DIR=$$(grep -E '^HOST_SMA_DIR=' "$(ENV_PROD)" | cut -d= -f2 || echo "/data/medsyntis/sma"); \
	tar -czf "$$DEST/medsyntis-volumes.tar.gz" \
		--ignore-failed-read \
		"$(DOCKER_VOLUME_DIRECTORY)/milvus" \
		"$(DOCKER_VOLUME_DIRECTORY)/etcd" \
		"$(DOCKER_VOLUME_DIRECTORY)/minio" \
		"$${ONCO_DIR:-/data/medsyntis/oncologic}" \
		"$${SMA_DIR:-/data/medsyntis/sma}" 2>/dev/null || true; \
	echo -e "$(CYAN)--> [3/3] Generating SHA-256 integrity manifest...$(RESET)"; \
	(cd "$$DEST" && sha256sum * > SHA256SUMS); \
	echo -e "$(GREEN)--> Production backup written to $$DEST (mode 0700). Encrypt off-host copies (e.g., gpg/restic/borg) per HDS policy.$(RESET)"

## Display comprehensive production service health and NVIDIA L4 VRAM usage
status-prod:
	@echo -e "$(CYAN)=== MedSyntis Service Status (PRODUCTION) ===$(RESET)"
	@echo -n "Caddy HTTPS (port 443)            : "
	@ss -tlnp 2>/dev/null | grep -q ":443 " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "OAuth2 Proxy SSO (port 4180)      : "
	@docker ps --format '{{.Names}}' | grep -q '^medsyntis-oauth2-proxy$$' && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "API Cross-Domains (port 8000)     : "
	@docker ps --format '{{.Names}}' | grep -q '^medsyntis-api$$' && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "Web M3 oncology/sma (port 3000)   : "
	@docker ps --format '{{.Names}}' | grep -q '^medsyntis-web$$' && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "Legacy Streamlit Oncology (8501)  : "
	@docker ps --format '{{.Names}}' | grep -q '^medsyntis-ui-oncology$$' && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(YELLOW)OPTIONAL (INACTIVE)$(RESET)"
	@echo -n "Legacy Streamlit SMA (port 8502)  : "
	@docker ps --format '{{.Names}}' | grep -q '^medsyntis-ui-sma$$' && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(YELLOW)OPTIONAL (INACTIVE)$(RESET)"
	@echo -n "LiteLLM Proxy (port 4000)         : "
	@docker ps --format '{{.Names}}' | grep -q '^litellm-proxy$$' && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "llama.cpp Chat L4 (port 8080)     : "
	@if (curl -sf -m 2 http://127.0.0.1:8080/health 2>/dev/null || docker exec llama-cpp-chat-server curl -sf -m 2 http://127.0.0.1:8080/health 2>/dev/null) | grep -q '"status":"ok"'; then \
		echo -e "$(GREEN)READY (Model loaded in VRAM)$(RESET)"; \
	elif docker ps --format '{{.Names}}' | grep -q '^llama-cpp-chat-server$$'; then \
		echo -e "$(YELLOW)LOADING...$(RESET)"; \
	else \
		echo -e "$(RED)INACTIVE$(RESET)"; \
	fi
	@echo -n "llama.cpp Embed CPU (port 8081)   : "
	@if (curl -sf -m 2 http://127.0.0.1:8081/health 2>/dev/null || docker exec llama-cpp-embeddings-server curl -sf -m 2 http://127.0.0.1:8080/health 2>/dev/null) | grep -q '"status":"ok"'; then \
		echo -e "$(GREEN)READY$(RESET)"; \
	elif docker ps --format '{{.Names}}' | grep -q '^llama-cpp-embeddings-server$$'; then \
		echo -e "$(YELLOW)LOADING...$(RESET)"; \
	else \
		echo -e "$(RED)INACTIVE$(RESET)"; \
	fi
	@echo -n "Milvus Vector DB (port 19530)     : "
	@ss -tlnp 2>/dev/null | grep -q ":19530 " && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@echo -n "MongoDB ReplicaSet (27017)        : "
	@docker ps --format '{{.Names}}' | grep -q '^medsyntis-mongod$$' && echo -e "$(GREEN)ACTIVE$(RESET)" || echo -e "$(RED)INACTIVE$(RESET)"
	@if command -v nvidia-smi >/dev/null 2>&1; then \
		echo ""; \
		echo -e "$(CYAN)=== NVIDIA L4 GPU Utilization ===$(RESET)"; \
		nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=table; \
	fi

## Stream real-time logs from the production stack
logs-prod:
	docker compose --env-file $(ENV_PROD) -f $(COMPOSE_PROD) logs -f --tail=100
