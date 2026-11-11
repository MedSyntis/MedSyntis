import {
  type FieldSelectOption,
  getSectionFieldSchemas,
  resolveCanonicalSectionName,
  type SectionFieldSchema,
} from "./field-schema.js";
import type { DomainFormSchema } from "./types.js";

const EMPTY_PLACEHOLDERS = new Set([
  "",
  "-",
  "—",
  "null",
  "undefined",
  "none",
  "aucun",
  "aucune",
  "non renseigné",
  "non renseigne",
  "non spécifié",
  "non specifie",
  "non mentionné",
  "non mentionne",
  "not documented",
  "not documented in record",
  "not mentioned",
  "not mentioned in record",
  "not_given",
  "no data",
]);

export function isPlaceholderValue(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === "string") {
    return EMPTY_PLACEHOLDERS.has(val.trim().toLowerCase());
  }
  return false;
}

export function formatRawEditValue(val: unknown, schema?: SectionFieldSchema): string {
  if (val === null || val === undefined) return "";
  if (schema?.inputType === "boolean") {
    return coerceBooleanValue(val, Boolean(schema.defaultValue ?? false)) ? "true" : "false";
  }
  if (schema?.inputType === "nullable_boolean") {
    const parsed = coerceNullableBooleanValue(val);
    return parsed === null ? "" : parsed ? "true" : "false";
  }
  if (schema?.inputType === "string_list") {
    if (Array.isArray(val)) {
      const sep = schema.key === "what_missing" ? "\n" : ", ";
      return val
        .map((item) => String(item ?? "").trim())
        .filter((s) => s.length > 0 && !isPlaceholderValue(s))
        .join(sep);
    }
    if (typeof val === "string") {
      return isPlaceholderValue(val) ? "" : val.trim();
    }
    return "";
  }
  if (schema?.inputType === "date") {
    const iso = coerceDateValue(val);
    return iso ?? "";
  }
  if (schema?.inputType === "integer" || schema?.inputType === "integer_select") {
    const num = coerceNumberValue(val, true, schema.min, schema.max);
    if (num === null) {
      return schema.nullable ? "" : String(schema.defaultValue ?? 0);
    }
    return String(num);
  }
  if (schema?.inputType === "float") {
    const num = coerceNumberValue(val, false, schema.min, schema.max);
    if (num === null) {
      return schema.nullable ? "" : String(schema.defaultValue ?? 0);
    }
    return String(num);
  }
  if (schema?.inputType === "select" && schema.options) {
    return coerceSelectValue(val, schema.options, String(schema.defaultValue ?? ""));
  }
  if (typeof val === "string") {
    return isPlaceholderValue(val) ? "" : val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return "";
}

export function coerceBooleanValue(val: unknown, fallback = false): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    const clean = val.trim().toLowerCase();
    if (
      ["true", "1", "yes", "oui", "vrai", "on", "present", "présent", "confirmé"].includes(clean)
    ) {
      return true;
    }
    if (["false", "0", "no", "non", "faux", "off", "absent", "none", "aucun"].includes(clean)) {
      return false;
    }
  }
  return fallback;
}

export function coerceNullableBooleanValue(val: unknown): boolean | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const clean = val.trim().toLowerCase();
    if (!clean || isPlaceholderValue(clean)) return null;
    if (["true", "1", "yes", "oui", "msi", "instabilité microsatellitaire"].includes(clean)) {
      return true;
    }
    if (["false", "0", "no", "non", "mss", "microsatellite stable"].includes(clean)) {
      return false;
    }
  }
  return null;
}

export function coerceNumberValue(
  val: unknown,
  asInteger: boolean,
  min?: number,
  max?: number,
): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return null;
    let num = asInteger ? Math.round(val) : val;
    if (min !== undefined && num < min) num = min;
    if (max !== undefined && num > max) num = max;
    return num;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || isPlaceholderValue(trimmed)) return null;
    // Extract first numeric token (supports French comma decimal "72,5", "OMS 2", "42/66", "72 %")
    const normalized = trimmed.replace(/,/g, ".");
    const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) return null;
    let num = asInteger ? Math.round(parsed) : parsed;
    if (min !== undefined && num < min) num = min;
    if (max !== undefined && num > max) num = max;
    return num;
  }
  return null;
}

