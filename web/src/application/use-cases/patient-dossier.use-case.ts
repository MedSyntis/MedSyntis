import {
  coerceSectionUpdatePayload,
  extractNormalizedChemoList,
  extractNormalizedExamsList,
  type FieldInputKind,
  type FieldSelectOption,
  formatFieldLabel,
  formatRawEditValue,
  getAgentPresentation,
  getSectionFieldSchemas,
  getSectionPresentation,
  type NormalizedChemoItem,
  type NormalizedExamItem,
  resolveCanonicalSectionName,
  type SectionPresentationMeta,
} from "../../domain/catalog.js";
import { t, translateValue } from "../../domain/i18n.js";
import { buildPatientDashboardFromForms } from "../../domain/patient-dashboard.js";
import {
  computeLongitudinalDeltas,
  deriveCompletenessInfo,
  deriveOrientationInfo,
  derivePriorityBadgeInfo,
  normalizePriorityLevel,
  priorityRank,
} from "../../domain/triage.js";
import type {
  AgentModuleInfo,
  CitationRef,
  ClinicalDomain,
  CompletenessStatus,
  DiscussionPriorityLevel,
  DomainFormSchema,
  ExpertSuggestion,
  Language,
  LongitudinalDelta,
  ManualEditMetadata,
  MdtFormDetail,
  PatientDashboardView,
  PatientListItem,
  PatientRecordSummaryView,
  RawCompletenessStatus,
  SpecialtyOpinionItem,
} from "../../domain/types.js";
import { stripMarkdown } from "../../ui/views/html.js";
import type {
  ChatReply,
  MedsyntisApiPort,
  MissingItemsUpdateInput,
} from "../ports/medsyntis-api.port.js";

export interface DossierSubCardView {
  title: string;
  badge?: string | null;
  subtitle?: string | null;
  body: string;
}

export interface DossierManualDiffView {
  key: string;
  label: string;
  aiValue: string;
  humanValue: string;
}

export interface DossierFieldView {
  key: string;
  label: string;
  value: string;
  rawValue: unknown;
  editValue: string;
  inputType: FieldInputKind;
  nullable: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  examItems?: NormalizedExamItem[];
  chemoItems?: NormalizedChemoItem[];
  isLongText: boolean;
  hiddenInReadView?: boolean;
  isModified?: boolean;
  originalAiValue?: string;
  badgeTone?: "green" | "orange" | "red" | null;
}

export interface DossierSectionView {
  name: string;
  meta: SectionPresentationMeta;
  summaryText: string;
  sectionTone?: "green" | "orange" | "red" | "neutral" | null;
  fields: DossierFieldView[];
  subCards: DossierSubCardView[];
  references: CitationRef[];
  rawData: Record<string, unknown>;
  isManual: boolean;
  manualMeta: ManualEditMetadata | null;
  manualDiffs: DossierManualDiffView[];
  reasoningThinking: string | null;
  userPrompt: string | null;
  durationSec: number | null;
}

export interface TimelineSessionItem {
  file: string;
  mdtDate: string;
  isCurrent: boolean;
  isLatest: boolean;
  priorityLevel: DiscussionPriorityLevel;
  priorityLabel: string;
  completenessStatus: CompletenessStatus;
  completenessLabel: string;
  orientationLabel: string;
  durationSec: number | null;
}

export interface PatientDossierView {
  patientId: string | null;
  patientName: string;
  firstName: string;
  lastName: string;
  dateBirth: string | null;
  gender: string | null;
  domain: ClinicalDomain;
  rcpCount: number;
  cumulativeDurationSec: number;
  currentForm: MdtFormDetail;
  timeline: TimelineSessionItem[];
  prevSessionFile: string | null;
  nextSessionFile: string | null;
  priorityBadge: ReturnType<typeof derivePriorityBadgeInfo>;
  completenessBadge: ReturnType<typeof deriveCompletenessInfo>;
  missingItemsState: {
    allItems: string[];
    visibleItems: string[];
    hiddenItems: string[];
    hideAll: boolean;
    isOptional?: boolean;
  };
  orientationBadge: ReturnType<typeof deriveOrientationInfo>;
  specialties: Array<{ name: string; label: string; icon: string }>;
  synopticMarkers: Array<{
    key: string;
    label: string;
    value: string;
    isMissing: boolean;
    targetSection: string;
    targetTab: "clinical" | "opinions";
    delta?: LongitudinalDelta;
  }>;
  deltas: LongitudinalDelta[];
  sections: DossierSectionView[];
  opinions: SpecialtyOpinionItem[];
  careProposal: {
    careAdaptationSuggested: boolean | null;
    proposedCareType: string | null;
    clinicalRationale: string | null;
    reasoningThinking: string | null;
    userPrompt: string | null;
    durationSec: number | null;
  };
  allPatients: PatientListItem[];
  agents: AgentModuleInfo[];
  dashboard: PatientDashboardView;
}

const LONG_TEXT_KEYS = new Set([
  "reflection",
  "clinical_rationale",
  "orientation_rationale",
  "priority_reason",
  "why",
  "why_relevant",
  "exam_result",
  "other_genetic_variants",
  "motor_milestones",
]);

export class PatientDossierUseCase {
  constructor(private readonly api: MedsyntisApiPort) {}

