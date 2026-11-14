import type { Language } from "./types.js";

/**
 * Bilingual clinical & UI dictionary (FR / EN)
 * Synchronized with application/src/ui/patient_mdt/translations.py + Web M3 UI strings.
 */
const CLINICAL_TERM_PAIRS: Record<string, readonly [fr: string, en: string]> = {
  // Model Class Titles
  ExpertAnswer: ["Avis par spécialité", "Specialty Opinions"],
  MTDCompleted: ["Contrôle de complétude pré-RCP", "Pre-MDT Completeness Check"],
  CareOrientationProposal: [
    "Proposition d'orientation pré-RCP",
    "Pre-MDT Care Orientation Proposal",
  ],
  GeneticDiagnosis: ["Diagnostic génétique", "Genetic Diagnosis"],
  MotorFunctionStatus: [
    "Statut moteur (MFM / RULM / CHOP-INTEND)",
    "Motor Function Status (MFM / RULM / CHOP-INTEND)",
  ],
  RespiratoryFunction: ["Fonction respiratoire", "Respiratory Function"],
  OrthopedicAndSpineStatus: ["Statut orthopédique et rachidien", "Orthopedic & Spine Status"],
  BulbarAndNutritionalStatus: ["Statut bulbaire et nutritionnel", "Bulbar & Nutritional Status"],
  PatientAdministrative: ["Identité & séance RCP", "Identity & MDT Session"],
  PatientPerformanceStatus: ["Statut de performance OMS", "WHO Performance Status"],
  TumorLocation: ["Localisation & stade tumoral", "Primary Tumor Location & Stage"],
  CancerDescription: [
    "Caractérisation tumorale, TNM & Réponse RECIST",
    "Tumor Characterization, TNM & RECIST Response",
  ],
  TumorBiology: ["Biologie & biomarqueurs", "Tumor Biology & Biomarkers"],
  HepaticStatus: ["Bilan hépatique, Child-Pugh & BCLC", "Hepatic Function, Child-Pugh & BCLC"],
  NutritionalStatus: [
    "Statut nutritionnel & évolution pondérale",
    "Nutritional Status & Weight Evolution",
  ],
  SurgicalStatus: ["Statut chirurgical & résécabilité", "Surgical Status & Resectability"],
  RadiologicExams: ["Examens radiologiques", "Radiological Examinations"],
  PreviousCurativeSurgery: ["Chirurgie curative antérieure", "Previous Curative Surgery"],
  PlannedCurativeSurgery: ["Chirurgie curative prévue", "Planned Curative Surgery"],
  ChemotherapyTreament: [
    "Traitements systémiques / Chimiothérapie",
    "Systemic Treatments / Chemotherapy",
  ],
  mtd_complete: ["Synthèse de complétude", "Completeness Summary"],
  // Field names
  first_name: ["Prénom", "First name"],
  last_name: ["Nom", "Last name"],
  born_name: ["Nom de naissance", "Birth name"],
  age: ["Âge", "Age"],
  date_birth: ["Date de naissance", "Date of birth"],
  date_rcp: ["Date de la RCP", "MDT session date"],
  gender: ["Genre", "Gender"],
  performance_status: ["Statut de performance (OMS)", "WHO Performance Status"],
  tumor_location: ["Localisation tumorale", "Tumor location"],
  type_of_cancer: ["Type histologique du cancer", "Histological cancer type"],
  histological_grade: ["Grade histologique", "Histological grade"],
  tnm_status: ["Classification TNM", "TNM staging"],
  figo_stage: ["Stade FIGO", "FIGO stage"],
  metastatic_status: ["Statut métastatique (M+)", "Metastatic status (M+)"],
  metastatic_sites: ["Sites métastatiques", "Metastatic sites"],
  target_lesion_size_mm: ["Taille de la lésion cible (mm)", "Target lesion size (mm)"],
  recist_response: ["Réponse radiologique (RECIST 1.1)", "Radiological response (RECIST 1.1)"],
  msi_state: ["Statut MSI / MSS", "MSI / MSS status"],
  ca19_9: ["CA 19-9 (U/mL)", "CA 19-9 (U/mL)"],
  ace: ["ACE / CEA (ng/mL)", "CEA / ACE (ng/mL)"],
  afp: ["Alpha-fœtoprotéine / AFP (ng/mL)", "Alpha-fetoprotein / AFP (ng/mL)"],
  dpd_uracilemia: ["Uracilémie pré-5FU / DPD (ng/mL)", "Pre-5FU Uracilemia / DPD (ng/mL)"],
  ras_braf_status: ["Statut moléculaire RAS / BRAF", "RAS / BRAF molecular status"],
  her2_status: ["Statut HER2 / PD-L1 (CPS)", "HER2 / PD-L1 (CPS) status"],
  bilirubin_umol_l: ["Bilirubine totale (µmol/L)", "Total bilirubin (µmol/L)"],
  child_pugh_score: ["Score de Child-Pugh", "Child-Pugh score"],
  bclc_stage: ["Stade BCLC", "BCLC stage"],
  weight_kg: ["Poids actuel (kg)", "Current weight (kg)"],
  weight_loss_percent: ["Perte de poids (%)", "Weight loss (%)"],
  bmi: ["IMC (kg/m²)", "BMI (kg/m²)"],
  resectability_status: ["Statut de résécabilité", "Resectability status"],
  surgery_done: ["Chirurgie d'exérèse réalisée", "Resection surgery performed"],
  resection_margin: [
    "Marge de résection chirurgicale (R0/R1/R2)",
    "Surgical resection margin (R0/R1/R2)",
  ],
  exams_list: ["Liste des examens", "Examinations list"],
  exam_name: ["Nom de l'examen", "Exam name"],
  exam_date: ["Date de l'examen", "Exam date"],
  exam_type: ["Type d'examen", "Exam modality"],
  exam_result: ["Résultat de l'examen", "Exam conclusion / result"],
  previous_curative_surgery: ["Chirurgie curative antérieure", "Previous curative surgery"],
  previous_curative_surgery_date: ["Date de la chirurgie", "Surgery date"],
  planned_curative_surgery: ["Chirurgie curative prévue", "Planned curative surgery"],
  chemotherapy: ["Chimiothérapie", "Chemotherapy"],
  chemotherapy_list: ["Liste des chimiothérapies", "Chemotherapy lines"],
  chemotherapy_name: ["Nom du protocole", "Regimen / drug name"],
  chemotherapy_start_date: ["Date de début", "Start date"],
  chemotherapy_end_date: ["Date de fin", "End date"],
  chemotherapy_tolerance: ["Tolérance", "Tolerance"],
  expert_relevant: ["Expertise pertinente", "Relevant specialty"],
  discussion_priority: ["Priorité de discussion", "Discussion priority"],
  why_relevant: ["Raison de la pertinence", "Clinical relevance"],
  sources_relevant: ["Sources & Références", "Sources & References"],
  suggestions: ["Suggestions", "Proposals"],
  suggestion: ["Proposition", "Proposal"],
  why: ["Justification clinique", "Clinical justification"],
  references: ["Références", "References"],
  name: ["Nom", "Name"],
  page: ["Page", "Page"],
  position: ["Section / Position", "Section / Position"],
  excerpt: ["Extrait", "Excerpt"],
  is_mtd_complete: ["Dossier complet ?", "Complete record?"],
  what_missing: ["Éléments manquants", "Missing items"],
  reflection: ["Réflexion / Synthèse du débat", "Synthesis & Rationale"],
  care_adaptation_suggested: [
    "Adaptation de prise en charge suggérée",
    "Suggested care adaptation",
  ],
  suggested_priority: ["Priorité suggérée", "Suggested priority"],
  priority_reason: ["Justification du niveau de priorité", "Priority rationale"],
  proposed_care_type: [
    "Modalité / Axe de prise en charge proposé",
    "Proposed care modality / orientation",
  ],
  orientation_rationale: ["Argumentaire clinique pré-RCP", "Pre-MDT clinical rationale"],
  clinical_rationale: ["Argumentaire clinique pré-RCP", "Pre-MDT clinical rationale"],
  // SMA fields
  smn1_deletion_confirmed: ["Délétion SMN1 confirmée", "Confirmed SMN1 deletion"],
  smn2_copy_count: ["Nombre de copies SMN2", "SMN2 copy count"],
  other_genetic_variants: ["Autres variantes génétiques", "Other genetic variants"],
  sma_type: ["Type de SMA", "SMA type"],
  motor_milestones: ["Acquisitions motrices", "Motor milestones"],
  mfm_scale_version: ["Version MFM (MFM-32 / MFM-20)", "MFM version (MFM-32 / MFM-20)"],
  mfm_total_score: ["Score MFM Total (%)", "MFM Total score (%)"],
  mfm_d1_score: ["MFM D1 — Debout & transferts (%)", "MFM D1 — Standing & transfers (%)"],
  mfm_d2_score: ["MFM D2 — Axial & proximal (%)", "MFM D2 — Axial & proximal (%)"],
  mfm_d3_score: ["MFM D3 — Distal (%)", "MFM D3 — Distal (%)"],
  rulm_score: ["Score RULM", "RULM score"],
  chop_intend_score: ["Score CHOP INTEND", "CHOP INTEND score"],
  hfmse_score: ["Score HFMSE (secondaire)", "HFMSE score (secondary)"],
  requires_ventilation_support: ["Assistance respiratoire requise", "Ventilation support required"],
  ventilation_type: ["Type de ventilation", "Ventilation type"],
  daily_ventilation_hours: ["Heures de ventilation/jour", "Ventilation hours/day"],
  uses_cough_assist: ["Utilise un assistant à la toux", "Uses cough assist"],
  forced_vital_capacity_percent: [
    "Capacité vitale forcée (CVF %)",
    "Forced vital capacity (FVC %)",
  ],
  has_scoliosis: ["Présence de scoliose", "Scoliosis present"],
  scoliosis_cobb_angle: ["Angle de Cobb", "Cobb angle"],
  spine_surgery_history: ["Antécédent de chirurgie du rachis", "Spinal surgery history"],
  joint_contractures: ["Rétractions articulaires", "Joint contractures"],
  wheelchair_user: ["Utilisateur de fauteuil roulant", "Wheelchair user"],
  has_dysphagia: ["Présence de dysphagie", "Dysphagia present"],
  feeding_mode: ["Mode d'alimentation", "Feeding mode"],
  history_aspiration_pneumonia: ["Antécédents de fausses routes", "Aspiration pneumonia history"],
  nutritional_status: ["Statut nutritionnel", "Nutritional status"],
  best_motor_function: ["Meilleure fonction motrice", "Best motor function"],
  physiotherapy_frequency: ["Fréquence de kinésithérapie", "Physiotherapy frequency"],
  non_invasive_ventilation: ["Ventilation non invasive (VNI)", "Non-invasive ventilation (NIV)"],
  cough_assist_used: ["Assistant à la toux (Cough-Assist)", "Cough assist used"],
  respiratory_infections_history: [
    "Historique des infections respiratoires",
    "Respiratory infections history",
  ],
  corset_type: ["Type de corset / orthèse", "Brace / corset type"],
  current_disease_modifying_therapy: [
    "Traitement de fond actuel",
    "Current disease-modifying therapy",
  ],
  previous_disease_modifying_therapies: [
    "Traitements de fond antérieurs",
    "Previous disease-modifying therapies",
  ],
  treatment_start_date: ["Date de début du traitement", "Treatment start date"],
  treatment_tolerance_and_response: [
    "Tolérance et réponse au traitement",
    "Treatment tolerance & response",
  ],
  Not_given: ["Non spécifié", "Not specified"],
};

