import { formatFieldLabel } from "./catalog.js";
import { t, translateValue } from "./i18n.js";
import type {
  CompletenessStatus,
  Language,
  LongitudinalDelta,
  MdtFormCard,
  MdtFormDetail,
  OrientationStatus,
  PriorityLevel,
  WorklistFilter,
  WorklistKpis,
} from "./types.js";

export function normalizePriorityLevel(raw: unknown): PriorityLevel {
  if (!raw) return "none";
  const str = String(raw).trim().toLowerCase();
  if (
    str === "low" ||
    str.includes("not urgent") ||
    str.includes("pas d'urgence") ||
    str.includes("standard") ||
    str.includes("faible") ||
    str.includes("basse")
  ) {
    return "low";
  }
  if (
    str === "medium" ||
    str === "moderate" ||
    str.includes("semi-urgent") ||
    str.includes("semi urgent") ||
    str.includes("soon as possible") ||
    str.includes("modérée") ||
    str.includes("moyen")
  ) {
    return "medium";
  }
  if (
    str === "high" ||
    str === "urgent" ||
    str.includes("high-priority") ||
    str.includes("urgent") ||
    str.includes("haute") ||
    str.includes("quickly")
  ) {
    return "high";
  }
  return "none";
}

export function priorityRank(level: PriorityLevel): number {
  switch (level) {
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

export function derivePriorityBadgeInfo(
  level: PriorityLevel,
  lang: Language = "fr",
  short = false,
  reasonInput?: {
    urgency_reason?: string | null;
    urgency_reasons?: string[];
  },
): {
  level: PriorityLevel;
  icon: string;
  badgeClass: string;
  label: string;
  reason: string | null;
  reasons: string[];
} {
  const key = short ? `priority.${level}.short` : `priority.${level}`;
  const rawReasons = Array.isArray(reasonInput?.urgency_reasons)
    ? reasonInput.urgency_reasons.map((r) => String(r).trim()).filter(Boolean)
    : [];
  const rawSingle = reasonInput?.urgency_reason ? String(reasonInput.urgency_reason).trim() : null;
  const reasons = rawReasons.length > 0 ? rawReasons : rawSingle ? [rawSingle] : [];
  const reason = rawSingle || (reasons.length > 0 ? reasons.join("\n\n") : null);

  switch (level) {
    case "high":
      return {
        level,
        icon: "ic-priority-high",
        badgeClass: "ds-badge--urgency-high",
        label: t(key, lang),
        reason,
        reasons,
      };
    case "medium":
      return {
        level,
        icon: "ic-priority-medium",
        badgeClass: "ds-badge--urgency-medium",
        label: t(key, lang),
        reason,
        reasons,
      };
    case "low":
      return {
        level,
        icon: "ic-priority-low",
        badgeClass: "ds-badge--urgency-low",
        label: t(key, lang),
        reason,
        reasons,
      };
    default:
      return {
        level: "none",
        icon: "ic-priority-none",
        badgeClass: "ds-badge--urgency-none",
        label: t(key, lang),
        reason,
        reasons,
      };
  }
}

/**
 * Medico-legal non-prescriptive orientation badge derivation (ML-1, ML-2, ML-3).
 * Never uses red/rose or prescriptive wording.
 */
export function deriveOrientationInfo(
  input: {
    care_adaptation_suggested?: boolean | null;
    proposed_care_type?: string | null;
  },
  lang: Language = "fr",
): {
  status: OrientationStatus;
  icon: string;
  badgeClass: string;
  label: string;
  proposedCareType: string | null;
} {
  if (input.care_adaptation_suggested === true) {
    return {
      status: "adapt",
      icon: "ic-compass",
      badgeClass: "ds-badge--orientation-adapt",
      label: t("orientation.adapt", lang),
      proposedCareType: input.proposed_care_type ?? null,
    };
  }
  if (input.care_adaptation_suggested === false) {
    return {
      status: "standard",
      icon: "ic-check-circle",
      badgeClass: "ds-badge--orientation-standard",
      label: t("orientation.standard", lang),
      proposedCareType: null,
    };
  }
  return {
    status: "pending",
    icon: "ic-clock",
    badgeClass: "ds-badge--orientation-pending",
    label: t("orientation.pending", lang),
    proposedCareType: null,
  };
}

export function deriveCompletenessInfo(
  input: {
    is_complete?: boolean;
    completeness_status?: "yes" | "partial" | "no" | "pending" | string | null;
    is_manually_edited?: boolean;
    missing_count?: number;
    missing_items?: string[];
    processing_status?: string | null;
  },
  lang: Language = "fr",
): {
  status: CompletenessStatus;
  icon: string;
  badgeClass: string;
  tone: "green" | "orange" | "red" | "neutral";
  label: string;
  isOptionalMissing: boolean;
  missingCount: number;
  missingItems: string[];
} {
  const missingItems = input.missing_items ?? [];
  const missingCount =
    typeof input.missing_count === "number" ? input.missing_count : missingItems.length;
  const statusUpper = String(input.processing_status ?? "COMPLETED")
    .trim()
    .toUpperCase();
  const isAiCompleted = statusUpper === "COMPLETED";
  const isEvaluated = isAiCompleted || Boolean(input.is_manually_edited);
  const rawStatus = input.completeness_status
    ? String(input.completeness_status).trim().toLowerCase()
    : null;

  if (
    !isEvaluated ||
    rawStatus === "pending" ||
    (rawStatus === null && input.is_complete !== true && missingCount === 0)
  ) {
    return {
      status: "pending",
      icon: "ic-clock",
      badgeClass: "ds-badge--neutral",
      tone: "neutral",
      label: t("completeness.pending", lang),
      isOptionalMissing: false,
      missingCount: 0,
      missingItems: [],
    };
  }

  if (rawStatus === "yes" || (rawStatus === null && input.is_complete === true)) {
    if (missingCount > 0) {
      return {
        status: "complete",
        icon: "ic-check-circle",
        badgeClass: "ds-badge--complete",
        tone: "green",
        label:
          lang === "fr"
            ? `${missingCount} élément(s) facultatif(s) manquant(s)`
            : `${missingCount} optional missing item(s)`,
        isOptionalMissing: true,
        missingCount,
        missingItems,
      };
    }
    return {
      status: "complete",
      icon: "ic-check-circle",
      badgeClass: "ds-badge--complete",
      tone: "green",
      label: t("completeness.complete", lang),
      isOptionalMissing: false,
      missingCount: 0,
      missingItems: [],
    };
  }

  if (rawStatus === "partial") {
    return {
      status: "partial",
      icon: "ic-warning",
      badgeClass: "ds-badge--incomplete",
      tone: "orange",
      label:
        missingCount > 0
          ? lang === "fr"
            ? `Partiel · ${missingCount} manquante${missingCount > 1 ? "s" : ""}`
            : `Partial · ${missingCount} missing`
          : lang === "fr"
            ? "Dossier partiel"
            : "Partial record",
      isOptionalMissing: false,
      missingCount,
      missingItems,
    };
  }

  return {
    status: "incomplete",
    icon: "ic-error",
    badgeClass: "ds-badge--urgency-high",
    tone: "red",
    label:
      missingCount > 0
        ? lang === "fr"
          ? `Incomplet · ${missingCount} manquante${missingCount > 1 ? "s" : ""}`
          : `Incomplete · ${missingCount} missing`
        : lang === "fr"
          ? "Dossier incomplet"
          : "Incomplete record",
    isOptionalMissing: false,
    missingCount,
    missingItems,
  };
}

export function computeWorklistKpis(cards: MdtFormCard[]): WorklistKpis {
  let structuredCount = 0;
  let highPriorityCount = 0;
  let incompleteCount = 0;
  let adaptationSuggestedCount = 0;

  for (const card of cards) {
    const isAiCompleted =
      String(card.processingStatus ?? "COMPLETED")
        .trim()
        .toUpperCase() === "COMPLETED";
    if (isAiCompleted) {
      structuredCount += 1;
    }
    if (card.priorityLevel === "high") {
      highPriorityCount += 1;
    }
    if (!isAiCompleted || !card.isComplete) {
      incompleteCount += 1;
    }
    if (card.careAdaptationSuggested === true) {
      adaptationSuggestedCount += 1;
    }
  }

  return {
    structuredCount,
    highPriorityCount,
    incompleteCount,
    adaptationSuggestedCount,
  };
}

export function filterAndSortCards(
  cards: MdtFormCard[],
  filter: WorklistFilter = {},
): MdtFormCard[] {
  const q = (filter.query ?? "").trim().toLowerCase();
  const completeness = filter.completeness ?? "all";
  const priority = filter.priority ?? "all";
  const orientation = filter.orientation ?? "all";
  const domain = filter.domain ?? "all";
  const sortBy = filter.sortBy ?? "priority";
  const sortDir = filter.sortDir ?? "asc";

  const filtered = cards.filter((card) => {
    const isAiCompleted =
      String(card.processingStatus ?? "COMPLETED")
        .trim()
        .toUpperCase() === "COMPLETED";
    const isCardComplete = isAiCompleted && card.isComplete;
    if (domain !== "all" && card.domain !== domain) return false;
    if (completeness === "complete" && !isCardComplete) return false;
    if (completeness === "partial" && card.completenessStatus !== "partial") return false;
    if (completeness === "incomplete" && isCardComplete) return false;
    if (priority !== "all" && card.priorityLevel !== priority) return false;
    if (orientation === "adapt" && card.careAdaptationSuggested !== true) return false;
    if (orientation === "standard" && card.careAdaptationSuggested !== false) return false;
    if (orientation === "pending" && card.careAdaptationSuggested !== null) return false;

    if (q) {
      const haystack = [
        card.id,
        card.file,
        card.patientId ?? "",
        card.patientName,
        card.summaryText,
        card.proposedCareType ?? "",
        ...card.specialties,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const completenessSeverity = (card: MdtFormCard): number => {
    const isAiCompleted =
      String(card.processingStatus ?? "COMPLETED")
        .trim()
        .toUpperCase() === "COMPLETED";
    if (!isAiCompleted || card.completenessStatus === "pending") return 2;
    if (card.isComplete || card.completenessStatus === "yes") return 3;
    if (card.completenessStatus === "partial") return 1;
    return 0;
  };

  const dir = sortDir === "desc" ? -1 : 1;
  return [...filtered].sort((a, b) => {
    if (sortBy === "patient") {
      return a.patientName.localeCompare(b.patientName, "fr") * dir;
    }
    if (sortBy === "date") {
      return (b.mdtDate ?? "").localeCompare(a.mdtDate ?? "") * dir;
    }
    if (sortBy === "completeness") {
      const sevDiff = (completenessSeverity(a) - completenessSeverity(b)) * dir;
      if (sevDiff !== 0) return sevDiff;
      const compDiff = (b.missingCount - a.missingCount) * dir;
      if (compDiff !== 0) return compDiff;
      return a.patientName.localeCompare(b.patientName, "fr");
    }
    if (sortBy === "orientation") {
      const rankOrient = (v: boolean | null) => (v === true ? 0 : v === null ? 1 : 2);
      const orientDiff =
        (rankOrient(a.careAdaptationSuggested) - rankOrient(b.careAdaptationSuggested)) * dir;
      if (orientDiff !== 0) return orientDiff;
      return a.patientName.localeCompare(b.patientName, "fr");
    }
    if (sortBy === "specialties") {
      const specDiff = (b.specialties.length - a.specialties.length) * dir;
      if (specDiff !== 0) return specDiff;
      return a.patientName.localeCompare(b.patientName, "fr");
    }
    // Default: priority high > medium > low > none, then most recent mdtDate
    const rankDiff = (priorityRank(a.priorityLevel) - priorityRank(b.priorityLevel)) * dir;
    if (rankDiff !== 0) return rankDiff;
    return (b.mdtDate ?? "").localeCompare(a.mdtDate ?? "");
  });
}

export function computeLongitudinalDeltas(
  currentForm: MdtFormDetail,
  previousForm: MdtFormDetail | null | undefined,
  lang: Language = "fr",
): LongitudinalDelta[] {
  if (!previousForm) return [];

  const deltas: LongitudinalDelta[] = [];
  const prevDate = previousForm.mdtDate ?? "RCP préc.";

  // Compare key numeric/clinical markers across sections
  const trackedKeys = (
    [
      ["PatientPerformanceStatus", "performance_status", true],
      ["MotorFunctionStatus", "mfm_total_score", false],
      ["MotorFunctionStatus", "mfm_d1_score", false],
      ["MotorFunctionStatus", "mfm_d2_score", false],
      ["MotorFunctionStatus", "mfm_d3_score", false],
      ["MotorFunctionStatus", "rulm_score", false],
      ["MotorFunctionStatus", "chop_intend_score", false],
      ["MotorFunctionStatus", "hfmse_score", false],
      ["RespiratoryFunction", "forced_vital_capacity_percent", false],
      ["RespiratoryFunction", "daily_ventilation_hours", true],
      ["OrthopedicAndSpineStatus", "scoliosis_cobb_angle", true],
    ] as const
  ).map(([section, field, higherIsWorse]) => ({ section, field, higherIsWorse }));

  for (const item of trackedKeys) {
    const curSec = currentForm.sections[item.section];
    const prevSec = previousForm.sections[item.section];
    if (!curSec || !prevSec) continue;

    const curRaw = curSec[item.field];
    const prevRaw = prevSec[item.field];
    if (curRaw === undefined || curRaw === null || prevRaw === undefined || prevRaw === null) {
      continue;
    }

    const curMatch = String(curRaw)
      .replace(/,/g, ".")
      .match(/[-+]?\d+(?:\.\d+)?/);
    const prevMatch = String(prevRaw)
      .replace(/,/g, ".")
      .match(/[-+]?\d+(?:\.\d+)?/);
    const curNum = curMatch ? Number(curMatch[0]) : Number.NaN;
    const prevNum = prevMatch ? Number(prevMatch[0]) : Number.NaN;
    if (!Number.isNaN(curNum) && !Number.isNaN(prevNum)) {
      const diff = Math.round((curNum - prevNum) * 100) / 100;
      if (diff === 0) {
        deltas.push({
          key: item.field,
          label: formatFieldLabel(item.field, lang),
          currentValue: translateValue(curRaw, lang),
          previousValue: translateValue(prevRaw, lang),
          previousDate: prevDate,
          deltaText: "= stable",
          direction: "stable",
          icon: "ic-check",
        });
      } else {
        const sign = diff > 0 ? `+${diff}` : `${diff}`;
        const isWorse = item.higherIsWorse ? diff > 0 : diff < 0;
        deltas.push({
          key: item.field,
          label: formatFieldLabel(item.field, lang),
          currentValue: translateValue(curRaw, lang),
          previousValue: translateValue(prevRaw, lang),
          previousDate: prevDate,
          deltaText: `${sign} vs ${prevDate}`,
          direction: isWorse ? "worse" : "better",
          icon: diff > 0 ? "ic-trend-up" : "ic-trend-down",
        });
      }
    }
  }

  return deltas;
}