  async getDossier(
    target: string,
    domain: ClinicalDomain,
    lang: Language = "fr",
    selectedFile?: string,
  ): Promise<PatientDossierView | null> {
    let forms: MdtFormDetail[] = [];
    if (target.toLowerCase().endsWith(".pdf")) {
      const single = await this.api.getFormDetail(target, domain);
      if (single) {
        if (single.patientId && !single.patientId.toLowerCase().endsWith(".pdf")) {
          const linked = await this.api.getPatientForms(single.patientId, domain);
          forms = linked.length > 0 ? linked : [single];
        } else {
          forms = [single];
        }
      }
    }
    if (forms.length === 0) {
      forms = await this.api.getPatientForms(target, domain);
    }
    if (forms.length === 0 && selectedFile && selectedFile !== target) {
      const bySelected = await this.api.getFormDetail(selectedFile, domain);
      if (bySelected) {
        forms = [bySelected];
      }
    }
    if (forms.length === 0) {
      const single = await this.api.getFormDetail(target, domain);
      if (!single) return null;
      if (single.patientId) {
        const linked = await this.api.getPatientForms(single.patientId, domain);
        forms = linked.length > 0 ? linked : [single];
      } else {
        forms = [single];
      }
    }

    const sorted = [...forms].sort((a, b) => (a.mdtDate ?? "").localeCompare(b.mdtDate ?? ""));
    const currentIndex = selectedFile
      ? Math.max(
          0,
          sorted.findIndex((f) => f.file === selectedFile),
        )
      : sorted.length - 1;
    const currentForm = sorted[currentIndex] ?? sorted[sorted.length - 1]!;
    const previousForm = currentIndex > 0 ? sorted[currentIndex - 1] : null;

    const admin = (currentForm.sections.PatientAdministrative ?? {}) as Record<string, unknown>;
    const firstName =
      admin.first_name && admin.first_name !== "Not_given" ? String(admin.first_name) : "";
    const lastName =
      admin.last_name && admin.last_name !== "Not_given"
        ? String(admin.last_name)
        : currentForm.file;
    const patientName = `${lastName} ${firstName}`.trim();

    const priorityLevel = normalizePriorityLevel(
      currentForm.metrics.discussion_priority ?? currentForm.metrics.discussion_priority_code,
    );
    const priorityBadge = derivePriorityBadgeInfo(priorityLevel, lang, false, {
      priority_reason: currentForm.metrics.priority_reason
        ? String(currentForm.metrics.priority_reason)
        : null,
      priority_reasons: Array.isArray(currentForm.metrics.priority_reasons)
        ? currentForm.metrics.priority_reasons.map(String)
        : [],
    });

    const mtdCompletedRaw = (currentForm.sections.MTDCompleted ?? {}) as Record<string, unknown>;
    const mtdNested =
      mtdCompletedRaw.mtd_complete && typeof mtdCompletedRaw.mtd_complete === "object"
        ? (mtdCompletedRaw.mtd_complete as Record<string, unknown>)
        : mtdCompletedRaw;
    const rawExtractedMissing = Array.isArray(currentForm.metrics.all_missing_items)
      ? (currentForm.metrics.all_missing_items as string[])
      : Array.isArray(mtdNested.what_missing)
        ? (mtdNested.what_missing as string[])
        : Array.isArray(mtdCompletedRaw.what_missing)
          ? (mtdCompletedRaw.what_missing as string[])
          : Array.isArray(currentForm.metrics.missing_items)
            ? (currentForm.metrics.missing_items as string[])
            : [];
    const allMissingItems = rawExtractedMissing.filter((x) => Boolean(x) && x !== "no data");
    const hiddenMissingItems = Array.isArray(currentForm.metrics.hidden_missing_items)
      ? (currentForm.metrics.hidden_missing_items as string[])
      : [];
    const hideAllMissing = Boolean(currentForm.metrics.hide_missing_items ?? false);
    const hiddenSet = new Set(hiddenMissingItems);
    const missingItems = hideAllMissing
      ? []
      : Array.isArray(currentForm.metrics.missing_items)
        ? (currentForm.metrics.missing_items as string[]).filter(
            (x) => Boolean(x) && x !== "no data" && !hiddenSet.has(x),
          )
        : allMissingItems.filter((x) => !hiddenSet.has(x));
    const hasMtdCompleted = Object.keys(mtdCompletedRaw).length > 0;
    const isMtdManual = Boolean(
      currentForm.manualEdits.MTDCompleted &&
        currentForm.manualEdits.MTDCompleted.is_manual !== false,
    );
    const isAiCompleted =
      String(currentForm.processingStatus ?? "COMPLETED")
        .trim()
        .toUpperCase() === "COMPLETED";
    const isMtdEvaluated = (isAiCompleted || isMtdManual) && hasMtdCompleted;
    const rawMtdCompFlag = mtdNested.is_mtd_complete ?? mtdCompletedRaw.is_mtd_complete;
    const rawMtdCompNorm = String(rawMtdCompFlag ?? "")
      .trim()
      .toLowerCase();
    const completenessStatus: RawCompletenessStatus = !isMtdEvaluated
      ? "pending"
      : currentForm.metrics.completeness_status === "yes" ||
          currentForm.metrics.completeness_status === "partial" ||
          currentForm.metrics.completeness_status === "no"
        ? currentForm.metrics.completeness_status
        : rawMtdCompFlag === true ||
            rawMtdCompNorm === "true" ||
            rawMtdCompNorm === "yes" ||
            rawMtdCompNorm === "oui"
          ? "yes"
          : rawMtdCompNorm === "partial" || rawMtdCompNorm === "partiel"
            ? "partial"
            : rawMtdCompFlag === false ||
                rawMtdCompNorm === "false" ||
                rawMtdCompNorm === "no" ||
                rawMtdCompNorm === "non"
              ? "no"
              : allMissingItems.length === 0
                ? "yes"
                : "no";
    const isFormComplete = completenessStatus === "yes";
    const completenessBadge = deriveCompletenessInfo(
      {
        is_complete: isFormComplete,
        completeness_status: completenessStatus,
        is_manually_edited: isMtdManual,
        missing_count: missingItems.length,
        missing_items: missingItems,
        processing_status: currentForm.processingStatus,
      },
      lang,
    );
    const missingItemsState = {
      allItems: allMissingItems,
      visibleItems: missingItems,
      hiddenItems: hiddenMissingItems,
      hideAll: hideAllMissing,
      isOptional: isFormComplete,
    };

    const careSec = (currentForm.sections.CareOrientationProposal ?? {}) as Record<string, unknown>;
    const careAdaptationSuggested =
      typeof currentForm.metrics.care_adaptation_suggested === "boolean"
        ? currentForm.metrics.care_adaptation_suggested
        : typeof careSec.care_adaptation_suggested === "boolean"
          ? careSec.care_adaptation_suggested
          : null;
    const proposedCareType =
      String(currentForm.metrics.proposed_care_type ?? careSec.proposed_care_type ?? "").trim() ||
      null;

    const orientationBadge = deriveOrientationInfo(
      {
        care_adaptation_suggested: careAdaptationSuggested,
        proposed_care_type: proposedCareType,
      },
      lang,
    );

    const rawSpecs = Array.isArray(currentForm.metrics.specialties)
      ? (currentForm.metrics.specialties as string[])
      : [];
    const specialties = rawSpecs.map((s) => getAgentPresentation(s, lang));

    const resolvedPatientId =
      currentForm.patientId ?? (!target.toLowerCase().endsWith(".pdf") ? target : currentForm.file);

    const [allPatients, agents, domainSchema, apiDashboard] = await Promise.all([
      this.api.listPatients(domain, false),
      this.api.listAgents(domain, lang),
      this.api.getDomainSchema(domain).catch(() => null),
      typeof this.api.getPatientDashboard === "function"
        ? this.api.getPatientDashboard(resolvedPatientId, domain).catch(() => null)
        : Promise.resolve(null),
    ]);

    const dashboard: PatientDashboardView =
      apiDashboard ??
      buildPatientDashboardFromForms(resolvedPatientId, patientName, domain, sorted, null);

    const deltas = computeLongitudinalDeltas(currentForm, previousForm, lang);
    const synopticMarkers = this.buildSynopticMarkers(currentForm, deltas, lang);
    const sections = this.buildSections(currentForm, lang, domainSchema);
    const opinions = this.buildOpinions(currentForm, lang);

    const timeline: TimelineSessionItem[] = sorted.map((f, idx) => {
      const fPrio = normalizePriorityLevel(
        f.metrics.discussion_priority ?? f.metrics.discussion_priority_code,
      );
      const fPrioInfo = derivePriorityBadgeInfo(fPrio, lang, true);
      const fMtdRaw = (f.sections.MTDCompleted ?? {}) as Record<string, unknown>;
      const fHasMtd = Object.keys(fMtdRaw).length > 0;
      const fMtdManual = Boolean(
        f.manualEdits.MTDCompleted && f.manualEdits.MTDCompleted.is_manual !== false,
      );
      const fCompl = deriveCompletenessInfo(
        {
          is_complete: f.metrics.is_complete,
          completeness_status: !fHasMtd ? "pending" : f.metrics.completeness_status,
          is_manually_edited: fMtdManual,
          missing_count: f.metrics.missing_count,
          missing_items: f.metrics.missing_items,
          processing_status: f.processingStatus,
        },
        lang,
      );
      const fOrient = deriveOrientationInfo(
        {
          care_adaptation_suggested:
            typeof f.metrics.care_adaptation_suggested === "boolean"
              ? f.metrics.care_adaptation_suggested
              : null,
          proposed_care_type: f.metrics.proposed_care_type
            ? String(f.metrics.proposed_care_type)
            : null,
        },
        lang,
      );
      const fExecSum = Object.values(f.executionTimes ?? {}).reduce(
        (acc, v) => acc + (typeof v === "number" && Number.isFinite(v) ? v : 0),
        0,
      );
      return {
        file: f.file,
        mdtDate: f.mdtDate ? translateValue(f.mdtDate, lang) : f.file,
        isCurrent: f.file === currentForm.file,
        isLatest: idx === sorted.length - 1,
        priorityLevel: fPrio,
        priorityLabel: fPrioInfo.label,
        completenessStatus: fCompl.status,
        completenessLabel: fCompl.label,
        orientationLabel: fOrient.label,
        durationSec: fExecSum > 0 ? Math.round(fExecSum * 10) / 10 : null,
      };
    });

    const cumulativeDurationSec = Object.values(currentForm.executionTimes).reduce(
      (acc, v) => acc + (typeof v === "number" ? v : 0),
      0,
    );

    const careMeta = getSectionPresentation("CareOrientationProposal", currentForm.domain, lang);
    const careReasoning =
      typeof careSec.reasoning_thinking === "string" && careSec.reasoning_thinking.trim()
        ? careSec.reasoning_thinking.trim()
        : null;
    const careDuration =
      currentForm.executionTimes.CareOrientationProposal ??
      (typeof careSec.time_execution === "number"
        ? Math.round(careSec.time_execution * 10) / 10
        : null);

    return {
      patientId: currentForm.patientId ?? (!target.toLowerCase().endsWith(".pdf") ? target : null),
      patientName,
      firstName,
      lastName,
      dateBirth:
        admin.date_birth && admin.date_birth !== "Not_given"
          ? translateValue(admin.date_birth, lang)
          : null,
      gender:
        admin.gender && admin.gender !== "Not_given" ? translateValue(admin.gender, lang) : null,
      domain: currentForm.domain,
      rcpCount: sorted.length,
      cumulativeDurationSec: Math.round(cumulativeDurationSec * 10) / 10,
      currentForm,
      timeline,
      prevSessionFile: currentIndex > 0 ? sorted[currentIndex - 1]!.file : null,
      nextSessionFile: currentIndex < sorted.length - 1 ? sorted[currentIndex + 1]!.file : null,
      priorityBadge,
      completenessBadge,
      missingItemsState,
      orientationBadge,
      specialties,
      synopticMarkers,
      deltas,
      sections,
      opinions,
      careProposal: {
        careAdaptationSuggested,
        proposedCareType,
        clinicalRationale:
          (careSec.orientation_rationale ?? careSec.clinical_rationale)
            ? String(careSec.orientation_rationale ?? careSec.clinical_rationale)
            : null,
        reasoningThinking: careReasoning,
        userPrompt: careMeta.userPrompt ?? null,
        durationSec: careDuration,
      },
      allPatients,
      agents,
      dashboard,
    };
  }

