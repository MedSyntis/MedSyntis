---
name: doctor
description: "Checks medical data validity, oncology guidelines compliance (TNCD), and verifies patient record grounding to ensure clinical safety."
---

# Doctor (Clinical Expert) Skill

This skill ensures medical safety, compliance with French national digest-cancer guidelines (TNCD), and validation of clinical agent extractions.

## Clinical Safety Principles

### 1. Guideline Compliance & Organ-Scoped TNCD Grounding
Clinical proposals and scientific evidence suggested by the **6 Digestive Oncology practice-specialty agents** (`digestive surgeon expert`, `medical oncologist expert`, `radiation oncologist expert`, `radiologist expert`, `gastroenterologist expert`, `pathologist expert`) must align with the **Thésaurus National de Cancérologie Digestive (TNCD)** (`resolve_oncology_resources` in `src/domain/oncology/agents.py`):
- **Oesophagus & GEJ (`PrimaryOrganEnum.oesophagus`)**: Ground exclusively on `TNCDOESOPHAGE.pdf` (Chapter 1).
- **Stomach (`PrimaryOrganEnum.stomach`)**: Ground exclusively on `TNCDESTOMAC.pdf` (Chapter 2).
- **Colon (`PrimaryOrganEnum.colon`)**: Ground exclusively on `TNCDCOLON.pdf` (Chapter 3 — localized) and `TNCDCOLORECTALMETA.pdf` (Chapter 4 — metastatic).
- **Rectum (`PrimaryOrganEnum.rectum`)**: Ground exclusively on `TNCDRECTUM.pdf` (Chapter 5 — rectum) and `TNCDCOLORECTALMETA.pdf` (Chapter 4 — metastatic).
- **Liver / HCC (`PrimaryOrganEnum.liver`)**: Ground exclusively on `TNCDCHC.pdf` (Chapter 7).
- **Biliary Tract (`PrimaryOrganEnum.intra_hepatic_bile_duct`, `PrimaryOrganEnum.extra_hepatic_bile_duct`)**: Ground exclusively on `TNCDVOIESBILIAIRES.pdf` (Chapter 8).
- **Pancreas (`PrimaryOrganEnum.pancreas`)**: Ground exclusively on `TNCDPANCREAS.pdf` (Chapter 9).
- **Unknown or Unrecognized Primary Organ (`PrimaryOrganEnum.unknown` / `None`)**: `DEFAULT_TNCD_RESOURCES` is empty (`()`), attaching **zero** TNCD PDFs (`ressources=[]`) so `search_on_ressources` is physically detached and `Reference` citations are never fabricated from another organ's chapter.

### 2. Patient Record Grounding
- **Strict Adherence**: The `PatientMDTForm` record is the absolute source of truth.
- **No Interpretation**: Administrative and diagnostic extractions must not assume missing details or infer unlisted clinical symptoms.
- **Missing Data**: Missing staging/biomarkers are recorded under `what_missing` in `MTDCompleted`. Legacy organ-agent records are migrated directly via `make migrate`.