export function coerceDateValue(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || isPlaceholderValue(trimmed)) return null;
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }
    const frMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (frMatch) {
      return `${frMatch[3]}-${frMatch[2]}-${frMatch[1]}`;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return null;
}

export function coerceSelectValue(
  val: unknown,
  options: FieldSelectOption[],
  fallback: string,
): string {
  if (val === null || val === undefined) return fallback;
  const raw = String(val).trim();
  if (!raw) return fallback;
  const rawLower = raw.toLowerCase();
  for (const opt of options) {
    if (
      opt.value === raw ||
      opt.value.toLowerCase() === rawLower ||
      opt.labelFr.toLowerCase() === rawLower ||
      opt.labelEn.toLowerCase() === rawLower
    ) {
      return opt.value;
    }
  }
  // Partial / alias matching for clinical enums
  if (rawLower.includes("bipap") || rawLower.includes("vni") || rawLower.includes("non-invasive")) {
    const niv = options.find((o) => o.value.includes("NIV") || o.value.includes("BiPAP"));
    if (niv) return niv.value;
  }
  if (rawLower.includes("gpe") || rawLower.includes("gastrostom") || rawLower.includes("g-tube")) {
    const gpe = options.find((o) => o.value.includes("Gastrostomy"));
    if (gpe) return gpe.value;
  }
  if (
    rawLower.includes("underweight") ||
    rawLower.includes("maigreur") ||
    rawLower.includes("cassure")
  ) {
    const uw = options.find((o) => o.value.includes("Underweight"));
    if (uw) return uw.value;
  }
  // Priority level / PatientPriority enum aliases
  if (
    rawLower === "high" ||
    rawLower === "urgent" ||
    rawLower.includes("high-priority") ||
    rawLower.includes("urgently") ||
    (rawLower.includes("urgent") && !rawLower.includes("semi") && !rawLower.includes("not urgent"))
  ) {
    const hi = options.find(
      (o) =>
        o.value === "high" ||
        o.value.toLowerCase().includes("high-priority") ||
        o.value.toLowerCase().includes("urgently"),
    );
    if (hi) return hi.value;
  }
  if (
    rawLower === "medium" ||
    rawLower.includes("semi-urgent") ||
    rawLower.includes("soon as possible") ||
    rawLower.includes("modérée")
  ) {
    const med = options.find(
      (o) =>
        o.value === "medium" ||
        o.value.toLowerCase().includes("semi-urgent") ||
        o.value.toLowerCase().includes("soon as possible"),
    );
    if (med) return med.value;
  }
  if (rawLower === "low" || rawLower.includes("not urgent") || rawLower.includes("standard")) {
    const lo = options.find(
      (o) => o.value === "low" || o.value.toLowerCase() === "patient is not urgent",
    );
    if (lo) return lo.value;
  }
  if (rawLower === "none" || rawLower === "no answer" || rawLower === "not_given") {
    const noneOpt = options.find((o) => o.value === "none" || o.value === "no answer");
    if (noneOpt) return noneOpt.value;
  }
  return fallback;
}

export function coerceMultilineStringListValue(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .map((item) => String(item ?? "").trim())
      .filter((s) => s.length > 0 && !isPlaceholderValue(s));
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || isPlaceholderValue(trimmed)) return [];
    return trimmed
      .split(/[;\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isPlaceholderValue(s));
  }
  return [];
}

export function coerceStringListValue(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .map((item) => String(item ?? "").trim())
      .filter((s) => s.length > 0 && !isPlaceholderValue(s));
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || isPlaceholderValue(trimmed)) return [];
    return trimmed
      .split(/[,;\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isPlaceholderValue(s));
  }
  return [];
}

function normalizeExamType(raw: unknown): "CT" | "MRI" | "PET" | "EUS" {
  const s = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (s === "MRI" || s.includes("IRM")) return "MRI";
  if (s === "PET" || s.includes("TEP")) return "PET";
  if (s === "EUS" || s.includes("ECHO")) return "EUS";
  return "CT";
}

function normalizeChemoTolerance(raw: unknown): "Good" | "Medium" | "Poor" {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "good" || s.includes("bon")) return "Good";
  if (
    s === "poor" ||
    s.includes("mauvais") ||
    s.includes("sévère") ||
    s.includes("grade 3") ||
    s.includes("grade 4")
  ) {
    return "Poor";
  }
  return "Medium";
}