function buildClinicalTranslations(index: 0 | 1): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CLINICAL_TERM_PAIRS).map(([key, pair]) => [key, pair[index]]),
  );
}

export const CLINICAL_TRANSLATIONS_FR: Record<string, string> = {
  ...buildClinicalTranslations(0),
  // Legacy Model Class Titles (FR)
  "Patient administrative informations": "Informations administratives du patient",
  "Patient WHO performance status": "Statut de performance OMS du patient",
  "Location of the tumor": "Localisation de la tumeur",
  "Biology of the tumor": "Biologie de la tumeur",
  "List of radiological exams": "Liste des examens radiologiques",
  "Previous curative surgery": "Chirurgie curative antérieure",
  "Planned curative surgery": "Chirurgie curative prévue",
  "Chemotherapy treatments": "Traitements par chimiothérapie",
  // Enums & Clinical values (FR)
  Male: "Homme",
  Female: "Femme",
  Other: "Autre",
  Not_given: "Non spécifié",
  not_given: "Non spécifié",
  male: "Homme",
  female: "Femme",
  other: "Autre",
  "1": "P1 · Délai thérapeutique contraint",
  "2": "P2 · Décision collégiale requise",
  "3": "P3 · Validation standard",
  "4": "P4 · Pour information",
  "9": "Non évaluée",
  P1: "P1 · Délai thérapeutique contraint",
  P2: "P2 · Décision collégiale requise",
  P3: "P3 · Validation standard",
  P4: "P4 · Pour information",
  NOT_ASSESSED: "Non évaluée",
  "no answer": "Non évaluée",
  Pancreas: "Pancréas",
  Colon: "Côlon",
  Liver: "Foie",
  Stomach: "Estomac",
  Oesophagus: "Œsophage",
  Rectum: "Rectum",
  "Intra-hepatic bile duct": "Voies biliaires intra-hépatiques",
  "Extra-hepatic bile duct": "Voies biliaires extra-hépatiques",
  unknown: "Inconnu",
  Surgery: "Chirurgie",
  Radiotherapy: "Radiothérapie",
  Immunotherapy: "Immunothérapie",
  Curative: "Curatif",
  Palliative: "Palliatif",
  Adjuvant: "Adjuvant",
  "Neo-adjuvant": "Néo-adjuvant",
  Good: "Bonne",
  Medium: "Moyenne",
  Poor: "Mauvaise",
  oncology: "Oncologie",
  sma: "Amyotrophie spinale",
  // Agents
  Administrative: "Extraction administrative & clinique",
  "MDT Coordinator": "Coordinateur RCP",
  "Ressource Assistant": "Assistant référentiels",
  "digestive surgeon expert": "Chirurgie digestive",
  "medical oncologist expert": "Oncologie médicale",
  "radiation oncologist expert": "Radiothérapie oncologique",
  "radiologist expert": "Imagerie & Radiologie",
  "gastroenterologist expert": "Hépato-gastro-entérologie",
  "pathologist expert": "Anatomopathologie",
  "neurologist expert": "Neurologie — Référent SMA",
  "geneticist expert": "Génétique moléculaire — SMN1/SMN2",
  "pulmonologist expert": "Pneumologie — Fonction respiratoire",
  "physiotherapy expert": "MPR — Rééducation fonctionnelle",
  "orthopedist expert": "Chirurgie orthopédique & Rachis",
  // LLM fallbacks
  "Not documented in record": "Non renseigné",
  "Not documented": "Non renseigné",
  "Not mentioned in record": "Non renseigné",
  "Not mentioned": "Non mentionné",
  None: "Aucun",
  Normal: "Normal",
  Oral: "Voie orale",
  "Oral with thickening": "Voie orale épaissie",
  "Gastrostomy tube": "Gastrostomie (GPE)",
  "Gastrostomy tube (G-tube / GPE)": "Gastrostomie (GPE)",
  "Nasogastric tube": "Sonde nasogastrique",
  "Non-invasive ventilation": "VNI (BiPAP)",
  "Non-invasive ventilation (NIV/BiPAP)": "VNI (BiPAP)",
  Tracheostomy: "Trachéotomie",
  Underweight: "Insuffisance pondérale",
  "Failure to thrive / Underweight": "Cassure staturo-pondérale / Maigreur",
  Overweight: "Surpoids",
  True: "Oui",
  False: "Non",
  true: "Oui",
  false: "Non",
  partial: "Partiel",
  Partiel: "Partiel",
  Partial: "Partiel",
  Resectable: "Résécable",
  Borderline: "Borderline (limite)",
  Unresectable: "Non résécable",
  "Locally advanced": "Localement avancé",
  Metastatic: "Métastatique",
  Sitter: "Station assise autonome (Sitter)",
  "Sitting unsupported": "Station assise sans appui",
  "Non-sitter": "Non assis",
  Walker: "Marche autonome",
  NIV_BiPAP: "VNI (BiPAP)",
  Gastrostomy: "Gastrostomie (GPE)",
  Nasogastric: "Sonde nasogastrique",
  Oral_Thickened: "Voie orale épaissie",
};

