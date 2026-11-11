---
name: infrastructure-expert
description: "Manages local and production Docker Compose services (`dist/docker/compose/`), Milvus & MongoDB persistence, GPU/VRAM allocations (`llama.cpp`, LiteLLM, Ollama), and loopback/internal network isolation."
---

# Infrastructure Expert Skill (`infrastructure-expert`)

This skill outlines operational rules for local and single-node hospital hosting environments, Docker Compose orchestration (`dist/docker/compose/`), database persistence, hardware VRAM budgeting, and strict network isolation.

## System Orchestration

### 1. Docker Compose Stacks & Subnet Isolation (`dist/docker/compose/`)
- **Vector Database (Milvus v3.0 Standalone)**: Defined in `dist/docker/compose/milvus-standalone-docker-compose.yml` (`milvus-etcd`, `milvus-minio`, `milvus-standalone` on `:19530` gRPC / `:9091` healthcheck).
- **Local Development Stack**: Defined in `dist/docker/compose/docker-compose.yml` (MongoDB 9.0 Replica Set `rs0`, plus optional `ollama` on `127.0.0.1:11434`, `llama-cpp-chat` on `127.0.0.1:8080`, `llama-cpp-embeddings` on `127.0.0.1:8081`, and `litellm` on `127.0.0.1:4000`).
- **Production Stack**: Defined in `dist/docker/compose/docker-compose.prod.yml`, segmenting external SSO ingress (`ingress_net`: `caddy` + `oauth2-proxy`) from an `internal: true` backend network (`backend_internal`: `medsyntis-web`, `medsyntis-api`, `mongod`, `litellm`, `llama-cpp-chat`, `llama-cpp-embeddings`).
- Keep MongoDB, LiteLLM, API, and OAuth2-Proxy secrets strictly inside environment files (`.env` / `.env.prod` with `0600` permissions) — never hardcoded in Compose manifests.

### 2. Hardware & VRAM Resource Constraints
- **Production Profile (24 GB NVIDIA L4 GPU)**:
  - `llama-cpp-chat` runs quantized clinical reasoning models (e.g., `Ornith-1.5-35B-A3B-IQ4_XS.gguf`) on GPU (`-ngl 99`, `--flash-attn on`, `q4_0` KV cache) behind `litellm` (`:4000`).
  - `llama-cpp-embeddings` runs `bge-m3-Q4_K_M.gguf` strictly on CPU (`-ngl 0`) so RAG embedding queries never contend for GPU VRAM.
- **Local Workstation Profile**: Supports Ollama (`:11434`) or `llama.cpp` (`>=12 GB` NVIDIA VRAM recommended).
- Services must fail fast if required local GGUF model files are missing in production or if GPU/OOM errors occur, rather than silently downloading weights from external hubs or hanging indefinitely.

### 3. Local Privacy & Telemetry Isolation
- Strictly forbid outbound calls, telemetry (`LITELLM_TELEMETRY=False`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `ANONYMIZED_TELEMETRY=False`, `DO_NOT_TRACK=1`), or cloud API requests that could transmit patient health data (PHI).
- Expose internal host ports exclusively on loopback (`127.0.0.1`: `19530` Milvus, `27017` MongoDB, `11434` Ollama, `8080`/`8081` `llama.cpp`, `4000` LiteLLM, `8000` FastAPI, `3000` Web M3). Only `caddy` (`80`/`443`) binds publicly in production.