export interface NormalizedExamItem {
  exam_name: string;
  exam_date: string | null;
  exam_type: "CT" | "MRI" | "PET" | "EUS";
  exam_result: string | null;
}

export interface NormalizedChemoItem {
  chemotherapy_name: string;
  chemotherapy_start_date: string | null;
  chemotherapy_end_date: string | null;
  chemotherapy_tolerance: "Good" | "Medium" | "Poor";
}

export function extractNormalizedExamsList(
  rawSectionObj: Record<string, unknown>,
): NormalizedExamItem[] {
  const rawList = Array.isArray(rawSectionObj.exams_list)
    ? rawSectionObj.exams_list
    : Array.isArray(rawSectionObj.radiological_exams)
      ? rawSectionObj.radiological_exams
      : [];
  const items: NormalizedExamItem[] = [];
  for (const item of rawList) {
    if (item && typeof item === "object") {
      const ex = item as Record<string, unknown>;
      const name = String(ex.exam_name ?? "").trim();
      if (!name && !ex.exam_result) continue;
      items.push({
        exam_name: name || "Examen d'imagerie",
        exam_date: coerceDateValue(ex.exam_date),
        exam_type: normalizeExamType(ex.exam_type),
        exam_result: isPlaceholderValue(ex.exam_result)
          ? null
          : String(ex.exam_result ?? "").trim() || null,
      });
    }
  }
  return items;
}

export function extractNormalizedChemoList(
  rawSectionObj: Record<string, unknown>,
): NormalizedChemoItem[] {
  const rawList = Array.isArray(rawSectionObj.chemotherapy_list)
    ? rawSectionObj.chemotherapy_list
    : [];
  const items: NormalizedChemoItem[] = [];
  for (const item of rawList) {
    if (item && typeof item === "object") {
      const ch = item as Record<string, unknown>;
      const name = String(ch.chemotherapy_name ?? "").trim();
      if (!name) continue;
      items.push({
        chemotherapy_name: name,
        chemotherapy_start_date: coerceDateValue(ch.chemotherapy_start_date),
        chemotherapy_end_date: coerceDateValue(ch.chemotherapy_end_date),
        chemotherapy_tolerance: normalizeChemoTolerance(ch.chemotherapy_tolerance),
      });
    }
  }
  if (items.length === 0 && typeof rawSectionObj.chemotherapy_name === "string") {
    const topName = rawSectionObj.chemotherapy_name.trim();
    if (topName && !isPlaceholderValue(topName)) {
      items.push({
        chemotherapy_name: topName,
        chemotherapy_start_date: coerceDateValue(rawSectionObj.chemotherapy_start_date),
        chemotherapy_end_date: coerceDateValue(rawSectionObj.chemotherapy_end_date),
        chemotherapy_tolerance: normalizeChemoTolerance(rawSectionObj.chemotherapy_tolerance),
      });
    }
  }
  return items;
}

/**
 * Systematically coerces an incoming section edit payload (`req.body` or API object)
 * into strict domain-compliant types matching the Python Pydantic section models.
 */