export const CLINICAL_TRANSLATIONS_EN: Record<string, string> = {
  ...buildClinicalTranslations(1),
  // Enums & Clinical values (EN)
  Homme: "Male",
  Femme: "Female",
  Autre: "Other",
  "1": "P1 · Time-bound",
  "2": "P2 · Decision needed",
  "3": "P3 · Standard sign-off",
  "4": "P4 · Information only",
  "9": "Not assessed",
  P1: "P1 · Time-bound",
  P2: "P2 · Decision needed",
  P3: "P3 · Standard sign-off",
  P4: "P4 · Information only",
  NOT_ASSESSED: "Not assessed",
  "no answer": "Not assessed",
  Pancréas: "Pancreas",
  Côlon: "Colon",
  Foie: "Liver",
  Estomac: "Stomach",
  Œsophage: "Oesophagus",
  unknown: "Unknown",
  Inconnu: "Unknown",
  Bonne: "Good",
  Moyenne: "Medium",
  Mauvaise: "Poor",
  Oui: "Yes",
  Non: "No",
  True: "Yes",
  False: "No",
  Partiel: "Partial",
  Partial: "Partial",
  Aucun: "None",
  "Non renseigné": "Not documented",
  "Non mentionné": "Not mentioned",
  NIV_BiPAP: "NIV (BiPAP)",
  Gastrostomy: "Gastrostomy (G-tube)",
  Nasogastric: "Nasogastric tube",
  Oral_Thickened: "Thickened oral intake",
  oncology: "Oncology",
  sma: "Spinal Muscular Atrophy",
  // Agents
  Administrative: "Administrative & Clinical Extraction",
  "MDT Coordinator": "MDT Coordinator",
  "Ressource Assistant": "Guidelines Assistant",
  "digestive surgeon expert": "Digestive Surgery",
  "medical oncologist expert": "Medical Oncology",
  "radiation oncologist expert": "Radiation Oncology",
  "radiologist expert": "Diagnostic Radiology",
  "gastroenterologist expert": "Gastroenterology & Endoscopy",
  "pathologist expert": "Anatomical Pathology",
  "neurologist expert": "Neurology — SMA Specialist",
  "geneticist expert": "Molecular Genetics — SMN1/SMN2",
  "pulmonologist expert": "Pulmonology — Respiratory Function",
  "physiotherapy expert": "Physical Medicine & Rehabilitation",
  "orthopedist expert": "Orthopedic & Spine Surgery",
};

