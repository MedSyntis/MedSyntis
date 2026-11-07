# 🩺 MedSyntis — Clinical User Guide

Welcome to the **MedSyntis** Clinical User Guide. This guide explains how hospital teams—**MDT Medical Secretaries**, **Oncologists**, **Digestive Surgeons**, **Gastroenterologists**, **Radiologists**, **Pathologists**, and **Neuromuscular / SMA Specialists**—use MedSyntis to prepare and conduct **Multidisciplinary Team Meetings (MDT / RCP — Réunions de Concertation Pluridisciplinaire)**.

MedSyntis supports two specialized clinical domains out of the box:
* **Digestive Oncology** — grounded in the French **TNCD** (*Thésaurus National de Cancérologie Digestive*) clinical guidelines.
* **Spinal Muscular Atrophy (SMA)** — grounded in the French **PNDS** (*Protocole National de Diagnostic et de Soins*) neuromuscular reference guidelines.

---

## 🌟 Clinical Workflow Overview

Preparing an MDT session involves collecting heterogeneous medical reports, verifying that mandatory exams are available, synthesizing longitudinal patient history, and scheduling specialist attendance. MedSyntis structures this workflow into four seamless stages:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                            The MedSyntis Pre-MDT & Live-MDT Workflow                   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  [1] Multi-PDF Upload ──► [2] Dossier Review & ──► [3] Session Agenda ──► [4] Live MDT │
│      & 3-Wave AI              Human Verification       & Quorum Triage        & TNCD / │
│      Extraction               (manual_edits)           (4 Strategies)         PNDS RAG │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔒 Data Sovereignty & Medico-Legal Guarantees

> [!CAUTION] **100% Local-First — Zero Cloud Data Transmission**
> Patient records never leave the hospital's internal network. All PDF parsing, OCR, vector indexing, and LLM reasoning execute **100% locally** on hospital hardware (zero calls to OpenAI, Anthropic, Google Cloud, or external servers), ensuring full compliance with **GDPR (RGPD)**, **CNIL**, and **HDS** (*Hébergement de Données de Santé*).

> [!IMPORTANT] **Human Oversight (*Garantie Humaine* — Art. L. 4001-2 CSP) & Non-Prescriptive Positioning**
> * **Strictly Non-Prescriptive**: MedSyntis provides a pre-MDT documentary synthesis and care orientation proposal (`CareOrientationProposal`). It never issues a medical prescription and never replaces the collegial discussion of the MDT board.
> * **Traceable & Reversible**: Every AI-extracted field cites its source document and page, can be edited manually by a clinician or secretary (`manual_edits`), and is permanently protected against being overwritten during subsequent AI re-analyses.

---

## 👩‍💼 Stage 1: Uploading Patient Records & 3-Wave Local AI Extraction (`/ingest`)

 primarily used by **MDT Medical Secretaries** and referring clinicians prior to the meeting.

### 1. Multi-PDF Drag-and-Drop Upload
Navigate to **Import PDF (`/ingest`)** or trigger **Import PDF** directly from the Worklist or a Patient Dossier:
* **Single or Batch Upload**: Drop one or multiple PDF reports (pathology reports, CT/MRI/PET-scan reports, operative notes, biological panels, genetic *SMN1*/*SMN2* reports, or HFMSE / CHOP-INTEND / RULM motor assessments).
* **Automatic SHA-256 Duplicate Detection**: MedSyntis computes a cryptographic hash of every uploaded PDF. If an identical document is already registered in the domain, MedSyntis immediately notifies you and links to the existing record instead of creating duplicates.
* **Automatic or Manual Patient Association**:
  * **Automatic Mode (Default)**: Local AI extracts the patient's administrative identity (`nom`, `prenom`, `date_naissance`) and automatically links the new MDT form to an existing longitudinal patient record—or creates a new patient dossier if none matches.
  * **Manual Association**: You can explicitly select an existing patient dossier before uploading, or re-link a form later from the dossier header.

### 2. OCR & 3-Wave Asynchronous GPU Extraction
Once uploaded, documents enter the local **GPU PriorityQueue** and are processed through three progressive extraction waves:
* **Wave 1 — Administrative & Identity Reconciliation (`PatientAdministrative`)**: Extracts `nom`, `prenom`, birth name, `date_naissance`, gender, and MDT date (`date_rcp`) to consolidate the patient's identity immediately.
* **Wave 2 — Structured Clinical & Completeness Extraction (`PatientMDTForm`)**:
  * **In Digestive Oncology**: Extracts WHO/ECOG performance status (`PatientPerformanceStatus`), tumor site and histology, clinical/pathological TNM staging, surgical history, chemotherapy/radiotherapy regimens, biology/biomarkers (ACE, CA 19-9, MMR/MSI, *RAS*/*BRAF*, DPD), and imaging findings.
  * **In Spinal Muscular Atrophy (SMA)**: Extracts *SMN1* deletion/mutation status and *SMN2* copy number, SMA clinical type (Type 0–4), motor function scores (`HFMSE`, `CHOP-INTEND`, `RULM`, 6MWT), respiratory and bulbar/nutritional assessments, orthopedic/scoliosis status, and disease-modifying therapy history (Nusinersen, Risdiplam, Onasemnogene abeparvovec).
  * **Completeness Check (`MTDCompleted`)**: Identifies missing mandatory documents or biological/genetic results required before the MDT board can deliberate.
