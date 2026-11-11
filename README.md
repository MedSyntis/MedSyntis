# MedSyntis — Local-First Clinical Synthesis Assistant for Multidisciplinary Team Meetings (MDT / RCP)

<p align="left">
  <a href="https://github.com/MedSyntis/MedSyntis/actions/workflows/ci.yml"><img src="https://github.com/MedSyntis/MedSyntis/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI/CD Pipeline" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=MedSyntis_MedSyntis"><img src="https://sonarcloud.io/api/project_badges/measure?project=MedSyntis_MedSyntis&metric=alert_status" alt="Quality Gate Status" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=MedSyntis_MedSyntis"><img src="https://sonarcloud.io/api/project_badges/measure?project=MedSyntis_MedSyntis&metric=bugs" alt="Bugs" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=MedSyntis_MedSyntis"><img src="https://sonarcloud.io/api/project_badges/measure?project=MedSyntis_MedSyntis&metric=vulnerabilities" alt="Vulnerabilities" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=MedSyntis_MedSyntis"><img src="https://sonarcloud.io/api/project_badges/measure?project=MedSyntis_MedSyntis&metric=security_rating" alt="Security Rating" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=MedSyntis_MedSyntis"><img src="https://sonarcloud.io/api/project_badges/measure?project=MedSyntis_MedSyntis&metric=sqale_rating" alt="Maintainability Rating" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=MedSyntis_MedSyntis"><img src="https://sonarcloud.io/api/project_badges/measure?project=MedSyntis_MedSyntis&metric=reliability_rating" alt="Reliability Rating" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=MedSyntis_MedSyntis"><img src="https://sonarcloud.io/api/project_badges/measure?project=MedSyntis_MedSyntis&metric=duplicated_lines_density" alt="Duplicated Lines (%)" /></a>
  <a href="https://codecov.io/gh/MedSyntis/MedSyntis"><img src="https://codecov.io/gh/MedSyntis/MedSyntis/branch/main/graph/badge.svg" alt="Codecov Coverage" /></a>
  <a href="application/tests"><img src="https://img.shields.io/badge/Tests-Pytest%20Passing-brightgreen?style=flat-square&logo=pytest&logoColor=white" alt="Tests Status" /></a>
  <a href="https://github.com/astral-sh/ruff"><img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json&style=flat-square" alt="Ruff Linter" /></a>
  <a href="https://github.com/aquasecurity/trivy"><img src="https://img.shields.io/badge/Security-Trivy%20Scanned-2684FF?style=flat-square&logo=aquasecurity&logoColor=white" alt="Trivy Vulnerabilities" /></a>
</p>

<p align="left">
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/Python-%3E%3D%203.13-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python Version" /></a>
  <a href="https://github.com/astral-sh/uv"><img src="https://img.shields.io/badge/Managed%20by-uv-DE5FE9?style=flat-square&logo=astral&logoColor=white" alt="uv Package Manager" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Web%20UI-Node.js%2026%20%2B%20Fastify%20M3-386B66?style=flat-square&logo=fastify&logoColor=white" alt="Fastify Material Design 3 Web UI" /></a>
  <a href="https://streamlit.io/"><img src="https://img.shields.io/badge/Legacy%20UI-Streamlit%20(Deprecated)-94a3b8?style=flat-square&logo=streamlit&logoColor=white" alt="Legacy Streamlit (Deprecated)" /></a>
  <a href="https://www.langchain.com/"><img src="https://img.shields.io/badge/Orchestration-LangChain-1C3C3C?style=flat-square&logo=chainlink&logoColor=white" alt="LangChain" /></a>
  <a href="https://milvus.io/"><img src="https://img.shields.io/badge/Vector%20DB-Milvus%20Standalone-00b4d8?style=flat-square&logo=vector-store&logoColor=white" alt="Milvus" /></a>
  <a href="https://www.mongodb.com/"><img src="https://img.shields.io/badge/Metadata%20DB-MongoDB%20Cache-47A248?style=flat-square&logo=mongodb&logoColor=white" alt="MongoDB" /></a>
</p>