const CLINICAL_TRANSLATIONS_EN_LOWER = new Map<string, string>(
  Object.entries(CLINICAL_TRANSLATIONS_EN).map(([k, v]) => [k.toLowerCase(), v]),
);

export const UI_CATALOG: Record<Language, Record<string, string>> = {
  fr: {
    "app.title": "MedSyntis — Préparation collégiale RCP",
    "nav.worklist": "Worklist RCP",
    "nav.agenda": "Ordre du jour RCP",
    "nav.ingest": "Importer des PDF",
    "nav.guidelines": "Référentiels scientifiques",
    "nav.agents": "Modules d'expertise",
    "nav.feedback": "Retours & Bugs",
    "nav.queue": "File d'analyse",
    "nav.styleguide": "Guide de style",
    "topbar.theme.auto": "Auto (Système)",
    "topbar.theme.light": "Clair",
    "topbar.theme.dark": "Sombre",
    "topbar.menu.aria": "Menu contextuel d'affichage et d'accès rapide",
    "topbar.menu.title": "Plus d'options",
    "topbar.contrast.heading": "Contraste des couleurs (M3)",
    "topbar.contrast.auto": "Auto (Système)",
    "topbar.contrast.standard": "Standard",
    "topbar.contrast.medium": "Contraste moyen",
    "topbar.contrast.high": "Contraste élevé",
    "topbar.expert": "Mode expert",
    "queue.banner.idle": "Aucune analyse en cours",
    "queue.banner.running": "analyses en cours",
    "queue.banner.open": "Voir la file",
    "kpi.structured": "Prêts pour la séance RCP",
    "kpi.priorityP1": "Délai contraint (P1)",
    "kpi.priorityNotAssessed": "Priorité à définir",
    "kpi.completeness": "Dossiers incomplets",
    "kpi.orientation": "Adaptations suggérées",
    "priority.P1": "P1 · Délai contraint",
    "priority.P1.short": "P1 · Délai court",
    "priority.P2": "P2 · Décision requise",
    "priority.P2.short": "P2 · Décision",
    "priority.P3": "P3 · Validation std.",
    "priority.P3.short": "P3 · Standard",
    "priority.P4": "P4 · Pour info",
    "priority.P4.short": "P4 · Info",
    "priority.NOT_ASSESSED": "Non évaluée",
    "priority.NOT_ASSESSED.short": "Non évaluée",
    "completeness.complete": "Dossier complet",
    "completeness.complete.short": "Complet",
    "completeness.incomplete": "pièces manquantes",
    "completeness.incomplete.short": "manquantes",
    "completeness.pending": "En attente IA",
    "orientation.adapt": "Adaptation suggérée",
    "orientation.standard": "Suivi habituel",
    "orientation.pending": "À discuter en RCP",
    "manual.badge": "Modifié manuellement",
    "disclaimer.ml":
      "Proposition d'aide à la préparation de la RCP générée localement. La décision thérapeutique appartient exclusivement au collège médical de la RCP.",
    "empty.value": "Non renseigné",
  },
  en: {
    "app.title": "MedSyntis — MDT Clinical Preparation",
    "nav.worklist": "MDT Worklist",
    "nav.agenda": "Next MDT Agenda",
    "nav.ingest": "Upload PDFs",
    "nav.guidelines": "Scientific Guidelines",
    "nav.agents": "Specialty Agents",
    "nav.feedback": "Feedback & Bugs",
    "nav.queue": "Analysis Queue",
    "nav.styleguide": "Styleguide",
    "topbar.theme.auto": "Auto (System)",
    "topbar.theme.light": "Light",
    "topbar.theme.dark": "Dark",
    "topbar.menu.aria": "Display and quick-access menu",
    "topbar.menu.title": "More options",
    "topbar.contrast.heading": "Color Contrast (M3)",
    "topbar.contrast.auto": "Auto (System)",
    "topbar.contrast.standard": "Standard",
    "topbar.contrast.medium": "Medium contrast",
    "topbar.contrast.high": "High contrast",
    "topbar.expert": "Expert mode",
    "queue.banner.idle": "No active analysis",
    "queue.banner.running": "analyses running",
    "queue.banner.open": "View queue",
    "kpi.structured": "Ready for MDT session",
    "kpi.priorityP1": "Time-bound (P1)",
    "kpi.priorityNotAssessed": "Needs priority",
    "kpi.completeness": "Incomplete records",
    "kpi.orientation": "Suggested adaptations",
    "priority.P1": "P1 · Time-bound",
    "priority.P1.short": "P1 · Time-bound",
    "priority.P2": "P2 · Decision needed",
    "priority.P2.short": "P2 · Decision",
    "priority.P3": "P3 · Standard sign-off",
    "priority.P3.short": "P3 · Standard",
    "priority.P4": "P4 · Information",
    "priority.P4.short": "P4 · Info",
    "priority.NOT_ASSESSED": "Not assessed",
    "priority.NOT_ASSESSED.short": "Not assessed",
    "completeness.complete": "Complete record",
    "completeness.complete.short": "Complete",
    "completeness.incomplete": "missing items",
    "completeness.incomplete.short": "missing",
    "completeness.pending": "Pending AI",
    "orientation.adapt": "Suggested adaptation",
    "orientation.standard": "Routine follow-up",
    "orientation.pending": "To discuss in MDT",
    "manual.badge": "Manually edited",
    "disclaimer.ml":
      "Pre-MDT decision-support proposal generated locally. Therapeutic decisions belong exclusively to the MDT medical board.",
    "empty.value": "Not documented",
  },
};