  private buildSynopticMarkers(
    form: MdtFormDetail,
    deltas: LongitudinalDelta[],
    lang: Language,
  ): PatientDossierView["synopticMarkers"] {
    const deltaMap = new Map(deltas.map((d) => [d.key, d]));
    if (form.domain === "sma") {
      const gen = (form.sections.GeneticDiagnosis ?? {}) as Record<string, unknown>;
      const mot = (form.sections.MotorFunctionStatus ?? {}) as Record<string, unknown>;
      const resp = (form.sections.RespiratoryFunction ?? {}) as Record<string, unknown>;
      const ortho = (form.sections.OrthopedicAndSpineStatus ?? {}) as Record<string, unknown>;
      return [
        {
          key: "sma_type",
          label: lang === "fr" ? "Type SMA" : "SMA Type",
          value: translateValue(mot.sma_type, lang),
          isMissing: !mot.sma_type,
          targetSection: "MotorFunctionStatus",
          targetTab: "clinical",
        },
        {
          key: "smn2_copy_count",
          label: lang === "fr" ? "Copies SMN2" : "SMN2 Copies",
          value: translateValue(gen.smn2_copy_count, lang),
          isMissing: gen.smn2_copy_count == null,
          targetSection: "GeneticDiagnosis",
          targetTab: "clinical",
        },
        mot.mfm_total_score != null || mot.hfmse_score == null
          ? {
              key: "mfm_total_score",
              label: mot.mfm_scale_version ? String(mot.mfm_scale_version) : "MFM",
              value:
                mot.mfm_total_score != null
                  ? String(mot.mfm_total_score).endsWith("%")
                    ? String(mot.mfm_total_score)
                    : `${mot.mfm_total_score} %`
                  : translateValue(null, lang),
              isMissing: mot.mfm_total_score == null,
              targetSection: "MotorFunctionStatus",
              targetTab: "clinical",
              delta: deltaMap.get("mfm_total_score"),
            }
          : {
              key: "hfmse_score",
              label: "HFMSE",
              value: `${mot.hfmse_score}/66`,
              isMissing: false,
              targetSection: "MotorFunctionStatus",
              targetTab: "clinical",
              delta: deltaMap.get("hfmse_score"),
            },
        {
          key: "rulm_score",
          label: "RULM",
          value: mot.rulm_score != null ? `${mot.rulm_score}/37` : translateValue(null, lang),
          isMissing: mot.rulm_score == null,
          targetSection: "MotorFunctionStatus",
          targetTab: "clinical",
          delta: deltaMap.get("rulm_score"),
        },
        {
          key: "forced_vital_capacity_percent",
          label: lang === "fr" ? "CVF" : "FVC",
          value:
            resp.forced_vital_capacity_percent != null
              ? `${resp.forced_vital_capacity_percent} %`
              : translateValue(null, lang),
          isMissing: resp.forced_vital_capacity_percent == null,
          targetSection: "RespiratoryFunction",
          targetTab: "clinical",
          delta: deltaMap.get("forced_vital_capacity_percent"),
        },
        {
          key: "scoliosis_cobb_angle",
          label: lang === "fr" ? "Rachis / Cobb" : "Spine / Cobb",
          value:
            ortho.scoliosis_cobb_angle != null
              ? `${ortho.scoliosis_cobb_angle}°`
              : translateValue(ortho.has_scoliosis ?? null, lang),
          isMissing: ortho.scoliosis_cobb_angle == null && ortho.has_scoliosis == null,
          targetSection: "OrthopedicAndSpineStatus",
          targetTab: "clinical",
          delta: deltaMap.get("scoliosis_cobb_angle"),
        },
      ];
    }

    const loc = (form.sections.TumorLocation ?? {}) as Record<string, unknown>;
    const bio = (form.sections.TumorBiology ?? {}) as Record<string, unknown>;
    const perf = (form.sections.PatientPerformanceStatus ?? {}) as Record<string, unknown>;
    const chemo = (form.sections.ChemotherapyTreament ?? {}) as Record<string, unknown>;
    const chemoList = Array.isArray(chemo.chemotherapy_list)
      ? (chemo.chemotherapy_list as Array<Record<string, unknown>>)
      : [];
    const firstChemoName =
      chemo.chemotherapy_name ?? chemoList[0]?.chemotherapy_name ?? chemo.chemotherapy;

    return [
      {
        key: "tumor_location",
        label: lang === "fr" ? "Organe / Tumeur" : "Organ / Tumor",
        value: translateValue(loc.tumor_location, lang),
        isMissing: !loc.tumor_location,
        targetSection: "TumorLocation",
        targetTab: "clinical",
      },
      {
        key: "ca19_9",
        label: lang === "fr" ? "Biologie / MSI" : "Biology / MSI",
        value: translateValue(bio.ca19_9 ?? bio.msi_state, lang),
        isMissing: !bio.ca19_9 && !bio.msi_state,
        targetSection: "TumorBiology",
        targetTab: "clinical",
      },
      {
        key: "performance_status",
        label: lang === "fr" ? "OMS / ECOG" : "WHO / ECOG",
        value: translateValue(perf.performance_status, lang),
        isMissing: perf.performance_status === undefined,
        targetSection: "PatientPerformanceStatus",
        targetTab: "clinical",
        delta: deltaMap.get("performance_status"),
      },
      {
        key: "chemotherapy_name",
        label: lang === "fr" ? "Traitement systémique" : "Systemic Treatment",
        value: translateValue(firstChemoName, lang),
        isMissing: !firstChemoName && chemo.chemotherapy === undefined,
        targetSection: "ChemotherapyTreament",
        targetTab: "clinical",
      },
    ];
  }

