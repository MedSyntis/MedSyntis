import * as echarts from "echarts";
import { formatFieldLabel, getSectionPresentation } from "../../domain/catalog.js";
import { t, translateValue } from "../../domain/i18n.js";
import type {
  ClinicalDomain,
  Language,
  PatientDashboardView,
  PatientMetricPointView,
  PatientMetricSeriesView,
  PatientRecordSummaryView,
} from "../../domain/types.js";
import {
  esc,
  iconSvg,
  renderSafeInlineMarkdown,
  renderSafeMarkdown,
  stripMarkdown,
} from "../views/html.js";

function formatDateTimeDisplay(iso: string | null, lang: Language): string {
  if (!iso) return lang === "fr" ? "Non généré" : "Not generated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  return lang === "fr"
    ? `${day}/${month}/${year} à ${hours}h${mins}`
    : `${year}-${month}-${day} ${hours}:${mins}`;
}

function resolveClinicalMetricLabel(series: PatientMetricSeriesView, lang: Language): string {
  if (series.label && !series.label.includes(".")) {
    return series.label;
  }
  return formatFieldLabel(series.field, lang) || series.label;
}

function resolveTranslatedPointDisplay(
  pt: PatientMetricPointView,
  valueType: string,
  lang: Language,
): string {
  if (valueType === "numeric_or_mixed") {
    return pt.displayValue;
  }
  if (Array.isArray(pt.rawValue)) {
    const items = pt.rawValue
      .map((x) => translateValue(String(x ?? "").trim(), lang))
      .filter((x) => Boolean(x) && x !== "—");
    return items.length > 0 ? items.join(", ") : pt.displayValue;
  }
  if (pt.rawValue !== null && pt.rawValue !== undefined && String(pt.rawValue).trim() !== "") {
    return translateValue(pt.rawValue, lang);
  }
  return translateValue(pt.displayValue, lang);
}

const MFM_METRIC_KEYS = new Set<string>([
  "MotorFunctionStatus.mfm_total_score",
  "MotorFunctionStatus.mfm_d1_score",
  "MotorFunctionStatus.mfm_d2_score",
  "MotorFunctionStatus.mfm_d3_score",
]);

interface SeriesVisualConfig {
  color: string;
  symbol: "circle" | "diamond" | "rect" | "triangle";
  lineType: "solid" | "dashed" | "dotted";
  lineWidth: number;
  labelFr: string;
  labelEn: string;
  shortFr: string;
  shortEn: string;
}

const MFM_SERIES_VISUALS: Record<string, SeriesVisualConfig> = {
  "MotorFunctionStatus.mfm_total_score": {
    color: "#0f766e",
    symbol: "circle",
    lineType: "solid",
    lineWidth: 3,
    labelFr: "MFM Total (Score global)",
    labelEn: "MFM Total (Global score)",
    shortFr: "MFM Total",
    shortEn: "MFM Total",
  },
  "MotorFunctionStatus.mfm_d1_score": {
    color: "#0284c7",
    symbol: "diamond",
    lineType: "solid",
    lineWidth: 2.2,
    labelFr: "MFM D1 (Debout & transferts)",
    labelEn: "MFM D1 (Standing & transfers)",
    shortFr: "MFM D1",
    shortEn: "MFM D1",
  },
  "MotorFunctionStatus.mfm_d2_score": {
    color: "#7c3aed",
    symbol: "rect",
    lineType: "dashed",
    lineWidth: 2.2,
    labelFr: "MFM D2 (Motricité axiale & proximale)",
    labelEn: "MFM D2 (Axial & proximal motor)",
    shortFr: "MFM D2",
    shortEn: "MFM D2",
  },
  "MotorFunctionStatus.mfm_d3_score": {
    color: "#d97706",
    symbol: "triangle",
    lineType: "dotted",
    lineWidth: 2.2,
    labelFr: "MFM D3 (Motricité distale)",
    labelEn: "MFM D3 (Distal motor)",
    shortFr: "MFM D3",
    shortEn: "MFM D3",
  },
};

function resolveSeriesVisual(
  series: PatientMetricSeriesView,
  lang: Language,
  fallbackIndex = 0,
): {
  color: string;
  symbol: "circle" | "diamond" | "rect" | "triangle";
  lineType: "solid" | "dashed" | "dotted";
  lineWidth: number;
  label: string;
  shortLabel: string;
} {
  const mfmCfg = MFM_SERIES_VISUALS[series.metricKey];
  if (mfmCfg) {
    return {
      color: mfmCfg.color,
      symbol: mfmCfg.symbol,
      lineType: mfmCfg.lineType,
      lineWidth: mfmCfg.lineWidth,
      label: lang === "fr" ? mfmCfg.labelFr : mfmCfg.labelEn,
      shortLabel: lang === "fr" ? mfmCfg.shortFr : mfmCfg.shortEn,
    };
  }
  const palette: Array<{
    color: string;
    symbol: "circle" | "diamond" | "rect" | "triangle";
    lineType: "solid" | "dashed" | "dotted";
  }> = [
    { color: "#0f766e", symbol: "circle", lineType: "solid" },
    { color: "#0284c7", symbol: "diamond", lineType: "solid" },
    { color: "#7c3aed", symbol: "rect", lineType: "dashed" },
    { color: "#d97706", symbol: "triangle", lineType: "dotted" },
  ];
  const pick = palette[fallbackIndex % palette.length] ?? {
    color: "#0f766e",
    symbol: "circle" as const,
    lineType: "solid" as const,
  };
  const resolvedLabel = resolveClinicalMetricLabel(series, lang);
  return {
    color: pick.color,
    symbol: pick.symbol,
    lineType: pick.lineType,
    lineWidth: fallbackIndex === 0 ? 3 : 2.2,
    label: resolvedLabel,
    shortLabel: resolvedLabel,
  };
}

function formatExactPointValueWithUnit(rawDisplay: string, unit: string): string {
  const clean = stripMarkdown(rawDisplay).trim();
  if (!unit) return clean;
  const compactUnit = unit.replace(/\s+/g, "");
  if (clean.replace(/\s+/g, "").endsWith(compactUnit)) {
    return clean;
  }
  return `${clean} ${unit}`;
}

interface HitTargetMeta {
  seriesIndex: number;
  xIndex: number;
  numericValue: number;
  seriesKey: string;
  seriesLabel: string;
  seriesColor: string;
  dateLabel: string;
  exactValue: string;
  deltaDisplay: string;
  isManual: boolean;
  formId: string;
  sectionName: string;
}

