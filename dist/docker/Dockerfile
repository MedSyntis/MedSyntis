# ==============================================================================
# Stage 1: Build Python Virtualenv with Legacy Streamlit UI Group (Debian 13 Trixie)
# ==============================================================================
FROM python:3.13-slim-trixie AS builder

COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /bin/uv

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_DOWNLOADS=never \
    UV_NO_MANAGED_PYTHON=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_CACHE_DIR=/tmp/.uv-cache \
    UV_LINK_MODE=copy

WORKDIR /app

COPY application/pyproject.toml application/uv.lock ./
RUN uv sync --frozen --no-dev --group ui --no-install-project && rm -rf /tmp/.uv-cache

COPY application application
RUN uv sync --frozen --no-dev --group ui && rm -rf /tmp/.uv-cache

# ==============================================================================
# Stage 2: Hardened Non-Root Streamlit Runtime without Compilers (UID/GID 1002)
# ==============================================================================
FROM python:3.13-slim-trixie AS runtime

COPY --from=builder /bin/uv /bin/uv

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    curl \
    libxcb1 \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/* \
    && uv pip uninstall --system pip \
    && rm -rf /usr/local/lib/python3.13/ensurepip

RUN groupadd -g 1002 appuser && \
    useradd -u 1002 -g appuser -m -d /home/appuser -s /usr/sbin/nologin appuser && \
    mkdir -p /app && chown -R appuser:appuser /app /home/appuser && \
    chmod 0755 /home/appuser

ENV UV_PYTHON_DOWNLOADS=never \
    UV_NO_MANAGED_PYTHON=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_CACHE_DIR=/tmp/.uv-cache \
    HOME=/home/appuser \
    XDG_CACHE_HOME=/tmp/.cache \
    APP_RCP_DOCLING_ARTIFACTS_PATH=/app/.cache/docling/models \
    PATH="/app/.venv/bin:$PATH" \
    UV_PYTHON=/app/.venv/bin/python \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false \
    ANONYMIZED_TELEMETRY=False \
    SCARF_NO_ANALYTICS=true \
    DO_NOT_TRACK=1

WORKDIR /app
COPY --chown=appuser:appuser --from=builder /app/.venv /app/.venv
COPY --chown=appuser:appuser --from=builder /app/pyproject.toml /app/uv.lock ./
COPY --chown=appuser:appuser --from=builder /app/application /app/application

RUN /app/.venv/bin/docling-tools models download -o /app/.cache/docling/models \
        layout tableformer rapidocr --rapidocr-backend-lang onnxruntime:ch && \
    /app/.venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('intfloat/multilingual-e5-base', local_dir='/app/.cache/docling/models/intfloat--multilingual-e5-base', allow_patterns=['*.json', '*.txt', 'sentencepiece*', '*tokenizer*'])" && \
    rm -rf /root/.cache && \
    chown -R appuser:appuser /app/.cache && \
    chmod -R a+rX /app/.cache

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

USER 1002:1002
WORKDIR /app/application

EXPOSE 8501

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["curl", "-sf", "http://127.0.0.1:8501/_stcore/health"]

# Launch the optional legacy Streamlit clinical dashboard
CMD ["uv", "run", "--no-sync", "--no-build", "streamlit", "run", "app-ui.py", "--server.port=8501", "--server.address=0.0.0.0", "--server.headless=true"]
