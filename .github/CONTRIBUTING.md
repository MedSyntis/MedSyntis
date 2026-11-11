# Contributing to MedSyntis

Thank you for your interest in contributing to **MedSyntis**!

Our complete contributor onboarding, architecture rules (DDD / Hexagonal / TDD), 100% English Ubiquitous Language conventions, local infrastructure setup, and quality gates are documented in the root guide:

👉 **[Read the Contributor & Development Guide (`HOW-TO-CONTRIBUTE.md`)](../HOW-TO-CONTRIBUTE.md)**

## Quick Reminders Before Opening an Issue or Pull Request

- **Zero Patient Data (GDPR / HDS)**: Never commit, attach, or paste real patient identifiable data or unredacted medical PDFs. Always use synthetic test fixtures.
- **100% Local-First Execution**: Production code must never invoke external cloud LLM or embedding APIs.
- **Primary Web UI**: New UI features target the Material Design 3 Fastify Web UI (`web/`); the legacy Streamlit interface (`application/src/ui/`) is deprecated.
- **Issue Governance**: Use the English GitHub Issue Templates (`.github/ISSUE_TEMPLATE/`) for **Stories** (business need + Milestone), **Features** (`Parent Story: #XX` + Milestone + DoD), and **Bugs** (Description + DoD).
- **Quality Gates**: Ensure `ruff check`, `ruff format --check`, `pyrefly`, `pytest`, `npm --prefix web run lint`, `npm --prefix web run test`, and `prek run` pass cleanly.