/**
 * Render an Apache ECharts multi-series or single-series raw clinical line chart to an SSR SVG string,
 * enriched with interactive SVG point hit targets (`data-chart-point="true"`) for exact hover tooltips.
 */
export function renderMultiMetricSeriesEChartsSvg(
  seriesList: PatientMetricSeriesView[],
  lang: Language,
): string {
  if (seriesList.length === 0) return "";
  const isMultiSeries = seriesList.length > 1;
  const width = 680;
  const height = isMultiSeries ? 236 : 210;
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width,
    height,
  });

  try {
    // Build unified chronological session list across all provided series
    const sessionMap = new Map<
      string,
      { formId: string; formDateLabel: string; daysSinceFirstRcp: number }
    >();
    for (const s of seriesList) {
      for (const pt of s.points) {
        if (!sessionMap.has(pt.formId)) {
          sessionMap.set(pt.formId, {
            formId: pt.formId,
            formDateLabel: pt.formDateLabel,
            daysSinceFirstRcp: pt.daysSinceFirstRcp,
          });
        }
      }
    }
    const sessions = Array.from(sessionMap.values());

    const xLabels = sessions.map((sess, idx) => {
      const base =
        sess.formDateLabel || (lang === "fr" ? `Séance #${idx + 1}` : `Session #${idx + 1}`);
      return sessions.length > 1 && sess.daysSinceFirstRcp > 0
        ? `${base}\n(J+${sess.daysSinceFirstRcp})`
        : idx === 0 && sessions.length > 1
          ? `${base}\n(J0)`
          : base;
    });

    const echartsSeries: Record<string, unknown>[] = [];
    const hitTargets: HitTargetMeta[] = [];

    seriesList.forEach((series, sIdx) => {
      const vis = resolveSeriesVisual(series, lang, sIdx);
      const ptsByForm = new Map(series.points.map((pt) => [pt.formId, pt]));
      const seriesIndex = echartsSeries.length;

      const dataPoints = sessions.map((sess, xIdx) => {
        const pt = ptsByForm.get(sess.formId);
        if (!pt || typeof pt.numericValue !== "number") {
          return { value: null };
        }
        const exactVal = formatExactPointValueWithUnit(pt.displayValue, series.unit);
        const deltaStr = pt.deltaDisplay
          ? `${pt.deltaDisplay}${series.unit && !pt.deltaDisplay.includes(series.unit) ? ` ${series.unit}` : ""}`
          : "";
        hitTargets.push({
          seriesIndex,
          xIndex: xIdx,
          numericValue: pt.numericValue,
          seriesKey: series.metricKey,
          seriesLabel: vis.label,
          seriesColor: pt.isManual ? "#b45309" : vis.color,
          dateLabel: pt.formDateLabel || sess.formDateLabel,
          exactValue: exactVal,
          deltaDisplay: deltaStr,
          isManual: pt.isManual,
          formId: pt.formId,
          sectionName: series.section,
        });

        return {
          value: pt.numericValue,
          rawDisplay: exactVal,
          shortSeriesLabel: vis.shortLabel,
          formId: pt.formId,
          isManual: pt.isManual,
          isAnnotativeOnly: pt.isAnnotativeOnly,
          itemStyle: {
            color: pt.isManual ? "#b45309" : vis.color,
            borderColor: "#ffffff",
            borderWidth: 2,
          },
        };
      });

      echartsSeries.push({
        name: vis.label,
        type: "line",
        smooth: false,
        connectNulls: true,
        symbol: vis.symbol,
        symbolSize: isMultiSeries ? (sIdx === 0 ? 10 : 8) : 9,
        lineStyle: {
          width: vis.lineWidth,
          type: vis.lineType,
          color: vis.color,
        },
        label: {
          show: !isMultiSeries || sIdx === 0,
          position: "top",
          distance: 6,
          color: "#0f172a",
          fontSize: 11,
          fontWeight: "bold",
          formatter: (params: { data?: { rawDisplay?: string } }) =>
            stripMarkdown(params?.data?.rawDisplay ?? ""),
        },
        data: dataPoints,
      });

      // Bilateral D/G sub-curves for single-metric charts (e.g., upper limb strength)
      if (!isMultiSeries) {
        const hasBilateralD = series.points.some(
          (pt) => pt.subValues && typeof pt.subValues.D === "number",
        );
        const hasBilateralG = series.points.some(
          (pt) => pt.subValues && typeof pt.subValues.G === "number",
        );
        if (hasBilateralD && hasBilateralG) {
          const rightLabel =
            lang === "fr" ? `${vis.label} — Droite (D)` : `${vis.label} — Right (D)`;
          const leftLabel = lang === "fr" ? `${vis.label} — Gauche (G)` : `${vis.label} — Left (G)`;
          const dSeriesIndex = echartsSeries.length;
          echartsSeries.push({
            name: lang === "fr" ? "Droite (D)" : "Right (D)",
            type: "line",
            smooth: false,
            symbol: "diamond",
            symbolSize: 7,
            lineStyle: { width: 1.5, type: "dashed", color: "#0284c7" },
            itemStyle: { color: "#0284c7" },
            data: sessions.map((sess, xIdx) => {
              const pt = ptsByForm.get(sess.formId);
              const valD = pt?.subValues?.D;
              if (pt && typeof valD === "number") {
                hitTargets.push({
                  seriesIndex: dSeriesIndex,
                  xIndex: xIdx,
                  numericValue: valD,
                  seriesKey: `${series.metricKey}:D`,
                  seriesLabel: rightLabel,
                  seriesColor: "#0284c7",
                  dateLabel: pt.formDateLabel || sess.formDateLabel,
                  exactValue: formatExactPointValueWithUnit(String(valD), series.unit),
                  deltaDisplay: "",
                  isManual: pt.isManual,
                  formId: pt.formId,
                  sectionName: series.section,
                });
                return valD;
              }
              return null;
            }),
          });

          const gSeriesIndex = echartsSeries.length;
          echartsSeries.push({
            name: lang === "fr" ? "Gauche (G)" : "Left (G)",
            type: "line",
            smooth: false,
            symbol: "triangle",
            symbolSize: 7,
            lineStyle: { width: 1.5, type: "dotted", color: "#7c3aed" },
            itemStyle: { color: "#7c3aed" },
            data: sessions.map((sess, xIdx) => {
              const pt = ptsByForm.get(sess.formId);
              const valG = pt?.subValues?.G;
              if (pt && typeof valG === "number") {
                hitTargets.push({
                  seriesIndex: gSeriesIndex,
                  xIndex: xIdx,
                  numericValue: valG,
                  seriesKey: `${series.metricKey}:G`,
                  seriesLabel: leftLabel,
                  seriesColor: "#7c3aed",
                  dateLabel: pt.formDateLabel || sess.formDateLabel,
                  exactValue: formatExactPointValueWithUnit(String(valG), series.unit),
                  deltaDisplay: "",
                  isManual: pt.isManual,
                  formId: pt.formId,
                  sectionName: series.section,
                });
                return valG;
              }
              return null;
            }),
          });
        }
      }
    });

    const scaleMins = seriesList
      .map((s) => s.scaleMin)
      .filter((v): v is number => typeof v === "number");
    const scaleMaxs = seriesList
      .map((s) => s.scaleMax)
      .filter((v): v is number => typeof v === "number");

    chart.setOption({
      animation: false,
      grid: {
        left: 48,
        right: 28,
        top: 34,
        bottom: 42,
      },
      xAxis: {
        type: "category",
        boundaryGap: true,
        data: xLabels,
        axisLine: { lineStyle: { color: "#94a3b8" } },
        axisLabel: {
          color: "#334155",
          fontSize: 11,
          interval: 0,
        },
      },
      yAxis: {
        type: "value",
        min: scaleMins.length > 0 ? Math.min(...scaleMins) : undefined,
        max: scaleMaxs.length > 0 ? Math.max(...scaleMaxs) : undefined,
        splitLine: { lineStyle: { type: "dashed", color: "#e2e8f0" } },
        axisLabel: {
          color: "#475569",
          fontSize: 11,
        },
      },
      series: echartsSeries,
    });

    const rawSvg = chart.renderToSVGString();

    // Compute exact pixel coordinates for interactive hover hit targets
    const interactiveCirclesHtml = hitTargets
      .map((target) => {
        const px = chart.convertToPixel({ seriesIndex: target.seriesIndex }, [
          target.xIndex,
          target.numericValue,
        ]);
        if (!Array.isArray(px) || px.length < 2) return "";
        const cx = Number(px[0]);
        const cy = Number(px[1]);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return "";
        const summaryTitle = `${target.seriesLabel} — ${target.dateLabel} : ${target.exactValue}${
          target.deltaDisplay ? ` (Δ ${target.deltaDisplay})` : ""
        }`;
        return `<circle class="ds-chart-point" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" tabindex="0" role="button" aria-label="${esc(summaryTitle)}" data-chart-point="true" data-series-key="${esc(target.seriesKey)}" data-series-label="${esc(target.seriesLabel)}" data-series-color="${esc(target.seriesColor)}" data-point-date="${esc(target.dateLabel)}" data-point-value="${esc(target.exactValue)}" data-point-delta="${esc(target.deltaDisplay)}" data-point-manual="${target.isManual ? "true" : "false"}" data-form-id="${esc(target.formId)}" data-jump-section="${esc(target.sectionName)}" data-jump-tab="clinical" style="--chart-point-color:${esc(target.seriesColor)}"><title>${esc(summaryTitle)}</title></circle>`;
      })
      .filter(Boolean)
      .join("");

    if (!interactiveCirclesHtml) {
      return rawSvg;
    }

    return rawSvg.replace(
      "</svg>",
      `<g class="ds-chart-hit-layer" data-testid="chart_hit_layer">${interactiveCirclesHtml}</g></svg>`,
    );
  } finally {
    chart.dispose();
  }
}