  private extractSectionHeaderSummary(
    sectionName: string,
    rawObj: Record<string, unknown>,
    subCards: DossierSubCardView[],
    fields: DossierFieldView[],
    lang: Language,
    form?: MdtFormDetail,
  ): string {
    if (sectionName === "TumorLocation") {
      return stripMarkdown(translateValue(rawObj.tumor_location, lang));
    }
    if (sectionName === "CancerDescription") {
      const parts = [
        rawObj.type_of_cancer,
        rawObj.tnm_status,
        rawObj.recist_response,
        rawObj.target_lesion_size_mm !== undefined && rawObj.target_lesion_size_mm !== null
          ? `${rawObj.target_lesion_size_mm} mm`
          : null,
      ]
        .filter((v) => v !== undefined && v !== null && v !== "")
        .map((v) => stripMarkdown(translateValue(v, lang)));
      return parts.slice(0, 3).join(" · ") || translateValue(null, lang);
    }
    if (sectionName === "TumorBiology") {
      const parts = [
        rawObj.msi_state !== undefined && rawObj.msi_state !== null
          ? stripMarkdown(translateValue(rawObj.msi_state, lang))
          : null,
        rawObj.ca19_9 !== undefined && rawObj.ca19_9 !== null
          ? `CA 19-9: ${rawObj.ca19_9} U/mL`
          : null,
        rawObj.ace !== undefined && rawObj.ace !== null ? `ACE: ${rawObj.ace} ng/mL` : null,
        rawObj.dpd_uracilemia !== undefined && rawObj.dpd_uracilemia !== null
          ? `${lang === "fr" ? "Uracilémie" : "Uracilemia"}: ${rawObj.dpd_uracilemia} ng/mL`
          : null,
      ].filter((v): v is string => Boolean(v));
      return parts.slice(0, 3).join(" · ") || translateValue(null, lang);
    }
    if (sectionName === "HepaticStatus") {
      const parts = [
        rawObj.child_pugh_score
          ? `Child-Pugh ${stripMarkdown(String(rawObj.child_pugh_score))}`
          : null,
        rawObj.bclc_stage ? `BCLC ${stripMarkdown(String(rawObj.bclc_stage))}` : null,
        rawObj.bilirubin_umol_l !== undefined && rawObj.bilirubin_umol_l !== null
          ? `${rawObj.bilirubin_umol_l} µmol/L`
          : null,
      ].filter((v): v is string => Boolean(v));
      return parts.join(" · ") || translateValue(null, lang);
    }
    if (sectionName === "NutritionalStatus") {
      const parts = [
        rawObj.weight_kg !== undefined && rawObj.weight_kg !== null
          ? `${rawObj.weight_kg} kg`
          : null,
        rawObj.weight_loss_percent !== undefined && rawObj.weight_loss_percent !== null
          ? `-${rawObj.weight_loss_percent} %`
          : null,
        rawObj.bmi !== undefined && rawObj.bmi !== null
          ? `${lang === "fr" ? "IMC" : "BMI"} ${rawObj.bmi}`
          : null,
      ].filter((v): v is string => Boolean(v));
      return parts.join(" · ") || translateValue(null, lang);
    }
    if (sectionName === "SurgicalStatus") {
      const parts = [
        rawObj.resectability_status
          ? stripMarkdown(translateValue(rawObj.resectability_status, lang))
          : null,
        rawObj.resection_margin ? stripMarkdown(String(rawObj.resection_margin)) : null,
      ].filter((v): v is string => Boolean(v));
      return parts.join(" · ") || translateValue(null, lang);
    }
    if (sectionName === "PatientPerformanceStatus") {
      const ps = rawObj.performance_status;
      if (ps === undefined || ps === null || ps === "") return translateValue(null, lang);
      return `${lang === "fr" ? "OMS" : "WHO"} ${stripMarkdown(translateValue(ps, lang))}`;
    }
    if (sectionName === "RadiologicExams") {
      if (subCards.length === 0) return lang === "fr" ? "Aucun examen" : "No exam";
      return lang === "fr"
        ? `${subCards.length} examen${subCards.length > 1 ? "s" : ""}`
        : `${subCards.length} exam(s)`;
    }
    if (sectionName === "PreviousCurativeSurgery") {
      const has = rawObj.previous_curative_surgery;
      if (has === true) {
        const dt = rawObj.previous_curative_surgery_date;
        return dt && dt !== "Not_given"
          ? `${translateValue(true, lang)} (${stripMarkdown(translateValue(dt, lang))})`
          : translateValue(true, lang);
      }
      return stripMarkdown(translateValue(has ?? false, lang));
    }
    if (sectionName === "PlannedCurativeSurgery") {
      return stripMarkdown(translateValue(rawObj.planned_curative_surgery ?? false, lang));
    }
    if (sectionName === "ChemotherapyTreament") {
      if (rawObj.chemotherapy === false) return translateValue(false, lang);
      if (rawObj.chemotherapy_name) return stripMarkdown(String(rawObj.chemotherapy_name));
      if (subCards.length > 0) {
        return `${stripMarkdown(subCards[0]!.title)}${subCards.length > 1 ? ` (+${subCards.length - 1})` : ""}`;
      }
      return stripMarkdown(translateValue(rawObj.chemotherapy, lang));
    }
    if (sectionName === "MTDCompleted") {
      if (form?.metrics.completeness_status === "pending" || Object.keys(rawObj).length === 0) {
        return t("completeness.pending", lang);
      }
      const rawList = Array.isArray(rawObj.what_missing)
        ? rawObj.what_missing.filter((x) => Boolean(x) && x !== "no data").map(String)
        : [];
      const hideAll = Boolean(form?.metrics.hide_missing_items);
      const hiddenSet = new Set(
        Array.isArray(form?.metrics.hidden_missing_items)
          ? form.metrics.hidden_missing_items.map(String)
          : [],
      );
      const visibleMissing = hideAll ? 0 : rawList.filter((x) => !hiddenSet.has(x)).length;
      const rawComp = rawObj.is_mtd_complete;
      const normComp = String(rawComp ?? "")
        .trim()
        .toLowerCase();
      const status: "yes" | "partial" | "no" =
        form?.metrics.completeness_status === "yes" ||
        form?.metrics.completeness_status === "partial" ||
        form?.metrics.completeness_status === "no"
          ? form.metrics.completeness_status
          : rawComp === true || normComp === "true" || normComp === "yes" || normComp === "oui"
            ? "yes"
            : normComp === "partial" || normComp === "partiel"
              ? "partial"
              : rawComp === false || normComp === "false" || normComp === "no" || normComp === "non"
                ? "no"
                : rawList.length === 0
                  ? "yes"
                  : "no";
      if (status === "yes") {
        if (visibleMissing > 0) {
          return lang === "fr"
            ? `${visibleMissing} élément(s) facultatif(s) manquant(s)`
            : `${visibleMissing} optional missing item(s)`;
        }
        return lang === "fr" ? "Dossier complet" : "Complete";
      }
      if (status === "partial") {
        if (visibleMissing > 0) {
          return lang === "fr"
            ? `Partiel · ${visibleMissing} élément(s) manquant(s)`
            : `Partial · ${visibleMissing} missing item(s)`;
        }
        return lang === "fr" ? "Dossier partiel" : "Partial";
      }
      if (visibleMissing > 0) {
        return lang === "fr"
          ? `Incomplet · ${visibleMissing} élément(s) manquant(s)`
          : `Incomplete · ${visibleMissing} missing item(s)`;
      }
      return lang === "fr" ? "Dossier incomplet" : "Incomplete";
    }
    if (sectionName === "CareOrientationProposal") {
      const proposed = String(rawObj.proposed_care_type ?? "").trim();
      if (proposed) return stripMarkdown(proposed);
      if (rawObj.care_adaptation_suggested === true) return t("orientation.adapt", lang);
      if (rawObj.care_adaptation_suggested === false) return t("orientation.standard", lang);
      return t("orientation.pending", lang);
    }

    if (sectionName === "PatientAdministrative") {
      const fn =
        rawObj.first_name && rawObj.first_name !== "Not_given"
          ? stripMarkdown(String(rawObj.first_name))
          : "";
      const ln =
        rawObj.last_name && rawObj.last_name !== "Not_given"
          ? stripMarkdown(String(rawObj.last_name))
          : "";
      const rcpDate =
        rawObj.date_rcp && rawObj.date_rcp !== "Not_given"
          ? stripMarkdown(translateValue(rawObj.date_rcp, lang))
          : "";
      return (
        [`${ln} ${fn}`.trim(), rcpDate].filter(Boolean).join(" · ") || translateValue(null, lang)
      );
    }

    return (
      fields
        .filter((f) => !f.isLongText && !f.hiddenInReadView)
        .map((f) => stripMarkdown(f.value))
        .filter((val) => val && val !== "Non renseigné" && val !== "Not documented")
        .slice(0, 2)
        .join(" · ") || translateValue(null, lang)
    );
  }