* **Wave 3 — Pre-MDT Orientation & Specialist Opinions (`CareOrientationProposal` & `ExpertAnswer`)**: Synthesizes case urgency, required medical specialties, and guideline-grounded specialist opinions cross-referenced against **TNCD** or **PNDS**.

---

## 📋 Stage 2: Reviewing the Worklist & Structured `PatientMDTForm` (`/worklist` & `/patients/:id`)

Used jointly by **MDT Medical Secretaries** (to verify identity and chase missing exams) and **MDT Physicians** (to review clinical syntheses before the board).

### 1. Clinical Worklist (`/worklist`)
* **Interactive KPI Cards**: Filter the worklist in one click by **Total Dossiers**, **High Urgency**, **Incomplete Dossiers**, or **Suggested Care Adaptations**.
* **High-Density Table & Card Views**: Sort cases by Priority, Patient Name, Completeness Status, Pre-MDT Orientation, Required Specialties, or Last MDT Date. Double-click any row to open the patient's longitudinal dossier.

### 2. Longitudinal Patient Dossier (`/patients/:id`)
The dossier view combines longitudinal context with side-by-side source verification:
* **Synoptic Header & Longitudinal Clinical Deltas**: Displays patient identity, urgency badge, completeness indicator, pre-MDT orientation, required specialties, and automated **longitudinal deltas** across MDT sessions (e.g., CA 19-9 trend in oncology or ΔHFMSE / ΔRULM motor score evolution in SMA).
* **Collapsible Multi-MDT Timeline**: Switch effortlessly between all historical MDT forms (`rcps`) for the patient to compare disease evolution over time.
* **Side-by-Side Native PDF Viewer with Bounding-Box Highlights**:
  * The left pane displays the original PDF report (with a one-click **Expand PDF** toggle).
  * Switch between the plain PDF and the **Bounding-Box (`bbox`) Highlight** view, or click any citation badge in the clinical synthesis to jump directly to the corresponding page in the PDF.

### 3. Missing-Document Warnings & Checklist Management
* Under the **Pre-MDT Orientation & Opinions** tab, MedSyntis highlights every missing exam or data point flagged by `MTDCompleted` (for example, a missing definitive EUS biopsy pathology report or a missing anti-AAV9 antibody titer).
* **Secretary Checklist**: Once a missing report is obtained or verified as non-applicable, the medical secretary or clinician can **hide/restore individual missing items** (`toggle_item`) or clear the warning banner—all actions are attributed (`edited_by`) and persisted.

### 4. Human-in-the-Loop Manual Editing (`manual_edits`) & Section Rollback
Clinicians and secretaries have full editorial control over every section of the `PatientMDTForm`:
* **Administrative Identity Correction**: Edit `nom`, `prenom`, `date_naissance`, gender, or MDT date, with the option to propagate the correction across all forms belonging to the patient (`apply_to_all_patient_forms`) or re-link the form to another existing patient dossier.
* **Clinical Section Editing (`manual_edits`)**: Click **Edit** on any clinical, completeness, or orientation section to refine extracted values.
* **Unconditional Preservation Across Re-Analyses**: Manually edited sections display a **`✍️ Manually Edited`** badge (`manual_edits`). Whenever you trigger a full or partial AI re-analysis (`preserve_manual_edits=true` by default), **MedSyntis never overwrites human edits**.
* **One-Click Section Rollback**: If you ever wish to discard a manual edit and restore the original AI extraction for a specific section, click **Rollback to AI Extraction** (`/sections/{section_name}/rollback`).

---

## 🗓️ Stage 3: Preparing the Next MDT Session Agenda (`/agenda`)

Used by the **MDT Coordinator / Session Chair** and **MDT Medical Secretary** to organize the upcoming board meeting.

