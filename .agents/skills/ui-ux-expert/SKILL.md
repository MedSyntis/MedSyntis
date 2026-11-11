---
name: ui-ux-expert
description: "Enforces the MedSyntis UI/UX design system, `MedSyntis` brand identity, clinical ergonomics, Material Design 3 Web UI (`web/` primary interface with `ds-*` tokens and WCAG 2.2 AA Light/Dark/Auto themes), and legacy/deprecated Streamlit views (`application/src/ui/` and `application/app-ui.py`)."
---

# MedSyntis UI & UX Expert Skill (`ui-ux-expert`)

This skill defines the brand identity, visual design system, clinical UX patterns, and interface architecture for **MedSyntis**:
- **Primary Clinical Interface (`web/`)**: Fastify 5 + TypeScript 5.8 **Material Design 3 (M3) Web UI** (`web/src/`, `web/public/css/tokens.css`, `web/public/css/components.css`) — hospital-grade SSR/HTMX-style BFF with zero external CDNs, WCAG 2.2 AA Light/Dark/Auto themes, and a 73-icon SVG sprite.
- **Deprecated / Legacy Interface (`application/src/ui/` & `application/app-ui.py`)**: Streamlit dashboard retained solely for backward compatibility (`--profile streamlit`). All new clinical UX work targets `web/`.

---

## 1. Brand Identity & Positioning (`MedSyntis`)

- **Application Name & Wordmark**: **MedSyntis** — always render the unified wordmark pairing `Med` (slate) and `Syntis` (muted mineral teal) with a domain subtitle (`Oncologie` or `Amyotrophie spinale`). Never revert to legacy `DataSyntis` / `OncoFlow` naming in UI headers or logos.
- **Mission**:
  > *"Libérer du temps médical utile en transformant le chaos documentaire en dossiers directement exploitables pour la décision RCP."*
- **Positioning**:
  > *"L'outil d'analyse des dossiers qui prépare le terrain pour faciliter / optimiser la décision médicale."*
- **Three Core Product Promises**:
  1. **Exhaustivité documentaire** : Multi-PDF ingestion and chronological patient-centric consolidation.
  2. **Conformité aux recommandations** : Systematic completeness checks and non-prescriptive care orientation proposals grounded in scientific guidelines (**TNCD** in Oncology, **PNDS** in SMA).
  3. **Fluidité logistique** : MDT/RCP agenda ordering driven by clinical urgency and specialist quorum availability.
- **Tone of Voice & Persona Ergonomics ("Zero-Friction 1-Second Readability")**:
  - Rigorous, sober, respectful of medical authority, and strictly non-prescriptive (EU MDR 2017/745 & CSP Art. L. 4001-2 human oversight).
  - Optimized for two primary hospital personas:
    1. **MDT Physician / Specialist** (urgency level, pre-MDT care orientation, clinical/biological markers, longitudinal delta vs. prior MDT, specialty opinions, and cited guidelines).
    2. **MDT Medical Secretary / Coordinator** (record completeness, missing exam checklist, required specialist quorum, session scheduling, and patient identity verification).

---

## 2. Primary Interface: Material Design 3 Web UI (`web/`)

### A. Self-Hosted `ds-*` Design System & Privacy-First CSP
- **Zero External Requests**: Self-hosted system/local sans-serif typography, local SVG sprite (`web/public/icons/`), and strict Content-Security-Policy (`default-src 'self'`; zero Google Fonts or external CDNs).
- **Theme Tokens (`web/public/css/tokens.css` & `components.css`)**:
  - Supports **Light**, **Dark**, and **Auto (`prefers-color-scheme`)** themes using semantic `ds-*` custom properties.
  - Automated WCAG 2.2 AA contrast verification runs on every lint pass via `web/scripts/check-contrast.mjs` (`npm --prefix web run lint`).
