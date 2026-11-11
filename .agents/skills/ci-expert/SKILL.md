---
name: ci-expert
description: "Manages continuous integration configurations, Ruff/Biome lint and formatting runs, local automated Pytest/Vitest/Playwright suites, and dependency alignments."
---

# CI Expert Skill (`ci-expert`)

This skill governs continuous integration pipelines (`.github/workflows/ci.yml`), pre-commit hooks (`.pre-commit-config.yaml`), static analysis, and automated test suites across both the Python backend (`application/`) and the Material Design 3 Web UI (`web/`).

## Verification & Pipelines

### 1. Python Backend Style, Typing & Linting (`application/`)
All additions or modifications to Python code must pass Ruff formatting, Ruff linting, and Pyrefly type checks from the repository root:
- **Linting check**: `uv run --project application ruff check application/src/ application/tests/`
- **Formatting check**: `uv run --project application ruff format --check application/src/ application/tests/`
- **Static type check**: `uv run --project application pyrefly check application/src`

### 2. Web UI Style, Typing & WCAG Contrast (`web/`)
All changes to the Material Design 3 Fastify/TypeScript Web UI must pass Biome, TypeScript, and automated WCAG 2.2 AA contrast verification:
- **Lint, typecheck & WCAG contrast**: `npm --prefix web run lint`
- **Formatting check**: `npm --prefix web run format`

### 3. Automated Testing (`application/tests/` & `web/tests/`)
Test suites for domain models, use cases, FastAPI contracts, LangChain agents, and the BFF Web UI must pass before merging:
- **Python unit & API contract tests**: `uv run --project application pytest application/tests/`
- **Python coverage report**: `PYTHONPATH=application uv run --project application pytest --cov=application/src --cov-report=term-missing application/tests/`
- **Web UI unit & integration tests (Vitest)**: `npm --prefix web run test`
- **Web UI end-to-end tests (Playwright)**: `npm --prefix web run e2e`
- Ensure all test assertions avoid external cloud LLM calls, enforcing strict local/mocked execution boundaries.

### 4. Dependency, Lockfile & Security Gates
- Python dependencies must be declared in `application/pyproject.toml` (`>=3.13`) and locked via `application/uv.lock` (`uv sync --project application --frozen`).
- Web dependencies must be declared in `web/package.json` (Node.js `>=26`) and installed deterministically via `npm --prefix web ci` (`web/package-lock.json`).
- Trivy (`vuln,secret`) scans the repository including root `dist/` (skipping only build artifacts such as `web/dist` and `.venv`), and Docker builds (`dist/docker/Dockerfile.api`, `dist/docker/Dockerfile.web`, `dist/docker/Dockerfile`) must succeed cleanly in CI.