  private buildSections(
    form: MdtFormDetail,
    lang: Language,
    domainSchema?: DomainFormSchema | null,
  ): DossierSectionView[] {
    const skip = new Set(["ExpertAnswer"]);
    const internalKeys = new Set([
      "reasoning_thinking",
      "time_execution",
      "value",
      "manual_edits",
      "mtd_complete",
      "references",
    ]);
    const result: DossierSectionView[] = [];
    const sectionEntries: Array<[string, Record<string, unknown>]> = Object.entries(form.sections);
    if (!Object.hasOwn(form.sections, "CareOrientationProposal")) {
      sectionEntries.push(["CareOrientationProposal", {}]);
    }

    for (const [sectionName, rawSectionObj] of sectionEntries) {
      if (skip.has(sectionName)) continue;
      const meta = getSectionPresentation(sectionName, form.domain, lang);
      const rawObj: Record<string, unknown> = { ...(rawSectionObj ?? {}) };

      if (sectionName === "CareOrientationProposal") {
        if (rawObj.orientation_rationale === undefined && rawObj.clinical_rationale !== undefined) {
          rawObj.orientation_rationale = rawObj.clinical_rationale;
        }
        if (rawObj.suggested_priority !== undefined) {
          rawObj.suggested_priority = normalizePriorityLevel(rawObj.suggested_priority);
        }
      }

      // Unpack nested mtd_complete object if present (avoiding raw JSON stringification)
      if (
        sectionName === "MTDCompleted" &&
        rawObj.mtd_complete &&
        typeof rawObj.mtd_complete === "object" &&
        !Array.isArray(rawObj.mtd_complete)
      ) {
        const nested = rawObj.mtd_complete as Record<string, unknown>;
        if (rawObj.is_mtd_complete === undefined && nested.is_mtd_complete !== undefined) {
          rawObj.is_mtd_complete = nested.is_mtd_complete;
        }
        if (rawObj.what_missing === undefined && nested.what_missing !== undefined) {
          rawObj.what_missing = nested.what_missing;
        }
        if (rawObj.reflection === undefined && nested.reflection !== undefined) {
          rawObj.reflection = nested.reflection;
        }
        if (rawObj.references === undefined && nested.references !== undefined) {
          rawObj.references = nested.references;
        }
      }

      const fields: DossierFieldView[] = [];
      const subCards: DossierSubCardView[] = [];
      const references: CitationRef[] = Array.isArray(rawObj.references)
        ? (rawObj.references as Array<Record<string, unknown>>).map((r) => ({
            name: String(r.name ?? ""),
            page: (r.page as string | number | null) ?? null,
            position: r.position ? String(r.position) : null,
            excerpt: r.excerpt ? String(r.excerpt) : null,
          }))
        : [];

      const schemaFields = getSectionFieldSchemas(sectionName, domainSchema);
      const schemaByKey = new Map(schemaFields.map((s) => [s.key, s]));
      const orderedKeys = Array.from(
        new Set([...schemaFields.map((s) => s.key), ...Object.keys(rawObj)]),
      );

      for (const k of orderedKeys) {
        if (internalKeys.has(k)) continue;
        // Skip duplicate radiological_exams alias if exams_list is already present
        if (k === "radiological_exams" && orderedKeys.includes("exams_list")) continue;
        // Skip duplicate clinical_rationale alias on CareOrientationProposal when orientation_rationale is present
        if (
          sectionName === "CareOrientationProposal" &&
          k === "clinical_rationale" &&
          orderedKeys.includes("orientation_rationale")
        ) {
          continue;
        }

        const wasPresentInRaw = Object.hasOwn(rawObj, k);
        const v =
          k === "exams_list" &&
          rawObj.exams_list === undefined &&
          Array.isArray(rawObj.radiological_exams)
            ? rawObj.radiological_exams
            : rawObj[k];
        const fieldSchema = schemaByKey.get(k);
        const mapOptions = (opts?: FieldSelectOption[]) =>
          opts?.map((o) => ({
            value: o.value,
            label: lang === "fr" ? o.labelFr : o.labelEn,
          }));

        if (
          k === "exams_list" ||
          k === "radiological_exams" ||
          fieldSchema?.inputType === "exams_list"
        ) {
          const examArr = Array.isArray(v) ? v : [];
          for (const item of examArr) {
            if (item && typeof item === "object") {
              const ex = item as Record<string, unknown>;
              subCards.push({
                title: String(ex.exam_name ?? formatFieldLabel("exam_name", lang)),
                badge: ex.exam_type ? translateValue(ex.exam_type, lang) : null,
                subtitle:
                  ex.exam_date && ex.exam_date !== "Not_given"
                    ? translateValue(ex.exam_date, lang)
                    : null,
                body: ex.exam_result
                  ? translateValue(ex.exam_result, lang)
                  : translateValue(null, lang),
              });
            }
          }
          const summaryVal =
            subCards.length > 0
              ? subCards
                  .map(
                    (sc) =>
                      `${sc.badge ? `[${sc.badge}] ` : ""}${sc.title}${sc.subtitle ? ` (${sc.subtitle})` : ""} : ${sc.body}`,
                  )
                  .join(" ; ")
              : translateValue(null, lang);
          fields.push({
            key: "exams_list",
            label: formatFieldLabel("exams_list", lang),
            value: summaryVal,
            rawValue: examArr,
            editValue: "",
            inputType: "exams_list",
            nullable: false,
            examItems: extractNormalizedExamsList(rawObj),
            isLongText: true,
            hiddenInReadView: subCards.length > 0,
          });
          continue;
        }

        if (k === "chemotherapy_list" || fieldSchema?.inputType === "chemotherapy_list") {
          const chemoArr = Array.isArray(v) ? v : [];
          for (const item of chemoArr) {
            if (item && typeof item === "object") {
              const ch = item as Record<string, unknown>;
              const dates = [ch.chemotherapy_start_date, ch.chemotherapy_end_date]
                .filter((d) => Boolean(d) && d !== "Not_given")
                .map((d) => translateValue(d, lang))
                .join(" → ");
              subCards.push({
                title: String(ch.chemotherapy_name ?? formatFieldLabel("chemotherapy_name", lang)),
                badge: lang === "fr" ? "Chimiothérapie" : "Chemotherapy",
                subtitle: dates || null,
                body: ch.chemotherapy_tolerance
                  ? `${lang === "fr" ? "Tolérance" : "Tolerance"} : ${translateValue(ch.chemotherapy_tolerance, lang)}`
                  : translateValue(null, lang),
              });
            }
          }
          const summaryVal =
            subCards.length > 0
              ? subCards
                  .map((sc) => `${sc.title}${sc.subtitle ? ` (${sc.subtitle})` : ""} — ${sc.body}`)
                  .join(" ; ")
              : translateValue(null, lang);
          fields.push({
            key: "chemotherapy_list",
            label: formatFieldLabel("chemotherapy_list", lang),
            value: summaryVal,
            rawValue: chemoArr,
            editValue: "",
            inputType: "chemotherapy_list",
            nullable: false,
            chemoItems: extractNormalizedChemoList(rawObj),
            isLongText: true,
            hiddenInReadView: subCards.length > 0 || !wasPresentInRaw,
          });
          continue;
        }

        let formatted: string;
        if (sectionName === "TumorBiology" && k === "msi_state" && typeof v === "boolean") {
          formatted = v ? "MSI" : "MSS";
        } else if (Array.isArray(v)) {
          formatted =
            v.length === 0
              ? lang === "fr"
                ? "Aucun"
                : "None"
              : v
                  .map((item) =>
                    typeof item === "object" && item !== null
                      ? Object.entries(item as Record<string, unknown>)
                          .filter(([sk, sv]) => !internalKeys.has(sk) && Boolean(sv))
                          .map(([, sv]) => translateValue(sv, lang))
                          .join(" · ")
                      : translateValue(item, lang),
                  )
                  .join(" ; ");
        } else if (typeof v === "object" && v !== null) {
          formatted = Object.entries(v as Record<string, unknown>)
            .filter(([sk, sv]) => !internalKeys.has(sk) && sv !== undefined && sv !== null)
            .map(([sk, sv]) => `${formatFieldLabel(sk, lang)} : ${translateValue(sv, lang)}`)
            .join(" · ");
        } else {
          formatted = translateValue(v, lang);
        }

        const finalVal = formatted || translateValue(null, lang);
        const cleanedRaw = typeof v === "string" && /\d{4}-\d{2}-\d{2}T/.test(v) ? finalVal : v;
        const inputType: FieldInputKind =
          fieldSchema?.inputType ??
          (LONG_TEXT_KEYS.has(k) || finalVal.length > 90 ? "textarea" : "text");
        const editValue = formatRawEditValue(v, fieldSchema);
        const badgeTone: "green" | "orange" | "red" | null =
          sectionName === "MTDCompleted" && k === "is_mtd_complete"
            ? v === true ||
              String(v ?? "")
                .trim()
                .toLowerCase() === "true" ||
              String(v ?? "")
                .trim()
                .toLowerCase() === "yes" ||
              String(v ?? "")
                .trim()
                .toLowerCase() === "oui"
              ? "green"
              : String(v ?? "")
                    .trim()
                    .toLowerCase() === "partial" ||
                  String(v ?? "")
                    .trim()
                    .toLowerCase() === "partiel"
                ? "orange"
                : "red"
            : null;

        fields.push({
          key: k,
          label: formatFieldLabel(k, lang),
          value: finalVal,
          rawValue: cleanedRaw,
          editValue,
          inputType,
          nullable: fieldSchema?.nullable ?? true,
          min: fieldSchema?.min,
          max: fieldSchema?.max,
          step: fieldSchema?.step,
          unit: fieldSchema?.unit,
          placeholder: lang === "fr" ? fieldSchema?.placeholderFr : fieldSchema?.placeholderEn,
          options: mapOptions(fieldSchema?.options),
          isLongText: inputType === "textarea" || LONG_TEXT_KEYS.has(k) || finalVal.length > 90,
          hiddenInReadView:
            !wasPresentInRaw ||
            (sectionName === "MTDCompleted" &&
              k === "what_missing" &&
              Array.isArray(v) &&
              v.length > 0),
          badgeTone,
        });
      }

      const mtdFieldTone =
        sectionName === "MTDCompleted"
          ? (fields.find((f) => f.key === "is_mtd_complete")?.badgeTone ?? null)
          : null;
      const carePriorityLevel =
        sectionName === "CareOrientationProposal"
          ? normalizePriorityLevel(rawObj.suggested_priority ?? form.metrics.discussion_priority)
          : null;
      const sectionTone: "green" | "orange" | "red" | "neutral" | null =
        sectionName === "MTDCompleted"
          ? form.metrics.completeness_status === "pending"
            ? "neutral"
            : (form.metrics.completeness_tone ?? mtdFieldTone ?? "neutral")
          : sectionName === "CareOrientationProposal"
            ? carePriorityLevel === 1
              ? "red"
              : rawObj.care_adaptation_suggested === true ||
                  form.metrics.care_adaptation_suggested === true
                ? "orange"
                : "green"
            : null;
      const summaryText = this.extractSectionHeaderSummary(
        sectionName,
        rawObj,
        subCards,
        fields,
        lang,
        form,
      );

      const canonicalSection = resolveCanonicalSectionName(sectionName);
      const rawManualMeta =
        form.manualEdits[sectionName] ?? form.manualEdits[canonicalSection] ?? null;
      const isManual = Boolean(
        rawManualMeta && (rawManualMeta as Record<string, unknown>).is_manual !== false,
      );
      const manualMeta = isManual ? rawManualMeta : null;
      const manualDiffs: DossierManualDiffView[] = [];
      const diffMap = new Map<string, string>();
      if (manualMeta?.modified_fields && typeof manualMeta.modified_fields === "object") {
        for (const [fKey, diff] of Object.entries(manualMeta.modified_fields)) {
          if (diff && typeof diff === "object") {
            const aiFormatted = translateValue(diff.ai_value, lang);
            manualDiffs.push({
              key: fKey,
              label: formatFieldLabel(fKey, lang),
              aiValue: aiFormatted,
              humanValue: translateValue(diff.human_value, lang),
            });
            diffMap.set(fKey, aiFormatted);
          }
        }
      }

      if (isManual && diffMap.size > 0) {
        for (const f of fields) {
          if (diffMap.has(f.key)) {
            f.isModified = true;
            f.originalAiValue = diffMap.get(f.key);
          }
        }
      }

      const reasoningThinking =
        typeof rawObj.reasoning_thinking === "string" && rawObj.reasoning_thinking.trim()
          ? rawObj.reasoning_thinking.trim()
          : null;
      const durationSec =
        form.executionTimes[sectionName] ??
        (typeof rawObj.time_execution === "number"
          ? Math.round(rawObj.time_execution * 10) / 10
          : null);

      result.push({
        name: sectionName,
        meta,
        summaryText,
        sectionTone,
        fields,
        subCards,
        references,
        rawData: rawObj,
        isManual,
        manualMeta,
        manualDiffs,
        reasoningThinking,
        userPrompt: meta.userPrompt ?? null,
        durationSec,
      });
    }

    return result.sort((a, b) => a.meta.order - b.meta.order);
  }