<p align="left">
  <a href="#-sovereignty-privacy--medico-legal-positioning"><img src="https://img.shields.io/badge/Privacy-100%25%20Local%20First-2ea44f?style=flat-square&logo=shield&logoColor=white" alt="100% Local First" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue?style=flat-square&logo=open-source-initiative&logoColor=white" alt="Apache-2.0 License" /></a>
  <a href="https://discord.gg/C2RPhyn9x8"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord Community" /></a>
</p>

**MedSyntis** is a free, open-source, **100% local-first** clinical synthesis assistant designed for hospital Multidisciplinary Team Meetings (**MDT / RCP — Réunions de Concertation Pluridisciplinaire**). Built in close collaboration with surgeons, medical oncologists, gastroenterologists, neuromuscular specialists, and MDT medical secretaries, MedSyntis structures complex patient files and cross-references national clinical guidelines to streamline pre-MDT preparation and live board discussions across two specialized clinical domains:

* **Digestive Oncology** — grounded in the French **TNCD** (*Thésaurus National de Cancérologie Digestive*) reference guidelines.
* **Spinal Muscular Atrophy (SMA)** — grounded in the French **PNDS** (*Protocole National de Diagnostic et de Soins*) reference guidelines for rare neuromuscular diseases.

---

## 🎯 The Three Clinical Promises of MedSyntis

### 1. Documentary Exhaustiveness
* **Multi-PDF Patient Record Ingestion**: Import single or batch PDF reports (pathology, imaging, surgery, biology, genetic and motor function assessments) with automatic SHA-256 duplicate detection and OCR for scanned documents.
* **Identity Reconciliation**: Automated extraction and normalization of patient administrative identity (`nom`, `prenom`, `date_naissance`) to link new reports to existing patient files or flag identity discrepancies for secretary verification.
* **Longitudinal Multi-MDT History Consolidation**: Every patient dossier aggregates all past and current MDT forms along an interactive chronological timeline, automatically computing clinical deltas (such as tumor marker dynamics in oncology or HFMSE / CHOP-INTEND / RULM motor score trajectories in SMA).