export function t(key: string, lang: Language = "fr"): string {
  return UI_CATALOG[lang]?.[key] ?? UI_CATALOG.fr[key] ?? key;
}

/**
 * Zero-allocation inline bilingual selector (`fr` vs `en`).
 */
export function tr(lang: Language, fr: string, en: string): string {
  return lang === "en" ? en : fr;
}

const ISO_DATE_TEST_RE = /\d{4}-\d{2}-\d{2}/;
const ISO_DATE_REPLACE_RE =
  /\b(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

export function formatCleanDateString(input: string, lang: Language = "fr"): string {
  if (input.length < 10 || !ISO_DATE_TEST_RE.test(input)) {
    return input;
  }
  return input.replace(
    ISO_DATE_REPLACE_RE,
    (_match, yyyy: string, mm: string, dd: string, hh?: string, min?: string) => {
      const datePart = lang === "fr" ? `${dd}/${mm}/${yyyy}` : `${yyyy}-${mm}-${dd}`;
      if (hh && min && !(hh === "00" && min === "00")) {
        return `${datePart} ${hh}:${min}`;
      }
      return datePart;
    },
  );
}

export function translateValue(value: unknown, lang: Language = "fr"): string {
  if (value === null || value === undefined || value === "") {
    return t("empty.value", lang);
  }
  if (typeof value === "boolean") {
    return lang === "en" ? (value ? "Yes" : "No") : value ? "Oui" : "Non";
  }
  const str = String(value).trim();
  if (!str) return t("empty.value", lang);
  if (lang === "fr") {
    const translated = CLINICAL_TRANSLATIONS_FR[str] ?? str;
    return formatCleanDateString(translated, "fr");
  }
  if (
    str === "Not documented in record" ||
    str === "Not documented" ||
    str === "Not mentioned in record"
  ) {
    return "Not documented";
  }
  const translatedEn =
    CLINICAL_TRANSLATIONS_EN[str] ?? CLINICAL_TRANSLATIONS_EN_LOWER.get(str.toLowerCase()) ?? str;
  return formatCleanDateString(translatedEn, "en");
}