  private buildOpinions(form: MdtFormDetail, lang: Language): SpecialtyOpinionItem[] {
    const rawExperts = (form.sections.ExpertAnswer ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const items: SpecialtyOpinionItem[] = [];

    for (const [agentKey, payload] of Object.entries(rawExperts)) {
      if (!payload || typeof payload !== "object") continue;
      const pres = getAgentPresentation(agentKey, lang);
      const relevant = payload.expert_relevant !== false;
      const priorityLevel = normalizePriorityLevel(payload.discussion_priority);
      const whyRelevant = String(payload.why_relevant ?? "");
      const reasoningThinking =
        typeof payload.reasoning_thinking === "string" && payload.reasoning_thinking.trim()
          ? payload.reasoning_thinking.trim()
          : null;
      const executionSeconds =
        typeof payload.time_execution === "number"
          ? Math.round(payload.time_execution * 10) / 10
          : null;
      const rawSuggestions = Array.isArray(payload.suggestions)
        ? (payload.suggestions as Array<Record<string, unknown>>)
        : [];

      const suggestions: ExpertSuggestion[] = rawSuggestions.map((s) => ({
        suggestion: String(s.suggestion ?? ""),
        why: s.why ? String(s.why) : undefined,
        references: Array.isArray(s.references)
          ? (s.references as Array<Record<string, unknown>>).map((r) => ({
              name: String(r.name ?? ""),
              page: (r.page as string | number | null) ?? null,
              position: r.position ? String(r.position) : null,
              excerpt: r.excerpt ? String(r.excerpt) : null,
            }))
          : [],
      }));

      const sources: CitationRef[] = Array.isArray(payload.sources_relevant)
        ? (payload.sources_relevant as Array<Record<string, unknown>>).map((r) => ({
            name: String(r.name ?? ""),
            page: (r.page as string | number | null) ?? null,
            position: r.position ? String(r.position) : null,
            excerpt: r.excerpt ? String(r.excerpt) : null,
          }))
        : [];

      items.push({
        agentKey,
        agentLabel: pres.label,
        agentIcon: pres.icon,
        relevant,
        priorityLevel,
        whyRelevant,
        suggestions,
        sources,
        reasoningThinking,
        executionSeconds,
      });
    }

    return items.sort((a, b) => {
      if (a.relevant !== b.relevant) return a.relevant ? -1 : 1;
      return priorityRank(a.priorityLevel) - priorityRank(b.priorityLevel);
    });
  }

  async updateSection(
    filename: string,
    section: string,
    data: Record<string, unknown>,
    editedBy: string,
    domain: ClinicalDomain,
  ): Promise<MdtFormDetail> {
    const [existingForm, domainSchema] = await Promise.all([
      this.api.getFormDetail(filename, domain).catch(() => null),
      this.api.getDomainSchema(domain).catch(() => null),
    ]);
    const existingSectionObj = (existingForm?.sections[section] ?? {}) as Record<string, unknown>;
    const coercedData = coerceSectionUpdatePayload(section, data, existingSectionObj, domainSchema);
    return this.api.updateFormSection(filename, section, coercedData, editedBy, domain);
  }

  async rollbackSection(
    filename: string,
    section: string,
    domain: ClinicalDomain,
  ): Promise<MdtFormDetail> {
    return this.api.rollbackSection(filename, section, domain);
  }

  async updateMissingItems(
    filename: string,
    input: MissingItemsUpdateInput,
    domain: ClinicalDomain,
  ): Promise<MdtFormDetail> {
    return this.api.updateMissingItems(filename, input, domain);
  }

  async rerunSection(
    filename: string,
    section: string,
    preserveManualEdits: boolean,
    domain: ClinicalDomain,
  ): Promise<{ jobId: string; preserveManualEdits: boolean }> {
    return this.api.rerunSection(filename, section, preserveManualEdits, domain);
  }

  async processFullForm(
    filename: string,
    preserveManualEdits: boolean,
    domain: ClinicalDomain,
  ): Promise<{ jobId: string }> {
    return this.api.processFullForm(filename, preserveManualEdits, domain);
  }

  async linkPatient(
    filename: string,
    patientId: string | null,
    domain: ClinicalDomain,
    editedBy?: string,
  ): Promise<void> {
    return this.api.linkFormToPatient(filename, patientId, domain, editedBy);
  }

  async askQuestion(
    target: { filename?: string; patientId?: string },
    question: string,
    domain: ClinicalDomain,
    lang: Language,
    agentName?: string,
  ): Promise<ChatReply> {
    return this.api.askDossierQuestion(target, question, domain, lang, agentName);
  }

  async getPatientDashboard(
    patientId: string,
    domain: ClinicalDomain,
  ): Promise<PatientDashboardView | null> {
    return this.api.getPatientDashboard(patientId, domain);
  }

  async triggerPatientSummary(
    patientId: string,
    domain: ClinicalDomain,
    force = false,
  ): Promise<{
    queued: boolean;
    alreadyQueued: boolean;
    jobId?: string | null;
    summary: PatientRecordSummaryView | null;
  }> {
    return this.api.triggerPatientSummary(patientId, domain, force);
  }
}