### 1. Enrolling Cases & Selecting Attending Specialists
* **One-Click Session Setup (`Schedule New Meeting`)**: Set the upcoming **MDT Session Date**, select the **Attending Specialists** present for the session, and enroll candidate patients from the worklist (individually or in bulk: all candidates, urgent cases, or complete dossiers).
* **Specialty Quorum Verification**: MedSyntis cross-checks the specialties required by each enrolled patient against the list of attending specialists:
  * Computes contiguous **Specialist Passage Windows** (e.g., *Pancreas Expert: Cases #1 to #4*) so specialists know exactly when their presence is required.
  * Raises immediate **Quorum Warnings** (`quorum_warning_count`) on any case where a required specialist is not marked as attending.

### 2. Choosing Among the 4 Sorting Strategies (`sort_strategy`)
MedSyntis provides four scheduling strategies adaptable to your hospital's MDT organization:
1. **`hybrid` (Default — Specialty Grouping + Urgency)**: Groups cases requiring the same specialists into contiguous blocks while ordering cases by descending clinical urgency within each block.
2. **`expert_grouping` (Specialist Attendance Optimization)**: Clusters cases to maximize shared specialist overlap and minimize the time window each specialist must stay in the meeting room.
3. **`urgency_first` (Strict Clinical Urgency)**: Orders all enrolled patients strictly by descending clinical urgency score (`Critical` → `High` → `Moderate` → `Low`), regardless of specialty grouping.
4. **`manual` (Full Coordinator Control)**: Locks the exact custom passage order defined by the coordinator or secretary.

### 3. Deferring Incomplete Files & Pinning Cases
* **Defer Incomplete Files (`defer_incomplete_files`)**: Toggle this option to automatically push incomplete patient files (those with unresolved missing mandatory exams) to the end of the session agenda, ensuring complete and urgent dossiers are discussed first while quorum is full.
* **Pinning & Manual Reordering**: At any time, you can move a patient up or down (`direction: "up" | "down"`) or **Pin (`📌`)** a patient to a fixed slot. Pinned cases keep their exact slot even when automatic sorting strategies recalculate the rest of the agenda.

---

## 🧑‍⚕️ Stage 4: Live MDT Session, Specialist Opinions & Guidelines RAG

Used by **MDT Physicians** and the **Session Chair** during the multidisciplinary board meeting.

### 1. Conducting the Live MDT Session
* From `/agenda`, click **`Open 1st Dossier (#1)`** to launch the live session view.
* Use the top session navigation bar (**`← Previous Dossier` / `Next Dossier →`**) to step smoothly through the scheduled passage order without returning to the worklist.
* Switch to the **Dark Theme** in one click for comfortable, glare-free projection in the MDT room.

### 2. Consulting Grounded Pre-MDT Orientation & Specialist Opinions
Inside each patient's **Pre-MDT Orientation & Opinions** tab:
* Review the structured **`CareOrientationProposal`** (e.g., upfront surgery, neoadjuvant FOLFIRINOX chemotherapy, radiochemotherapy, or intrathecal/oral SMA therapy adjustment) and individual **`ExpertAnswer`** cards for each involved specialty.
* Every recommendation includes **clickable citation badges** linking directly to:
  * The exact page of the patient's medical PDF report where the clinical finding was documented.
  * The exact chapter and page of the national scientific guideline (**TNCD** for Digestive Oncology or **PNDS** for SMA).

### 3. Querying the AI Co-Pilot & National Reference Guidelines (`/guidelines`)
* **Contextual Dossier AI Co-Pilot (Floating Side Sheet)**: Click the **`AI Assistant`** button at the bottom right of any patient dossier to open the non-blocking side sheet:
  * Select the **target specialist agent** (e.g., `pancreas expert`, `colon expert`, `sma neurologist`).
  * Choose the **query scope**: **Current MDT Form Only** or **Full Longitudinal Patient Dossier** (which synthesizes all historical MDT forms and AI extractions).
  * Click any **suggested clinical question** or ask a free-text question to verify a detail during the board discussion.
* **Dedicated Scientific Guidelines Library (`/guidelines`)**: Browse all indexed **TNCD** and **PNDS** PDF reference guidelines in full screen and query the **Resource Assistant** to retrieve verbatim guideline recommendations with page citations at any time.

---

## 🛠️ Reporting Clinical or Interface Feedback (`/feedback`)

If you spot an extraction inaccuracy, a missing guideline chapter, or an ergonomic improvement idea, open **Feedback / Bug Reports (`/feedback`)** from the navigation bar (or from a patient's quick-action menu) to log a report linked directly to the relevant page or patient dossier for your hospital IT and clinical AI team.
