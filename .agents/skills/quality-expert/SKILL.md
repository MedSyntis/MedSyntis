---
name: quality-expert
description: "Ensures test coverage metrics, structured logging context formats (`APP_LOG_LEVEL` / `APP_LOG_TYPE`), exception safety, and performance constraints."
---

# Quality Expert Skill (`quality-expert`)

This skill ensures code reliability, structured observability, test coverage across `application/tests/` and `web/tests/`, and strict exception boundaries without leaking internal stack traces or PHI.

## Rules & Standards

### 1. Robust Application Logging (`APP_LOG_LEVEL` & `APP_LOG_TYPE`)
- Logging supports both human-readable `text` output (local development) and machine-parsable `json` structures (production containers) controlled by `APP_LOG_TYPE` (`text` | `json`) and `APP_LOG_LEVEL` (`DEBUG` | `INFO` | `WARNING` | `ERROR`).
- Always initialize handlers using `AppConfig.set_logger()` with structured context keys (`domain`, `model`, `job_id`, `page`) and never log raw patient health data (PHI) at `INFO`/`ERROR` levels:
```python
logger = app_conf.set_logger("api", default_context={"domain": app_conf.domain})
```

### 2. Exception Safety & User-Facing Error Handling
- All database, vector search, LLM inference, or PDF parsing failures must be caught cleanly at application/router boundaries before crashing a request or worker loop.
- FastAPI endpoints (`application/src/routers/`) and the primary Material Design 3 Web UI (`web/`) must surface sanitized, actionable error banners/toasts rather than raw Python/Node tracebacks (and likewise in legacy `application/src/ui/` views):
```python
try:
    rag.read_document()
except NonPatientMDTFormError as exc:
    logger.warning("Rejected non-MDT document upload: %s", exc)
    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
```

### 3. Test Coverage & Retrieval Performance Bounds
- Maintain automated unit and integration coverage in `application/tests/` (`make coverage`) and `web/tests/` (`npm --prefix web run test`).
- Search queries in RAG tools (`search_on_mtd`, `search_on_ressources`) must enforce bounded retrieval counts (e.g., `k=4`) and explicit HTTP/LLM timeouts to prevent context-window bloat and GPU queue stalls.