export function coerceSectionUpdatePayload(
  sectionName: string,
  rawBody: Record<string, unknown>,
  existingSectionData: Record<string, unknown> = {},
  domainSchema?: DomainFormSchema | null,
): Record<string, unknown> {
  const canonical = resolveCanonicalSectionName(sectionName);
  const schemas = getSectionFieldSchemas(sectionName, domainSchema);
  const mergedSource: Record<string, unknown> = {
    ...existingSectionData,
    ...rawBody,
  };

  if (canonical === "CareOrientationProposal") {
    const normalizeSuggestedPriority = (raw: unknown): "high" | "medium" | "low" | "none" => {
      const s = String(raw ?? "")
        .trim()
        .toLowerCase();
      if (
        s === "high" ||
        s === "urgent" ||
        s.includes("high-priority") ||
        s.includes("urgently") ||
        (s.includes("urgent") && !s.includes("semi") && !s.includes("not urgent")) ||
        s.includes("priorité haute") ||
        s.includes("priorite haute")
      ) {
        return "high";
      }
      if (
        s === "medium" ||
        s === "semi-urgent" ||
        s.includes("semi-urgent") ||
        s.includes("as soon as possible") ||
        s.includes("priorité modérée") ||
        s.includes("priorite moderee")
      ) {
        return "medium";
      }
      if (
        s === "low" ||
        s === "standard" ||
        s.includes("not urgent") ||
        s.includes("priorité standard") ||
        s.includes("priorite standard")
      ) {
        return "low";
      }
      return "none";
    };

    const rawAdapt =
      rawBody.care_adaptation_suggested !== undefined
        ? rawBody.care_adaptation_suggested
        : existingSectionData.care_adaptation_suggested;
    const careAdaptationSuggested = coerceBooleanValue(rawAdapt, false);

    const rawPrio =
      rawBody.suggested_priority !== undefined
        ? rawBody.suggested_priority
        : (existingSectionData.suggested_priority ?? "medium");
    const suggestedPriority = normalizeSuggestedPriority(rawPrio);

    const rawPrioReason =
      rawBody.priority_reason !== undefined
        ? rawBody.priority_reason
        : (existingSectionData.priority_reason ?? null);
    const priorityReason = isPlaceholderValue(rawPrioReason)
      ? null
      : String(rawPrioReason ?? "").trim() || null;

    const rawCareType =
      rawBody.proposed_care_type !== undefined
        ? rawBody.proposed_care_type
        : (existingSectionData.proposed_care_type ?? null);
    const proposedCareType = isPlaceholderValue(rawCareType)
      ? null
      : String(rawCareType ?? "").trim() || null;

    const rawRationale =
      rawBody.orientation_rationale !== undefined
        ? rawBody.orientation_rationale
        : rawBody.clinical_rationale !== undefined
          ? rawBody.clinical_rationale
          : (existingSectionData.orientation_rationale ??
            existingSectionData.clinical_rationale ??
            null);
    const orientationRationale = isPlaceholderValue(rawRationale)
      ? null
      : String(rawRationale ?? "").trim() || null;

    return {
      care_adaptation_suggested: careAdaptationSuggested,
      suggested_priority: suggestedPriority,
      priority_reason: priorityReason,
      proposed_care_type: proposedCareType,
      orientation_rationale: orientationRationale,
    };
  }

  if (canonical === "MTDCompleted") {
    const existingNested =
      existingSectionData.mtd_complete &&
      typeof existingSectionData.mtd_complete === "object" &&
      !Array.isArray(existingSectionData.mtd_complete)
        ? (existingSectionData.mtd_complete as Record<string, unknown>)
        : {};
    const rawMissing =
      rawBody.what_missing !== undefined
        ? rawBody.what_missing
        : (existingSectionData.what_missing ?? existingNested.what_missing ?? []);
    const whatMissing = coerceMultilineStringListValue(rawMissing);
    const rawComplete =
      rawBody.is_mtd_complete !== undefined
        ? rawBody.is_mtd_complete
        : (existingSectionData.is_mtd_complete ?? existingNested.is_mtd_complete);
    const rawCompStr = String(rawComplete ?? "")
      .trim()
      .toLowerCase();
    const isComplete: boolean | "partial" =
      rawCompStr === "partial" || rawCompStr === "partiel"
        ? "partial"
        : rawComplete !== undefined
          ? coerceBooleanValue(rawComplete, whatMissing.length === 0)
          : whatMissing.length === 0;
    const rawReflection =
      rawBody.reflection !== undefined
        ? rawBody.reflection
        : (existingSectionData.reflection ?? existingNested.reflection ?? null);
    const reflection = isPlaceholderValue(rawReflection)
      ? null
      : String(rawReflection ?? "").trim() || null;
    const references = Array.isArray(existingNested.references)
      ? existingNested.references
      : Array.isArray(existingSectionData.references)
        ? existingSectionData.references
        : [];

    return {
      mtd_complete: {
        is_mtd_complete: isComplete,
        what_missing: whatMissing,
        reflection,
        references,
      },
      is_mtd_complete: isComplete,
      what_missing: whatMissing,
      reflection,
    };
  }

  if (canonical === "RadiologicExams") {
    let examsList: NormalizedExamItem[] = [];
    const indexedIndices = new Set<number>();
    for (const k of Object.keys(rawBody)) {
      const m = k.match(/^exam_(?:name|type|date|result)_(\d+)$/);
      if (m?.[1]) indexedIndices.add(Number(m[1]));
    }
    if (indexedIndices.size > 0) {
      const sortedIdx = Array.from(indexedIndices).sort((a, b) => a - b);
      for (const idx of sortedIdx) {
        const name = String(rawBody[`exam_name_${idx}`] ?? "").trim();
        const resultRaw = rawBody[`exam_result_${idx}`];
        const result = isPlaceholderValue(resultRaw)
          ? null
          : String(resultRaw ?? "").trim() || null;
        if (!name && !result) continue;
        examsList.push({
          exam_name: name || "Examen d'imagerie",
          exam_date: coerceDateValue(rawBody[`exam_date_${idx}`]),
          exam_type: normalizeExamType(rawBody[`exam_type_${idx}`]),
          exam_result: result,
        });
      }
    } else if (Array.isArray(rawBody.exams_list)) {
      examsList = extractNormalizedExamsList(rawBody);
    } else if (rawBody.exams_list_present !== undefined) {
      examsList = [];
    } else {
      examsList = extractNormalizedExamsList(existingSectionData);
    }
    return { exams_list: examsList };
  }

  if (canonical === "ChemotherapyTreament") {
    let chemoList: NormalizedChemoItem[] = [];
    const indexedIndices = new Set<number>();
    for (const k of Object.keys(rawBody)) {
      const m = k.match(/^chemotherapy_(?:name|tolerance|start_date|end_date)_(\d+)$/);
      if (m?.[1]) indexedIndices.add(Number(m[1]));
    }
    if (indexedIndices.size > 0) {
      const sortedIdx = Array.from(indexedIndices).sort((a, b) => a - b);
      for (const idx of sortedIdx) {
        const name = String(rawBody[`chemotherapy_name_${idx}`] ?? "").trim();
        if (!name || isPlaceholderValue(name)) continue;
        chemoList.push({
          chemotherapy_name: name,
          chemotherapy_start_date: coerceDateValue(rawBody[`chemotherapy_start_date_${idx}`]),
          chemotherapy_end_date: coerceDateValue(rawBody[`chemotherapy_end_date_${idx}`]),
          chemotherapy_tolerance: normalizeChemoTolerance(rawBody[`chemotherapy_tolerance_${idx}`]),
        });
      }
    } else if (Array.isArray(rawBody.chemotherapy_list)) {
      chemoList = extractNormalizedChemoList(rawBody);
    } else if (typeof rawBody.chemotherapy_name === "string" && rawBody.chemotherapy_name.trim()) {
      chemoList = extractNormalizedChemoList({
        ...existingSectionData,
        ...rawBody,
        chemotherapy_list: [],
      });
    } else if (rawBody.chemotherapy_list_present !== undefined) {
      chemoList = [];
    } else {
      chemoList = extractNormalizedChemoList(existingSectionData);
    }

    const hasChemo =
      rawBody.chemotherapy !== undefined
        ? coerceBooleanValue(rawBody.chemotherapy, chemoList.length > 0)
        : rawBody.chemotherapy_list_present !== undefined || indexedIndices.size > 0
          ? chemoList.length > 0
          : chemoList.length > 0 || coerceBooleanValue(existingSectionData.chemotherapy, false);

    const out: Record<string, unknown> = {
      chemotherapy: hasChemo,
      chemotherapy_list: hasChemo ? chemoList : [],
    };
    if (typeof rawBody.chemotherapy_name === "string" && rawBody.chemotherapy_name.trim()) {
      out.chemotherapy_name = rawBody.chemotherapy_name.trim();
    } else if (chemoList[0]?.chemotherapy_name) {
      out.chemotherapy_name = chemoList[0].chemotherapy_name;
    }
    if (
      typeof rawBody.chemotherapy_tolerance === "string" &&
      rawBody.chemotherapy_tolerance.trim()
    ) {
      out.chemotherapy_tolerance = rawBody.chemotherapy_tolerance.trim();
    }
    return out;
  }

  if (schemas.length === 0) {
    return mergedSource;
  }

  const out: Record<string, unknown> = {};
  const schemaKeys = new Set(schemas.map((s) => s.key));

  for (const fieldSchema of schemas) {
    const rawVal =
      rawBody[fieldSchema.key] !== undefined
        ? rawBody[fieldSchema.key]
        : existingSectionData[fieldSchema.key];

    switch (fieldSchema.inputType) {
      case "boolean": {
        out[fieldSchema.key] = coerceBooleanValue(
          rawVal,
          Boolean(fieldSchema.defaultValue ?? false),
        );
        break;
      }
      case "nullable_boolean": {
        out[fieldSchema.key] = coerceNullableBooleanValue(rawVal);
        break;
      }
      case "integer":
      case "integer_select": {
        const isRawMotorScale =
          canonical === "MotorFunctionStatus" &&
          (fieldSchema.key === "mfm_total_score" ||
            fieldSchema.key === "mfm_d1_score" ||
            fieldSchema.key === "mfm_d2_score" ||
            fieldSchema.key === "mfm_d3_score" ||
            fieldSchema.key === "rulm_score" ||
            fieldSchema.key === "hfmse_score" ||
            fieldSchema.key === "chop_intend_score");
        if (isRawMotorScale && typeof rawVal === "number" && !Number.isInteger(rawVal)) {
          const min = fieldSchema.min ?? 0;
          const max = fieldSchema.max ?? 100;
          out[fieldSchema.key] = Math.min(max, Math.max(min, rawVal));
          break;
        }
        if (
          isRawMotorScale &&
          typeof rawVal === "string" &&
          !isPlaceholderValue(rawVal) &&
          !/^[-+]?\d+$/.test(rawVal.trim())
        ) {
          const trimmed = rawVal.trim();
          const pctStripped = trimmed.endsWith("%") ? trimmed.slice(0, -1).trim() : trimmed;
          if (
            /^[-+]?\d+[.,]\d+$/.test(pctStripped) ||
            (trimmed.endsWith("%") && /^[-+]?\d+$/.test(pctStripped))
          ) {
            const floatVal = Number(pctStripped.replace(",", "."));
            const min = fieldSchema.min ?? 0;
            const max = fieldSchema.max ?? 100;
            out[fieldSchema.key] = Math.min(max, Math.max(min, floatVal));
          } else {
            out[fieldSchema.key] = trimmed;
          }
          break;
        }
        const num = coerceNumberValue(rawVal, true, fieldSchema.min, fieldSchema.max);
        out[fieldSchema.key] =
          num !== null ? num : fieldSchema.nullable ? null : Number(fieldSchema.defaultValue ?? 0);
        break;
      }
      case "float": {
        const num = coerceNumberValue(rawVal, false, fieldSchema.min, fieldSchema.max);
        out[fieldSchema.key] =
          num !== null ? num : fieldSchema.nullable ? null : Number(fieldSchema.defaultValue ?? 0);
        break;
      }
      case "date": {
        out[fieldSchema.key] = coerceDateValue(rawVal);
        break;
      }
      case "select": {
        out[fieldSchema.key] = coerceSelectValue(
          rawVal,
          fieldSchema.options ?? [],
          String(fieldSchema.defaultValue ?? ""),
        );
        break;
      }
      case "string_list": {
        out[fieldSchema.key] = coerceStringListValue(rawVal);
        break;
      }
      default: {
        if (isPlaceholderValue(rawVal)) {
          out[fieldSchema.key] = fieldSchema.nullable
            ? null
            : String(fieldSchema.defaultValue ?? "");
        } else {
          out[fieldSchema.key] = String(rawVal ?? "").trim();
        }
        break;
      }
    }
  }

  // Domain consistency rules: never silently corrupt civil identity dates
  if (canonical === "PatientAdministrative") {
    const dob = out.date_birth as string | null;
    const dRcp = out.date_rcp as string | null;
    if (dob && dRcp && dob > dRcp) {
      throw new Error("La date de naissance ne peut pas être postérieure à la date de la RCP.");
    }
  }

  // Preserve extra display keys on TumorBiology (e.g. ca19_9, kras_mutation in in-memory fake) if provided
  for (const [extraKey, extraVal] of Object.entries(rawBody)) {
    if (schemaKeys.has(extraKey)) continue;
    if (extraKey.startsWith("exam_") || extraKey.startsWith("chemotherapy_")) continue;
    if (isPlaceholderValue(extraVal)) {
      out[extraKey] = null;
    } else if (typeof extraVal === "string") {
      out[extraKey] = extraVal.trim();
    } else {
      out[extraKey] = extraVal;
    }
  }

  return out;
}