/**
 * Render an Apache ECharts multi-year raw clinical line chart to an SSR SVG string.
 */
export function renderMetricSeriesEChartsSvg(
  series: PatientMetricSeriesView,
  lang: Language,
): string {
  return renderMultiMetricSeriesEChartsSvg([series], lang);
}

function renderSummaryCard(
  dashboard: PatientDashboardView,
  summary: PatientRecordSummaryView,
  lang: Language,
): string {
  const activeJob = summary.activeJob;
  const isQueuedOrRunning = Boolean(
    activeJob &&
      (activeJob.status === "PENDING" ||
        activeJob.status === "PROCESSING" ||
        activeJob.status === "RUNNING"),
  );

  const actionUrl = `/patients/${encodeURIComponent(dashboard.patientId)}/summary?domain=${encodeURIComponent(dashboard.domain)}`;

  let statusBadgeHtml = "";
  if (isQueuedOrRunning) {
    statusBadgeHtml = `<span class="ds-badge ds-badge--processing ds-badge--sm" data-testid="badge_summary_queued"><span class="ds-spinner" aria-hidden="true"></span> ${
      lang === "fr" ? "En file d'attente IA" : "Queued in AI Worker"
    }</span>`;
  } else if (!summary.hasSummary) {
    statusBadgeHtml = `<span class="ds-badge ds-badge--neutral ds-badge--sm" data-testid="badge_summary_empty">${iconSvg("ic-clock")} ${
      lang === "fr" ? "Non généré (à la demande)" : "Not generated (on-demand)"
    }</span>`;
  } else if (summary.isObsolete) {
    statusBadgeHtml = `<span class="ds-badge ds-badge--incomplete ds-badge--sm" data-testid="badge_summary_obsolete">${iconSvg("ic-warning")} ${
      lang === "fr" ? "Obsolète" : "Obsolete"
    }</span>`;
  } else {
    statusBadgeHtml = `<span class="ds-badge ds-badge--complete ds-badge--sm" data-testid="badge_summary_up_to_date">${iconSvg("ic-check-circle")} ${
      lang === "fr" ? "À jour" : "Up to date"
    }</span>`;
  }

  const buttonIcon = isQueuedOrRunning
    ? '<span class="ds-spinner" aria-hidden="true"></span>'
    : summary.hasSummary
      ? iconSvg("ic-refresh")
      : iconSvg("ic-sparkle");

  const buttonText = isQueuedOrRunning
    ? lang === "fr"
      ? "Génération en cours dans la file IA…"
      : "Generating in AI queue…"
    : summary.hasSummary
      ? lang === "fr"
        ? "Régénérer le résumé global"
        : "Regenerate global summary"
      : lang === "fr"
        ? "Générer le résumé global du dossier"
        : "Generate global record summary";

  const obsoleteAlertHtml =
    summary.hasSummary && summary.isObsolete
      ? `<div class="ds-alert ds-alert--warning" role="status" data-testid="alert_summary_obsolete">
          <span class="ds-alert__icon" aria-hidden="true">${iconSvg("ic-warning")}</span>
          <div class="ds-alert__content">
            <span class="ds-alert__title">${
              lang === "fr"
                ? "Résumé global obsolète — Nouvelles données détectées dans le dossier"
                : "Global summary is obsolete — Newer record data detected"
            }</span>
            <span>${
              summary.newFormsSinceSummary.length > 0
                ? lang === "fr"
                  ? `${summary.newFormsSinceSummary.length} nouvelle(s) séance(s) RCP présente(s) depuis la génération du ${esc(formatDateTimeDisplay(summary.generatedAt, lang))} (${summary.newFormsSinceSummary.map(esc).join(", ")}).`
                  : `${summary.newFormsSinceSummary.length} new MDT session(s) added since ${esc(formatDateTimeDisplay(summary.generatedAt, lang))} (${summary.newFormsSinceSummary.map(esc).join(", ")}).`
                : lang === "fr"
                  ? `Une ou plusieurs séances RCP ont été modifiées depuis la génération du ${esc(formatDateTimeDisplay(summary.generatedAt, lang))}.`
                  : `One or more MDT sessions were updated since ${esc(formatDateTimeDisplay(summary.generatedAt, lang))}.`
            }</span>
          </div>
        </div>`
      : "";

  const queuedBannerHtml = isQueuedOrRunning
    ? `<div class="ds-processing-banner" role="status" aria-live="polite" data-testid="alert_summary_queued">
        <div class="ds-processing-banner__main">
          <span class="ds-spinner" aria-hidden="true"></span>
          <div class="ds-processing-banner__content">
            <strong class="ds-processing-banner__title">${
              lang === "fr"
                ? "Tâche enregistrée dans la file prioritaire IA (PriorityQueue)"
                : "Task queued in AI PriorityQueue"
            }</strong>
            <span class="ds-processing-banner__meta">${esc(
              activeJob?.current_step ??
                (lang === "fr"
                  ? "Consolidation longitudinale en attente d'un worker IA"
                  : "Longitudinal synthesis waiting for AI worker"),
            )}</span>
          </div>
        </div>
      </div>`
    : "";

  const generatedMetaHtml = summary.hasSummary
    ? `<div class="ds-cluster" data-testid="summary_generated_meta">
        <span class="ds-badge ds-badge--neutral ds-badge--sm">${iconSvg("ic-clock")} ${
          lang === "fr" ? "Généré le" : "Generated on"
        } ${esc(formatDateTimeDisplay(summary.generatedAt, lang))}</span>
        <span class="ds-badge ds-badge--neutral ds-badge--sm">${iconSvg("ic-layers")} ${
          lang === "fr" ? "Séances consolidées" : "Consolidated sessions"
        } : ${summary.coveredFormIds.length} / ${dashboard.rcpCount}</span>
      </div>`
    : `<div class="ds-alert ds-alert--guidance" role="note">
        <span class="ds-alert__icon" aria-hidden="true">${iconSvg("ic-sparkle")}</span>
        <div class="ds-alert__content">
          <span class="ds-alert__title">${
            lang === "fr"
              ? "Synthèse longitudinale à la demande"
              : "On-demand longitudinal synthesis"
          }</span>
          <span>${
            lang === "fr"
              ? `Consolide l'ensemble des ${dashboard.rcpCount} séance(s) RCP du patient via la file IA (PriorityQueue).`
              : `Consolidates all ${dashboard.rcpCount} MDT session(s) for this patient via the AI PriorityQueue.`
          }</span>
        </div>
      </div>`;

  const content = summary.content;
  const contentHtml = content
    ? `<div class="ds-stack" data-testid="summary_content_body">
        <div class="ds-rationale ds-rationale--orientation">
          <span class="ds-rationale__label">${iconSvg("ic-compass", "ds-icon--xs")} ${
            lang === "fr" ? "Trajectoire clinique globale" : "Global clinical trajectory"
          }</span>
          <div class="ds-rationale__text ds-dashboard-summary__text ds-markdown">${renderSafeMarkdown(content.clinicalTrajectoryOverview)}</div>
        </div>
        <div class="ds-rationale">
          <span class="ds-rationale__label">${iconSvg("ic-stethoscope", "ds-icon--xs")} ${
            lang === "fr"
              ? "Évolution de la maladie & des traitements"
              : "Disease & treatment evolution"
          }</span>
          <div class="ds-rationale__text ds-dashboard-summary__text ds-markdown">${renderSafeMarkdown(content.diseaseAndTreatmentEvolution)}</div>
        </div>
        <div class="ds-grid">
          ${
            content.notableMetricChanges.length > 0
              ? `<div class="ds-subcard">
                  <div class="ds-subcard__header">
                    <span class="ds-subcard__title">${iconSvg("ic-trend-up", "ds-icon--xs")} ${
                      lang === "fr"
                        ? "Variations notables des métriques brutes"
                        : "Notable raw metric variations"
                    }</span>
                  </div>
                  <ul class="ds-hovercard__list">
                    ${content.notableMetricChanges.map((item) => `<li class="ds-dashboard-summary__list-item ds-markdown-inline">${renderSafeInlineMarkdown(item)}</li>`).join("")}
                  </ul>
                </div>`
              : ""
          }
          ${
            content.mdtDecisionsRecap.length > 0
              ? `<div class="ds-subcard">
                  <div class="ds-subcard__header">
                    <span class="ds-subcard__title">${iconSvg("ic-calendar", "ds-icon--xs")} ${
                      lang === "fr" ? "Historique des propositions RCP" : "MDT orientation history"
                    }</span>
                  </div>
                  <ul class="ds-hovercard__list">
                    ${content.mdtDecisionsRecap.map((item) => `<li class="ds-dashboard-summary__list-item ds-markdown-inline">${renderSafeInlineMarkdown(item)}</li>`).join("")}
                  </ul>
                </div>`
              : ""
          }
          ${
            content.unresolvedVigilancePoints.length > 0
              ? `<div class="ds-subcard">
                  <div class="ds-subcard__header">
                    <span class="ds-subcard__title">${iconSvg("ic-warning", "ds-icon--xs")} ${
                      lang === "fr"
                        ? "Points de vigilance & éléments manquants"
                        : "Vigilance points & missing items"
                    }</span>
                  </div>
                  <ul class="ds-hovercard__list">
                    ${content.unresolvedVigilancePoints.map((item) => `<li class="ds-dashboard-summary__list-item ds-markdown-inline">${renderSafeInlineMarkdown(item)}</li>`).join("")}
                  </ul>
                </div>`
              : ""
          }
        </div>
        <p class="ds-disclaimer">${esc(t("disclaimer.ml", lang))}</p>
      </div>`
    : "";

  return `<section class="ds-card" id="patient-summary-card" data-testid="patient_summary_card">
    <div class="ds-card__header">
      <div class="ds-cluster">
        <h3 class="ds-card__title">
          <span class="ds-icon-box">${iconSvg("ic-sparkle")}</span>
          ${lang === "fr" ? "Résumé global du dossier patient" : "Global Patient Record Summary"}
        </h3>
        ${statusBadgeHtml}
      </div>
      <div class="ds-card__header-actions">
        <form method="POST" action="${actionUrl}" style="display:inline-flex;margin:0">
          <input type="hidden" name="force" value="true" />
          <button
            type="submit"
            class="ds-btn ${summary.isObsolete || !summary.hasSummary ? "ds-btn--primary" : "ds-btn--tonal"} ds-btn--sm"
            data-testid="btn_generate_patient_summary"
            ${isQueuedOrRunning ? "disabled" : ""}
          >
            ${buttonIcon}
            <span>${buttonText}</span>
          </button>
        </form>
      </div>
    </div>
    <div class="ds-card__body ds-stack">
      ${generatedMetaHtml}
      ${obsoleteAlertHtml}
      ${queuedBannerHtml}
      ${contentHtml}
    </div>
  </section>`;
}

function renderPointPills(
  points: PatientMetricPointView[],
  unit: string,
  sectionName: string,
  lang: Language,
): string {
  return `<div class="ds-metric-points-strip" role="list" aria-label="${
    lang === "fr" ? "Valeurs brutes par séance RCP" : "Raw values per MDT session"
  }">
    ${points
      .map((pt) => {
        const unitStr =
          unit && !pt.displayValue.includes(unit.replace(/\s+/g, "")) ? ` ${unit}` : "";
        const manualBadge = pt.isManual
          ? `<span class="ds-badge ds-badge--manual ds-badge--sm" data-tooltip="${
              lang === "fr" ? "Valeur corrigée manuellement" : "Manually edited value"
            }">${iconSvg("ic-edit-note", "ds-icon--xs")}</span>`
          : "";
        const deltaBadge = pt.deltaDisplay
          ? `<span class="ds-raw-pill__delta">Δ ${esc(pt.deltaDisplay)}</span>`
          : "";
        const annotBadge = pt.isAnnotativeOnly
          ? `<span class="ds-badge ds-badge--incomplete ds-badge--sm" data-tooltip="${
              lang === "fr" ? "Observation qualitative brute" : "Raw qualitative note"
            }">${iconSvg("ic-info", "ds-icon--xs")}</span>`
          : "";
        return `<div class="ds-raw-pill ${pt.isAnnotativeOnly ? "ds-raw-pill--annotative" : ""}" role="listitem" data-form-id="${esc(pt.formId)}" data-jump-section="${esc(sectionName)}" data-jump-tab="clinical" tabindex="0" data-tooltip="${esc(stripMarkdown(pt.displayValue))}${esc(unitStr)}">
          <span class="ds-raw-pill__date">${esc(pt.formDateLabel)}</span>
          <strong class="ds-raw-pill__val ds-metric-pill__value ds-markdown-inline">${renderSafeInlineMarkdown(pt.displayValue)}${esc(unitStr)}</strong>
          ${manualBadge}${annotBadge}${deltaBadge}
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderNumericChartCard(
  series: PatientMetricSeriesView,
  domain: ClinicalDomain,
  lang: Language,
): string {
  const svgMarkup = renderMetricSeriesEChartsSvg(series, lang);
  const secMeta = getSectionPresentation(series.section, domain, lang);
  const clinicalLabel = resolveClinicalMetricLabel(series, lang);
  const lastPt = series.points[series.points.length - 1];
  const firstPt = series.points[0];
  const spanYears =
    firstPt && lastPt && lastPt.daysSinceFirstRcp >= 365
      ? `${(lastPt.daysSinceFirstRcp / 365.25).toFixed(1)} ${lang === "fr" ? "ans" : "yrs"}`
      : firstPt && lastPt && lastPt.daysSinceFirstRcp > 0
        ? `${lastPt.daysSinceFirstRcp} ${lang === "fr" ? "jours" : "days"}`
        : lang === "fr"
          ? "1 séance"
          : "1 session";

  const hasBilateralD = series.points.some(
    (pt) => pt.subValues && typeof pt.subValues.D === "number",
  );
  const hasBilateralG = series.points.some(
    (pt) => pt.subValues && typeof pt.subValues.G === "number",
  );
  const bilateralLegendHtml =
    hasBilateralD && hasBilateralG
      ? `<div class="ds-chart-legend" role="list" aria-label="${lang === "fr" ? "Légende des courbes" : "Chart curves legend"}">
          <div class="ds-chart-legend__item" role="listitem" data-legend-series-key="${esc(series.metricKey)}" tabindex="0">
            <span class="ds-chart-legend__swatch ds-chart-legend__swatch--solid" style="--legend-color:#0f766e" aria-hidden="true"></span>
            <span class="ds-chart-legend__label">${esc(clinicalLabel)}</span>
          </div>
          <div class="ds-chart-legend__item" role="listitem" data-legend-series-key="${esc(series.metricKey)}:D" tabindex="0">
            <span class="ds-chart-legend__swatch ds-chart-legend__swatch--dashed" style="--legend-color:#0284c7" aria-hidden="true"></span>
            <span class="ds-chart-legend__label">${lang === "fr" ? "Droite (D)" : "Right (D)"}</span>
          </div>
          <div class="ds-chart-legend__item" role="listitem" data-legend-series-key="${esc(series.metricKey)}:G" tabindex="0">
            <span class="ds-chart-legend__swatch ds-chart-legend__swatch--dotted" style="--legend-color:#7c3aed" aria-hidden="true"></span>
            <span class="ds-chart-legend__label">${lang === "fr" ? "Gauche (G)" : "Left (G)"}</span>
          </div>
        </div>`
      : "";

  return `<article class="ds-card ds-metric-chart-card" data-testid="metric_chart_${esc(series.metricKey)}" data-metric-key="${esc(series.metricKey)}" data-section="${esc(series.section)}">
    <div class="ds-card__header" data-jump-section="${esc(series.section)}" data-jump-tab="clinical" tabindex="0">
      <div>
        <h4 class="ds-card__title">
          <span class="ds-icon-box">${iconSvg(secMeta.icon)}</span>
          ${esc(clinicalLabel)}
        </h4>
        <span class="ds-card__subtitle">
          ${esc(secMeta.title)} · ${lang === "fr" ? "Données brutes" : "Raw data"}${series.unit ? ` (${esc(series.unit)})` : ""} · ${series.points.length} ${lang === "fr" ? "séance(s)" : "session(s)"} (${esc(spanYears)})
        </span>
      </div>
      ${
        lastPt
          ? `<div class="ds-card__header-actions">
              <span class="ds-badge ds-badge--specialty ds-badge--sm ds-badge--interactive" data-jump-section="${esc(series.section)}" data-jump-tab="clinical" data-tooltip="${lang === "fr" ? "Dernier relevé" : "Latest"} (${esc(lastPt.formDateLabel)})">
                ${iconSvg("ic-trend-up")} ${esc(stripMarkdown(lastPt.displayValue))}${series.unit ? ` ${esc(series.unit)}` : ""} · ${esc(lastPt.formDateLabel)}
              </span>
            </div>`
          : ""
      }
    </div>
    <div class="ds-card__body ds-stack">
      ${bilateralLegendHtml}
      <div class="ds-metric-chart-card__canvas" data-chart-canvas role="img" aria-label="${esc(clinicalLabel)}">
        ${svgMarkup}
        <div class="ds-chart-tooltip" data-chart-tooltip data-testid="chart_point_tooltip" hidden aria-hidden="true"></div>
      </div>
      ${renderPointPills(series.points, series.unit, series.section, lang)}
    </div>
  </article>`;
}

function renderMfmCombinedChartCard(
  mfmSeriesList: PatientMetricSeriesView[],
  domain: ClinicalDomain,
  lang: Language,
): string {
  const primarySeries =
    mfmSeriesList.find((s) => s.metricKey === "MotorFunctionStatus.mfm_total_score") ??
    mfmSeriesList[0];
  if (!primarySeries) return "";

  const svgMarkup = renderMultiMetricSeriesEChartsSvg(mfmSeriesList, lang);
  const secMeta = getSectionPresentation(primarySeries.section, domain, lang);
  const cardTitle =
    lang === "fr"
      ? "Mesure de la Fonction Motrice (MFM — Total & Dimensions D1, D2, D3)"
      : "Motor Function Measure (MFM — Total & Dimensions D1, D2, D3)";

  // Compute session count and time span across all MFM series
  const allPoints = mfmSeriesList.flatMap((s) => s.points);
  const uniqueForms = new Set(allPoints.map((p) => p.formId));
  const maxDays = allPoints.reduce((acc, p) => Math.max(acc, p.daysSinceFirstRcp), 0);
  const spanYears =
    maxDays >= 365
      ? `${(maxDays / 365.25).toFixed(1)} ${lang === "fr" ? "ans" : "yrs"}`
      : maxDays > 0
        ? `${maxDays} ${lang === "fr" ? "jours" : "days"}`
        : lang === "fr"
          ? "1 séance"
          : "1 session";

  const lastPrimaryPt = primarySeries.points[primarySeries.points.length - 1];
  const primaryVis = resolveSeriesVisual(primarySeries, lang, 0);

  const legendHtml = `<div class="ds-chart-legend" role="list" data-testid="mfm_chart_legend" aria-label="${
    lang === "fr" ? "Légende des courbes MFM" : "MFM curves legend"
  }">
    ${mfmSeriesList
      .map((s, idx) => {
        const vis = resolveSeriesVisual(s, lang, idx);
        const latestPt = s.points[s.points.length - 1];
        const latestVal = latestPt
          ? formatExactPointValueWithUnit(latestPt.displayValue, s.unit)
          : "";
        const deltaBadge = latestPt?.deltaDisplay
          ? `<span class="ds-chart-legend__delta">Δ ${esc(latestPt.deltaDisplay)}${s.unit && !latestPt.deltaDisplay.includes(s.unit) ? ` ${esc(s.unit)}` : ""}</span>`
          : "";
        return `<div class="ds-chart-legend__item" role="listitem" data-testid="mfm_legend_item_${esc(s.metricKey)}" data-legend-series-key="${esc(s.metricKey)}" tabindex="0" style="--legend-color:${esc(vis.color)}">
          <span class="ds-chart-legend__swatch ds-chart-legend__swatch--${esc(vis.lineType)}" style="--legend-color:${esc(vis.color)}" aria-hidden="true"></span>
          <span class="ds-chart-legend__label">${esc(vis.label)}</span>
          ${latestVal ? `<strong class="ds-chart-legend__value">${esc(latestVal)}</strong>` : ""}
          ${deltaBadge}
        </div>`;
      })
      .join("")}
  </div>`;

  const combinedPillsHtml = `<div class="ds-metric-points-strip" role="list" aria-label="${
    lang === "fr" ? "Valeurs MFM brutes par séance RCP" : "Raw MFM values per MDT session"
  }">
    ${mfmSeriesList
      .flatMap((s, idx) => {
        const vis = resolveSeriesVisual(s, lang, idx);
        return s.points.map((pt) => {
          const exactVal = formatExactPointValueWithUnit(pt.displayValue, s.unit);
          const manualBadge = pt.isManual
            ? `<span class="ds-badge ds-badge--manual ds-badge--sm" data-tooltip="${
                lang === "fr" ? "Valeur corrigée manuellement" : "Manually edited value"
              }">${iconSvg("ic-edit-note", "ds-icon--xs")}</span>`
            : "";
          const deltaBadge = pt.deltaDisplay
            ? `<span class="ds-raw-pill__delta">Δ ${esc(pt.deltaDisplay)}</span>`
            : "";
          return `<div class="ds-raw-pill" role="listitem" data-form-id="${esc(pt.formId)}" data-series-key="${esc(s.metricKey)}" data-jump-section="${esc(s.section)}" data-jump-tab="clinical" tabindex="0" data-tooltip="${esc(vis.label)} — ${esc(pt.formDateLabel)} : ${esc(exactVal)}">
            <span class="ds-chart-legend__dot" style="--legend-color:${esc(vis.color)}" aria-hidden="true"></span>
            <span class="ds-raw-pill__series">${esc(vis.shortLabel)}</span>
            <span class="ds-raw-pill__date">${esc(pt.formDateLabel)}</span>
            <strong class="ds-raw-pill__val ds-metric-pill__value ds-markdown-inline">${esc(exactVal)}</strong>
            ${manualBadge}${deltaBadge}
          </div>`;
        });
      })
      .join("")}
  </div>`;

  return `<article class="ds-card ds-metric-chart-card ds-metric-chart-card--mfm-combined" data-testid="metric_chart_${esc(primarySeries.metricKey)}" data-mfm-combined="true" data-metric-key="${esc(primarySeries.metricKey)}" data-metric-keys="${esc(mfmSeriesList.map((s) => s.metricKey).join(","))}" data-section="${esc(primarySeries.section)}">
    <div class="ds-card__header" data-jump-section="${esc(primarySeries.section)}" data-jump-tab="clinical" tabindex="0">
      <div>
        <h4 class="ds-card__title">
          <span class="ds-icon-box">${iconSvg(secMeta.icon)}</span>
          ${esc(cardTitle)}
        </h4>
        <span class="ds-card__subtitle">
          ${esc(secMeta.title)} · ${lang === "fr" ? "Données brutes" : "Raw data"} (%) · ${mfmSeriesList.length} ${lang === "fr" ? "courbe(s)" : "curve(s)"} · ${uniqueForms.size} ${lang === "fr" ? "séance(s)" : "session(s)"} (${esc(spanYears)})
        </span>
      </div>
      ${
        lastPrimaryPt
          ? `<div class="ds-card__header-actions">
              <span class="ds-badge ds-badge--specialty ds-badge--sm ds-badge--interactive" data-jump-section="${esc(primarySeries.section)}" data-jump-tab="clinical" data-tooltip="${esc(primaryVis.shortLabel)} — ${lang === "fr" ? "Dernier relevé" : "Latest"} (${esc(lastPrimaryPt.formDateLabel)})">
                ${iconSvg("ic-trend-up")} ${esc(primaryVis.shortLabel)} : ${esc(formatExactPointValueWithUnit(lastPrimaryPt.displayValue, primarySeries.unit))} · ${esc(lastPrimaryPt.formDateLabel)}
              </span>
            </div>`
          : ""
      }
    </div>
    <div class="ds-card__body ds-stack">
      ${legendHtml}
      <div class="ds-metric-chart-card__canvas" data-chart-canvas role="img" aria-label="${esc(cardTitle)}">
        ${svgMarkup}
        <div class="ds-chart-tooltip" data-chart-tooltip data-testid="chart_point_tooltip" hidden aria-hidden="true"></div>
      </div>
      ${combinedPillsHtml}
    </div>
  </article>`;
}

function renderQualitativeSwimlanes(
  qualitativeSeries: PatientMetricSeriesView[],
  domain: ClinicalDomain,
  lang: Language,
): string {
  if (qualitativeSeries.length === 0) return "";
  return `<section class="ds-card" data-testid="qualitative_metrics_swimlanes">
    <div class="ds-card__header">
      <div>
        <h3 class="ds-card__title">
          <span class="ds-icon-box">${iconSvg("ic-compass")}</span>
          ${
            lang === "fr"
              ? "Évolution des statuts cliniques, stades & jalons fonctionnels"
              : "Clinical Statuses, Staging & Functional Milestones Evolution"
          }
        </h3>
        <p class="ds-card__subtitle">
          ${
            lang === "fr"
              ? "Suivi chronologique des paramètres non numériques (stades TNM, jalons moteurs, mode ventilatoire ou nutritionnel, lignes thérapeutiques) relevés à chaque séance RCP."
              : "Chronological tracking of non-numeric parameters (TNM staging, motor milestones, ventilation or feeding support, treatment lines) across MDT sessions."
          }
        </p>
      </div>
    </div>
    <div class="ds-card__body ds-stack--sm">
      ${qualitativeSeries
        .map((s) => {
          const secMeta = getSectionPresentation(s.section, domain, lang);
          const clinicalLabel = resolveClinicalMetricLabel(s, lang);
          return `<div class="ds-subcard ds-swimlane-row" data-testid="swimlane_${esc(s.metricKey)}" data-jump-section="${esc(s.section)}" data-jump-tab="clinical" tabindex="0">
            <div class="ds-swimlane-row__label">
              <span class="ds-subcard__title">${iconSvg(secMeta.icon, "ds-icon--xs")} ${esc(clinicalLabel)}</span>
              <span class="ds-small ds-muted">${esc(secMeta.title)}</span>
            </div>
            <div class="ds-swimlane-row__steps" role="list" aria-label="${esc(clinicalLabel)}">
              ${s.points
                .map((pt, idx) => {
                  const currentDisplay = resolveTranslatedPointDisplay(pt, s.valueType, lang);
                  const prevPt = idx > 0 ? s.points[idx - 1] : undefined;
                  const prevDisplay = prevPt
                    ? resolveTranslatedPointDisplay(prevPt, s.valueType, lang)
                    : null;
                  const hasChanged = prevDisplay !== null && prevDisplay !== currentDisplay;
                  const badgeClass = hasChanged
                    ? "ds-badge--orientation-adapt"
                    : "ds-badge--neutral";
                  return `<div class="ds-step-node" role="listitem">
                    <span class="ds-step-node__date">${esc(pt.formDateLabel)}</span>
                    <span class="ds-badge ${badgeClass} ds-badge--sm ds-Swimlane__text ds-markdown-inline" data-tooltip="${esc(stripMarkdown(currentDisplay))}">${renderSafeInlineMarkdown(currentDisplay)}</span>
                    ${
                      pt.isManual
                        ? `<span class="ds-badge ds-badge--manual ds-badge--sm" title="${
                            lang === "fr" ? "Modifié manuellement" : "Manually edited"
                          }">${iconSvg("ic-edit-note", "ds-icon--xs")}</span>`
                        : ""
                    }
                    ${
                      idx < s.points.length - 1
                        ? `<span class="ds-step-node__arrow" aria-hidden="true">${iconSvg("ic-arrow-right", "ds-icon--xs")}</span>`
                        : ""
                    }
                  </div>`;
                })
                .join("")}
            </div>
          </div>`;
        })
        .join("")}
    </div>
  </section>`;
}

function renderRawMatrixTable(
  dashboard: PatientDashboardView,
  seriesList: PatientMetricSeriesView[],
  lang: Language,
): string {
  if (seriesList.length === 0) return "";
  const formColumns = new Map<string, string>();
  for (const s of seriesList) {
    for (const pt of s.points) {
      if (!formColumns.has(pt.formId)) {
        formColumns.set(pt.formId, pt.formDateLabel);
      }
    }
  }
  const colEntries = Array.from(formColumns.entries());
  const domainParam = encodeURIComponent(dashboard.domain);
  const patientBaseUrl = `/patients/${encodeURIComponent(dashboard.patientId)}`;

  return `<section class="ds-card" id="dashboard-raw-table-panel" data-testid="patient_dashboard_raw_table">
    <div class="ds-card__header">
      <div>
        <h3 class="ds-card__title">
          <span class="ds-icon-box">${iconSvg("ic-layers")}</span>
          ${
            lang === "fr" ? "Tableau comparatif brut multi-RCP" : "Multi-MDT Raw Comparative Matrix"
          }
        </h3>
        <p class="ds-card__subtitle">
          ${
            lang === "fr"
              ? "Valeurs exactes extraites ou corrigées manuellement par séance RCP."
              : "Exact extracted or manually edited values across MDT sessions."
          }
        </p>
      </div>
    </div>
    <div class="ds-card__body">
      <div class="ds-table-wrap">
        <table class="ds-table">
          <thead>
            <tr>
              <th scope="col">${lang === "fr" ? "Paramètre clinique" : "Clinical parameter"}</th>
              ${colEntries
                .map(([formId, dateLabel], idx) => {
                  const sessionTitle =
                    dateLabel && dateLabel !== "Date non renseignée"
                      ? lang === "fr"
                        ? `Séance du ${dateLabel}`
                        : `Session ${dateLabel}`
                      : lang === "fr"
                        ? `Séance #${idx + 1}`
                        : `Session #${idx + 1}`;
                  return `<th scope="col">
                    <a class="ds-table__primary-link" href="${patientBaseUrl}?file=${encodeURIComponent(formId)}&domain=${domainParam}">
                      ${esc(sessionTitle)}
                    </a>
                  </th>`;
                })
                .join("")}
            </tr>
          </thead>
          <tbody>
            ${seriesList
              .map((s) => {
                const secMeta = getSectionPresentation(s.section, dashboard.domain, lang);
                const clinicalLabel = resolveClinicalMetricLabel(s, lang);
                const byForm = new Map(s.points.map((p) => [p.formId, p]));
                return `<tr>
                  <td data-label="${lang === "fr" ? "Paramètre clinique" : "Clinical parameter"}" class="ds-table__primary-cell" data-jump-section="${esc(s.section)}" data-jump-tab="clinical" tabindex="0">
                    <strong>${esc(clinicalLabel)}</strong>
                    ${s.unit ? ` <span class="ds-small ds-muted">(${esc(s.unit)})</span>` : ""}
                    <br/>
                    <span class="ds-small ds-muted">${esc(secMeta.title)}</span>
                  </td>
                  ${colEntries
                    .map(([formId, dateLabel]) => {
                      const pt = byForm.get(formId);
                      if (!pt) {
                        return `<td data-label="${esc(dateLabel)}" class="ds-muted">—</td>`;
                      }
                      const displayVal = resolveTranslatedPointDisplay(pt, s.valueType, lang);
                      return `<td data-label="${esc(dateLabel)}">
                        <div class="ds-cluster">
                          <strong class="ds-matrix-table__cell-inner ds-markdown-inline" data-tooltip="${esc(stripMarkdown(displayVal))}">${renderSafeInlineMarkdown(displayVal)}</strong>
                          ${
                            pt.isManual
                              ? `<span class="ds-badge ds-badge--manual ds-badge--sm" title="${
                                  lang === "fr" ? "Corrigé manuellement" : "Manually edited"
                                }">${iconSvg("ic-edit-note", "ds-icon--xs")}</span>`
                              : ""
                          }
                          ${
                            pt.deltaDisplay
                              ? `<span class="ds-raw-pill__delta">(${esc(pt.deltaDisplay)})</span>`
                              : ""
                          }
                        </div>
                      </td>`;
                    })
                    .join("")}
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  </section>`;
}

export function renderPatientDashboardPanel(
  dashboard: PatientDashboardView,
  lang: Language,
): string {
  const numericSeries = dashboard.metrics.filter((s) => s.valueType === "numeric_or_mixed");
  const qualitativeSeries = dashboard.metrics.filter((s) => s.valueType !== "numeric_or_mixed");

  const mfmSeriesList = numericSeries.filter((s) => MFM_METRIC_KEYS.has(s.metricKey));
  let mfmCardRendered = false;
  const chartCardsHtml = numericSeries
    .map((s) => {
      if (MFM_METRIC_KEYS.has(s.metricKey)) {
        if (mfmCardRendered) return "";
        mfmCardRendered = true;
        return renderMfmCombinedChartCard(mfmSeriesList, dashboard.domain, lang);
      }
      return renderNumericChartCard(s, dashboard.domain, lang);
    })
    .filter(Boolean)
    .join("");

  const emptyMetricsHtml =
    dashboard.metrics.length === 0
      ? `<div class="ds-alert ds-alert--guidance" data-testid="dashboard_metrics_empty">
          <span class="ds-alert__icon" aria-hidden="true">${iconSvg("ic-info")}</span>
          <div class="ds-alert__content">
            <span class="ds-alert__title">${
              lang === "fr"
                ? "Aucune métrique longitudinale brute relevée"
                : "No raw longitudinal metrics found"
            }</span>
            <span>${
              lang === "fr"
                ? "Les courbes et jalons apparaîtront automatiquement dès que des scores ou statuts cliniques seront extraits des fiches RCP de ce patient."
                : "Charts and milestones will appear automatically once clinical scores or statuses are extracted from this patient's MDT forms."
            }</span>
          </div>
        </div>`
      : "";

  return `<div class="ds-patient-dashboard ds-stack--lg" data-testid="patient_dashboard_root" data-patient-id="${esc(dashboard.patientId)}">
    ${renderSummaryCard(dashboard, dashboard.summary, lang)}

    <div class="ds-pole-heading">
      ${iconSvg("ic-trend-up", "ds-icon--xs")}
      ${
        lang === "fr"
          ? "Suivi longitudinal brut des métriques cliniques (Multi-années)"
          : "Multi-Year Raw Longitudinal Clinical Metrics Tracking"
      }
    </div>

    ${emptyMetricsHtml}

    ${
      chartCardsHtml
        ? `<div class="ds-metric-charts-grid" data-testid="patient_dashboard_charts_grid">
            ${chartCardsHtml}
          </div>`
        : ""
    }

    ${renderQualitativeSwimlanes(qualitativeSeries, dashboard.domain, lang)}
    ${renderRawMatrixTable(dashboard, dashboard.metrics, lang)}
  </div>`;
}