- **Core Color Semantics**:
  - **Brand Slate** (`#2B3748` Light / `#0B1120` Dark): Navigation rail/header chrome and `Med` wordmark segment.
  - **Muted Mineral Teal** (`#467E79` Light / `#72A8A2` Dark): Primary actions, active states, focus rings, and `Syntis` wordmark segment.
  - **Sage Green** (`#4D7C6F` Light / `#6B9080` Dark): Validated completeness (`Dossier conforme`), positive states, and validation checkmarks.
  - **MedSyntis Rose** (`#B83B5E` Light / `#F43F5E` Dark): High clinical priority (`Priorité haute`), critical missing-record alerts, and **all destructive/irreversible actions**.
  - **Matte Anti-Glare Surfaces**: Soft stone-slate workspace canvas (`#E6ECF0` Light / `#0F172A` Dark) paired with elevated matte cards (`#FBFDFF` Light / `#162032` Dark) to reduce eye strain during long MDT preparation sessions.

### B. Web Clinical Journeys & Accessibility Guardrails
- **Core Views (`web/src/routes/` & `web/src/views/`)**:
  1. **MDT Triage & Patient Cards**: KPI summary strip, instant search/completeness/sort toolbar, equal-height cards, and batch PDF upload progress.
  2. **Next MDT Agenda (`/mdt-agenda`)**: Session date scheduling, hybrid/urgency/quorum/manual ordering, specialist attendance toggles, and pin/move controls.
  3. **Patient Clinical Dashboard**: Unified patient banner, longitudinal multi-MDT timeline, 3-row synoptic triage card, collapsible clinical/expert accordions with manual-edit & rollback controls, side-by-side PDF viewer, and live SSE `<think>` progress streaming.
  4. **Scientific References & Governance**: Reference indexation/chat (`TNCD`/`PNDS`), agent catalog, GPU queue monitor, and bug report tracking.
- **Logo & Icon Guardrails**:
  - Never use 4-arm rotational geometries.
  - Never place a validation checkmark (`✓`) inside a red or rose badge (validation is always sage-green; rose is reserved for urgency/destructive actions).

---

## 3. Legacy / Deprecated Interface: Streamlit (`application/src/ui/`)

> **Deprecation Notice**: `application/app-ui.py` and `application/src/ui/` are deprecated in favor of `web/`. Only touch Streamlit files when maintaining backward compatibility or fixing regressions.

1. **Strict Architectural Boundary**:
   - **NEVER import `streamlit` (`import streamlit as st`) or access `st.session_state` outside `application/src/ui/` and `application/app-ui.py`**. Domain (`application/src/domain/`), use-case (`application/src/application/`), router (`application/src/routers/`), and infrastructure (`application/src/infrastructure/`) modules must remain 100% framework-agnostic.
2. **Dark-Mode Portal Safety (`st.popover` & `st.dialog`)**:
   - Scope `light-dark(#FBFDFF, #162032)` card surface selectors in `application/src/ui/patient_mdt/translations.py` (`apply_card_surface_style()`) to `div.stApp ... :not([class*="st-key-clinical_scroll_"])`, and keep inner `stPopoverBody` / `div[role="dialog"]` blocks transparent so React portal overlays never render white in Dark Mode.
   - Never pass an empty label `""` to `st.popover()`.
3. **Destructive Button Convention**:
   - Prefix delete/purge trigger keys with `btn_del_...` and confirmation dialog buttons with `btn_danger_...` so MedSyntis Rose destructive styling applies automatically.
4. **Clinical Specialty Badges (`get_agent_icon_and_label()`)**:
   - Use concise specialty labels (`🧠 Neurologie`, `🧬 Génétique`, `🫁 Pneumologie`, `🦿 MPR / Rééducation`, `🦴 Orthopédie`, `🩺 Pancréas`, `⚖️ Coordinateur RCP`, `🗂️ Extraction administrative & clinique`, `📚 Assistant référentiels`) — never detective emojis (`🕵️`).