/**
 * Strips non-schema display keys so the JSON payload sent to FastAPI `model_validate`
 * contains only exact Pydantic fields for the target section.
 */
export function buildStrictBackendSectionPayload(
  sectionName: string,
  coercedPayload: Record<string, unknown>,
  domainSchema?: DomainFormSchema | null,
): Record<string, unknown> {
  const canonical = resolveCanonicalSectionName(sectionName);
  if (canonical === "CareOrientationProposal") {
    const matchedSection = domainSchema?.sections?.find(
      (s) => s.name === "CareOrientationProposal",
    );
    const props =
      matchedSection?.json_schema &&
      typeof matchedSection.json_schema.properties === "object" &&
      matchedSection.json_schema.properties !== null
        ? (matchedSection.json_schema.properties as Record<string, Record<string, unknown>>)
        : null;

    const prioRaw = String(coercedPayload.suggested_priority ?? "none");
    const prioLower = prioRaw.toLowerCase();
    let mappedPriority: string | null = prioRaw;
    if (props?.suggested_priority) {
      const propJson = JSON.stringify(props.suggested_priority);
      if (propJson.includes("High-priority pre-MDT review suggested")) {
        mappedPriority =
          prioLower === "high" ||
          prioLower === "urgent" ||
          prioLower.includes("high-priority") ||
          prioLower.includes("urgently")
            ? "High-priority pre-MDT review suggested"
            : prioLower === "medium" ||
                prioLower.includes("semi-urgent") ||
                prioLower.includes("soon as possible")
              ? "Semi-urgent pre-MDT review suggested"
              : prioLower === "low" || prioLower.includes("not urgent")
                ? "Patient is not urgent"
                : "no answer";
      } else if (propJson.includes("Patient must be treated urgently")) {
        mappedPriority =
          prioLower === "high" || prioLower === "urgent" || prioLower.includes("urgently")
            ? "Patient must be treated urgently"
            : prioLower === "medium" || prioLower.includes("soon as possible")
              ? "Patient must be treated as soon as possible"
              : prioLower === "low" || prioLower.includes("not urgent")
                ? "Patient is not urgent"
                : "no answer";
      }
    }

    const rationale =
      (coercedPayload.orientation_rationale as string | null | undefined) ??
      (coercedPayload.clinical_rationale as string | null | undefined) ??
      null;
    const priorityReason = (coercedPayload.priority_reason as string | null | undefined) ?? null;

    if (props && Object.keys(props).length > 0) {
      const strictOut: Record<string, unknown> = {};
      if ("care_adaptation_suggested" in props) {
        strictOut.care_adaptation_suggested = Boolean(coercedPayload.care_adaptation_suggested);
      }
      if ("suggested_priority" in props) {
        strictOut.suggested_priority = mappedPriority;
      }
      if ("priority_reason" in props) {
        strictOut.priority_reason = priorityReason;
      }
      if ("proposed_care_type" in props) {
        strictOut.proposed_care_type = coercedPayload.proposed_care_type ?? null;
      }
      if ("orientation_rationale" in props) {
        strictOut.orientation_rationale = rationale;
      }
      if ("clinical_rationale" in props) {
        strictOut.clinical_rationale = String(rationale ?? priorityReason ?? "");
      }
      return strictOut;
    }

    return {
      care_adaptation_suggested: Boolean(coercedPayload.care_adaptation_suggested),
      suggested_priority: mappedPriority,
      priority_reason: priorityReason,
      proposed_care_type: coercedPayload.proposed_care_type ?? null,
      orientation_rationale: rationale,
    };
  }

  if (canonical === "MTDCompleted") {
    return {
      mtd_complete: coercedPayload.mtd_complete,
    };
  }
  if (canonical === "ChemotherapyTreament") {
    return {
      chemotherapy: Boolean(coercedPayload.chemotherapy),
      chemotherapy_list: Array.isArray(coercedPayload.chemotherapy_list)
        ? coercedPayload.chemotherapy_list
        : [],
    };
  }
  if (canonical === "RadiologicExams") {
    return {
      exams_list: Array.isArray(coercedPayload.exams_list) ? coercedPayload.exams_list : [],
    };
  }
  const schemas = getSectionFieldSchemas(sectionName, domainSchema);
  if (schemas.length === 0) return coercedPayload;
  const out: Record<string, unknown> = {};
  for (const s of schemas) {
    out[s.key] = coercedPayload[s.key] ?? (s.nullable ? null : s.defaultValue);
  }
  return out;
}
