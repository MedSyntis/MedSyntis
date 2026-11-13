---
name: llm-prompting-engineer
description: "Designs system prompts, shapes specialized agent personas, configures output schemas, and sets up LLM reasoning and retry behaviors."
---

# LLM Prompting Engineer Skill

This skill provides rules and best practices for configuring prompt structures, managing French system instructions, defining specialized clinical personas, and building self-correcting RAG interactions.

## Guidelines & Personas

### 1. French Language Consistency
By default, the MedSyntis web interface and patient records are in French. The agent must interact in French seamlessly without explaining its language choice.
- **Rule**: Standard instruction headers must start with:
  > `Answer in French language, not mention it in the answer.`

### 2. Anonymous Practice-Specialty Personas & KV-Cache Invariance
Digestive Oncology uses **6 anonymous hospital practice-specialty personas** (`Agents` in `src/domain/oncology/agents.py`, never named individuals):
- `digestive surgeon expert` — surgical resectability, vascular contact, R0/R1 margins, perioperative morbidity.
- `medical oncologist expert` — systemic chemotherapy, targeted therapy, immunotherapy, biomarkers, DPD/WHO fitness.
- `radiation oncologist expert` — neoadjuvant/definitive chemoradiotherapy, TNT, SBRT, palliative radiotherapy.
- `radiologist expert` — CT/MRI/PET staging, RECIST 1.1, vascular involvement, and hepatic lesion characterization.
- `gastroenterologist expert` — diagnostic/interventional endoscopy, EUS-FNA/FNB, biliary/enteral stenting, portal hypertension.
- `pathologist expert` — histological typing/grading, pTNM, margins, IHC/MMR/MSI, molecular tissue adequacy.
- **KV-Cache Prefix Rule**: Never mutate `cls.system_prompt`. Keep specialist system prompts static and resolve organ-scoped TNCD resources dynamically via `form_cls.resolve_agent_ressources(...)` (`MedSyntisAgent(..., ressources=...)`) so `llama.cpp` KV-cache sharing across waves remains intact (`test_token_cache_phase2.py`).

### 3. Handling Output Formats & Parsing Failures
Ensure Pydantic schemas are strictly respected. If LLMs fail to match the structure, utilize `ToolRetryMiddleware` and `ModelRetryMiddleware` configured with standard backoffs:
```python
middleware=[
    ToolRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=1.0),
    ModelRetryMiddleware(max_retries=3, backoff_factor=2.0, initial_delay=1.0)
]
```
Ensure structured tool strategies have proper error handlers:
```python
response_format=ToolStrategy(schema=self.output_format, handle_errors=True)
```