### 2. Guideline Compliance
* **Automated Completeness Checks (`MTDCompleted`)**: Pre-MDT detection of missing mandatory examinations or biological/genetic markers required for a valid board discussion, preventing last-minute case deferrals.
* **Structured Stage & Gene Extraction**: Domain-specific extraction of TNM/pTNM staging, histology, WHO/ECOG performance status, and biomarkers in Digestive Oncology, or *SMN1*/*SMN2* copy numbers, motor milestones, respiratory/bulbar status, and disease-modifying therapies (Nusinersen, Risdiplam, Onasemnogene abeparvovec) in SMA.
* **Grounded Specialist Opinions**: Pre-MDT care orientation proposals (`CareOrientationProposal`) and organ/specialty expert opinions systematically backed by verbatim excerpts and clickable page citations from the **TNCD** or **PNDS** guidelines and the patient's own reports.

### 3. Operational Fluidity
* **Smart MDT Session Agenda Scheduling**: Organize the upcoming MDT session using four configurable passage-order strategies:
  * `hybrid`: Groups cases by required medical specialty while prioritizing urgent cases at the top of each specialty block.
  * `urgency_first`: Orders all enrolled cases strictly by descending clinical urgency score.
  * `expert_grouping`: Clusters cases sharing the same specialists into contiguous passage windows to minimize physician waiting time.
  * `manual`: Full drag/move and pin control by the MDT coordinator or medical secretary.
* **Specialty Quorum Verification**: Real-time calculation of specialist attendance windows and visual quorum warnings when a required specialist is absent for an enrolled case.
* **Interactive PDF Source Viewer**: Side-by-side PDF reader with HTTP Byte-Range streaming that jumps directly to cited pages inside the original medical report or clinical guideline.
* **Unconditional Preservation of Human Edits (`manual_edits`)**: Any correction made by a clinician or medical secretary is explicitly badged, audited, and locked against being overwritten by subsequent AI re-analyses, with one-click section rollback available at any time.

---

## 🛡️ Sovereignty, Privacy & Medico-Legal Positioning

> [!IMPORTANT] **100% Local Execution — Zero External Cloud API Calls**
> MedSyntis operates **entirely within the hospital's secure local infrastructure**. Patient PDFs, extracted clinical data, vector embeddings, and AI reasoning never leave the local network and never call external cloud APIs (zero data transmission to OpenAI, Anthropic, Google Cloud, or any third-party service).

* **Regulatory & Privacy Compliance**: Designed in strict alignment with the **European GDPR (RGPD)**, **CNIL** health data protection standards, **HDS** (*Hébergement de Données de Santé* — Art. L. 1111-8 of the French Public Health Code), and **PGSSI-S** security requirements.
* **Human Oversight (*Garantie Humaine* — Art. L. 4001-2 CSP & EU AI Act)**: Every AI-generated field displays its documentary source and remains editable and reversible by healthcare professionals.
* **Strictly Non-Prescriptive Pre-MDT Positioning**: MedSyntis is a documentary synthesis and pre-MDT preparation aid. It never replaces the physician and never issues a medical prescription—**the final therapeutic decision always belongs exclusively to the collegial MDT board**.

---

## 🖥️ User Interface Overview

MedSyntis provides a hospital-grade **Material Design 3 Web UI (`web/`)** as its **primary clinical interface**, engineered for zero-glare readability in dark projection rooms as well as clinician workstations and tablets (**WCAG 2.2 AA** compliant with **Light, Dark, and Auto** themes, available in French and English).

> [!NOTE]
> The earlier Streamlit interface (`application/src/ui/`, `application/app-ui.py`) is **deprecated / legacy** and retained only as an optional compatibility profile (`--profile streamlit`). All active clinical UX development targets `web/`.

* **MDT Worklist (`/worklist`)**: High-density clinical table and card views with clickable KPI filters (Total Dossiers, High Urgency, Incomplete Files, Suggested Care Adaptations), multi-column sorting, and quick actions.
* **Longitudinal Patient Dossier (`/patients/:id`)**: Unified synoptic patient banner, longitudinal clinical delta indicators, collapsible MDT session timeline, side-by-side native PDF viewer (with bounding-box highlights), structured clinical sections with protected manual editing, interactive missing-record checklist, and floating **AI Co-Pilot Side Sheet** for querying either the current MDT form or the full longitudinal patient history.
* **MDT Session Agenda (`/agenda`)**: Interactive session planner with specialist attendance selection, quorum verification, passage-window visualization, automatic sorting (`hybrid`, `urgency_first`, `expert_grouping`, `manual`), optional deferral of incomplete files (`defer_incomplete_files`), case pinning, and live session navigation (`← Previous Patient` / `Next Patient →`).
* **Scientific Guidelines RAG (`/guidelines`) & AI Experts Catalog (`/agents`)**: Full-screen TNCD / PNDS reference library with a source-grounded RAG assistant, plus full transparency into every specialist agent's system instructions and attached reference documents.
* **Live GPU Queue Monitor (`/admin/queue`) & Clinical Feedback (`/feedback`)**: Real-time Server-Sent Events (SSE) tracking of background document extraction waves, live AI reasoning stream, and built-in anomaly reporting.

👉 **[Read the Complete Clinical User Guide (`docs/guide_clinique.md`)](docs/guide_clinique.md)**

---

## 📚 Documentation for Contributors & Hospital IT / Developers

If you are a software contributor, clinical AI researcher, or hospital IT / DevOps engineer deploying or extending MedSyntis, please refer to our dedicated technical documentation:

* [**Contributor & Development Guide (`HOW-TO-CONTRIBUTE.md`)**](HOW-TO-CONTRIBUTE.md)
* [**Technical Architecture & Configuration Reference (`docs/guide_technique.md`)**](docs/guide_technique.md)
* [**REST & SSE API v1 Specification (`docs/api/endpoints.md`)**](docs/api/endpoints.md)
* [**Material Design 3 Web UI Design System (`web/docs/design-system.md`)**](web/docs/design-system.md)
* [**AI Agent & DDD Guidelines (`AGENTS.md`)**](AGENTS.md)

---

## 👥 Community & License

* 💬 **Discord Community**: Join clinicians and contributors on the [Official MedSyntis Discord Server](https://discord.gg/C2RPhyn9x8).
* 📄 **License**: MedSyntis is distributed under the open-source [Apache-2.0 License](LICENSE).
