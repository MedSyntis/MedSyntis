#!/usr/bin/env node
// MedSyntis Design System — Material Design 3 HCT & WCAG 2.2 AA/AAA Contrast Verifier (zero dependency).
// Reference: https://m3.material.io/styles/color/system/overview
// Usage: node web/scripts/check-contrast.mjs   (exit code 1 if any invariant fails)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tokensPath = fileURLToPath(new URL("../public/css/tokens.css", import.meta.url));
const componentsPath = fileURLToPath(new URL("../public/css/components.css", import.meta.url));
const rawTokensCss = readFileSync(tokensPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rawComponentsCss = readFileSync(componentsPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function parseVarsBlock(source, openBraceIdx) {
  let depth = 1;
  let i = openBraceIdx + 1;
  while (depth > 0 && i < source.length) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  const vars = {};
  for (const m of source.slice(openBraceIdx + 1, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return { vars, endIdx: i };
}

function block(selector, fromIdx = 0) {
  const start = rawTokensCss.indexOf(selector, fromIdx);
  if (start < 0) throw new Error(`selector not found in tokens.css: ${selector}`);
  const open = rawTokensCss.indexOf("{", start);
  return parseVarsBlock(rawTokensCss, open).vars;
}

function mediaInnerBlock(mediaHeader, innerSelector) {
  let searchFrom = 0;
  while (true) {
    const mStart = rawTokensCss.indexOf(mediaHeader, searchFrom);
    if (mStart < 0) throw new Error(`media query not found: ${mediaHeader} -> ${innerSelector}`);
    const mOpen = rawTokensCss.indexOf("{", mStart);
    let depth = 1;
    let i = mOpen + 1;
    while (depth > 0 && i < rawTokensCss.length) {
      if (rawTokensCss[i] === "{") depth++;
      else if (rawTokensCss[i] === "}") depth--;
      i++;
    }
    const slice = rawTokensCss.slice(mOpen + 1, i - 1);
    const innerIdx = slice.indexOf(innerSelector);
    if (innerIdx >= 0) {
      const innerOpen = slice.indexOf("{", innerIdx);
      return parseVarsBlock(slice, innerOpen).vars;
    }
    searchFrom = i;
  }
}

const baseRoot = block(":root,");
const lightStd = baseRoot;
const lightMed = { ...lightStd, ...block(':root[data-theme="light"][data-contrast="medium"]') };
const lightHigh = { ...lightStd, ...block(':root[data-theme="light"][data-contrast="high"]') };
const darkStd = { ...lightStd, ...block(':root[data-theme="dark"]') };
const darkMed = { ...darkStd, ...block(':root[data-theme="dark"][data-contrast="medium"]') };
const darkHigh = { ...darkStd, ...block(':root[data-theme="dark"][data-contrast="high"]') };

function resolve(vars, name, depth = 0) {
  const v = vars[name];
  if (v === undefined) throw new Error(`unknown token ${name}`);
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (ref && depth < 12) return resolve(vars, ref[1], depth + 1);
  return v;
}

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function luminance(hex) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    throw new Error(`expected #RRGGBB hex color, got: ${hex}`);
  }
  const h = hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => lin(Number.parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// M3 ContrastCurve thresholds across [Standard (0.0), Medium (+0.5), High (+1.0)]
const CURVE = {
  TEXT: { standard: 4.5, medium: 6.0, high: 7.0 },
  UI: { standard: 3.0, medium: 4.5, high: 7.0 },
  OUTLINE: { standard: 3.0, medium: 4.5, high: 7.0 },
  OUTLINE_VAR: { standard: 1.35, medium: 3.0, high: 4.5 },
};

const pairs = [
  // Core On-Surface & Surface hierarchy
  ["--ds-color-text", "--ds-color-canvas", "TEXT"],
  ["--ds-color-text", "--ds-color-surface", "TEXT"],
  ["--ds-color-text", "--ds-color-surface-sunken", "TEXT"],
  ["--ds-color-text", "--ds-color-surface-hover", "TEXT"],
  ["--ds-color-text", "--ds-surface-tint-primary", "TEXT"],
  ["--ds-color-text", "--ds-surface-tint-warning", "TEXT"],
  ["--ds-color-text", "--ds-surface-tint-danger", "TEXT"],
  ["--ds-color-text", "--ds-surface-tint-manual", "TEXT"],
  ["--ds-color-text-muted", "--ds-color-canvas", "TEXT"],
  ["--ds-color-text-muted", "--ds-color-surface", "TEXT"],
  ["--ds-color-text-muted", "--ds-color-surface-sunken", "TEXT"],
  ["--ds-color-text-muted", "--ds-surface-tint-primary", "TEXT"],
  ["--ds-color-text-muted", "--ds-surface-tint-warning", "TEXT"],
  ["--ds-color-text-muted", "--ds-surface-tint-danger", "TEXT"],
  ["--ds-color-text-subtle", "--ds-color-surface", "TEXT"],
  ["--ds-color-text-subtle", "--ds-color-surface-sunken", "TEXT"],

  // M3 Outline & Outline-Variant
  ["--ds-color-border-strong", "--ds-color-surface", "OUTLINE"],
  ["--ds-color-border-strong", "--ds-color-surface-sunken", "OUTLINE"],
  ["--ds-color-border", "--ds-color-surface", "OUTLINE_VAR"],

  // M3 Inverse roles (Snackbars / Tooltips)
  ["--ds-inverse-on-surface", "--ds-inverse-surface", "TEXT"],
  ["--ds-inverse-primary", "--ds-inverse-surface", "TEXT"],

  // Primary & Secondary Accent + Containers
  ["--ds-color-on-primary", "--ds-color-primary", "TEXT"],
  ["--ds-color-on-primary", "--ds-color-primary-hover", "TEXT"],
  ["--ds-color-on-primary-container", "--ds-color-primary-container", "TEXT"],
  ["--ds-color-on-secondary-container", "--ds-color-secondary-container", "TEXT"],
  ["--ds-color-on-secondary-container", "--ds-color-primary-soft", "TEXT"],
  ["--ds-color-primary-text", "--ds-color-surface", "TEXT"],
  ["--ds-color-primary-text", "--ds-color-canvas", "TEXT"],
  ["--ds-color-primary-text", "--ds-color-surface-sunken", "TEXT"],
  ["--ds-color-primary", "--ds-color-surface", "UI"],
  ["--ds-color-focus", "--ds-color-surface", "UI"],
  ["--ds-color-focus", "--ds-color-canvas", "UI"],

  // Semantic Statuses (Danger / Success / Warning / Info / Neutral / Manual)
  ["--ds-color-on-danger", "--ds-color-danger", "TEXT"],
  ["--ds-color-on-danger", "--ds-color-danger-hover", "TEXT"],
  ["--ds-color-danger-fg", "--ds-color-danger-bg", "TEXT"],
  ["--ds-color-danger-text", "--ds-color-surface", "TEXT"],
  ["--ds-color-danger-text", "--ds-color-surface-sunken", "TEXT"],
  ["--ds-color-danger", "--ds-color-surface", "UI"],

  ["--ds-color-success-fg", "--ds-color-success-bg", "TEXT"],
  ["--ds-color-success-text", "--ds-color-surface", "TEXT"],
  ["--ds-color-success-text", "--ds-color-surface-sunken", "TEXT"],
  ["--ds-color-success", "--ds-color-surface", "UI"],

  ["--ds-color-warning-fg", "--ds-color-warning-bg", "TEXT"],
  ["--ds-color-warning-text", "--ds-color-surface", "TEXT"],
  ["--ds-color-warning-text", "--ds-color-surface-sunken", "TEXT"],
  ["--ds-color-warning", "--ds-color-surface", "UI"],

  ["--ds-color-info-fg", "--ds-color-info-bg", "TEXT"],
  ["--ds-color-info-text", "--ds-color-surface", "TEXT"],
  ["--ds-color-neutral-fg", "--ds-color-neutral-bg", "TEXT"],
  ["--ds-color-neutral", "--ds-color-surface", "UI"],

  ["--ds-orientation-adapt-fg", "--ds-orientation-adapt-bg", "TEXT"],
  ["--ds-manual-fg", "--ds-manual-bg", "TEXT"],
  ["--ds-manual-text", "--ds-color-surface", "TEXT"],
  ["--ds-manual", "--ds-color-surface", "UI"],
  ["--ds-specialty-fg", "--ds-specialty-bg", "TEXT"],
  ["--ds-domain-onco-fg", "--ds-domain-onco-bg", "TEXT"],
  ["--ds-domain-sma-fg", "--ds-domain-sma-bg", "TEXT"],

  // Navigation Rail, Topbar Contextual Menu & Table Header
  ["--ds-sidebar-text", "--ds-sidebar-bg", "TEXT"],
  ["--ds-sidebar-text-muted", "--ds-sidebar-bg", "TEXT"],
  ["--ds-sidebar-active-text", "--ds-sidebar-active-bg", "TEXT"],
  ["--ds-sidebar-text", "--ds-sidebar-bg-hover", "TEXT"],
  ["--ds-sidebar-brand-accent", "--ds-sidebar-bg", "TEXT"],
  ["--ds-color-text", "--ds-menu-bg", "TEXT"],
  ["--ds-color-primary-text", "--ds-menu-bg", "TEXT"],
  ["--ds-color-text", "--ds-menu-item-hover", "TEXT"],
  ["--ds-color-on-secondary-container", "--ds-menu-item-active", "TEXT"],
  ["--ds-table-header-text", "--ds-table-header-bg", "TEXT"],

  // RCP Clinical Headers (Green / Orange / Red)
  ["--ds-rcp-green-fg", "--ds-rcp-green-grad", "TEXT"],
  ["--ds-rcp-green-muted", "--ds-rcp-green-grad", "TEXT"],
  ["--ds-rcp-green-fg", "--ds-rcp-green-grad-soft", "TEXT"],
  ["--ds-rcp-orange-fg", "--ds-rcp-orange-grad", "TEXT"],
  ["--ds-rcp-orange-muted", "--ds-rcp-orange-grad", "TEXT"],
  ["--ds-rcp-orange-fg", "--ds-rcp-orange-grad-soft", "TEXT"],
  ["--ds-rcp-red-fg", "--ds-rcp-red-grad", "TEXT"],
  ["--ds-rcp-red-muted", "--ds-rcp-red-grad", "TEXT"],
  ["--ds-rcp-red-fg", "--ds-rcp-red-grad-soft", "TEXT"],

  // ECharts Longitudinal Clinical Series on Surface
  ["--ds-chart-series-1", "--ds-color-surface", "UI"],
  ["--ds-chart-series-2", "--ds-color-surface", "UI"],
  ["--ds-chart-series-3", "--ds-color-surface", "UI"],
  ["--ds-chart-series-4", "--ds-color-surface", "UI"],
];

// M3 Container-vs-Surface contrast requirements in Medium (+0.5: >= 3.0) and High (+1.0: >= 4.5)
const invertedContainers = [
  ["--ds-color-primary-container", "--ds-color-surface"],
  ["--ds-color-secondary-container", "--ds-color-surface"],
  ["--ds-sidebar-active-bg", "--ds-sidebar-bg"],
  ["--ds-menu-item-active", "--ds-menu-bg"],
  ["--ds-color-success-bg", "--ds-color-surface"],
  ["--ds-color-warning-bg", "--ds-color-surface"],
  ["--ds-color-danger-bg", "--ds-color-surface"],
  ["--ds-color-info-bg", "--ds-color-surface"],
  ["--ds-color-neutral-bg", "--ds-color-surface"],
  ["--ds-manual-bg", "--ds-color-surface"],
  ["--ds-specialty-bg", "--ds-color-surface"],
  ["--ds-domain-onco-bg", "--ds-color-surface"],
  ["--ds-domain-sma-bg", "--ds-color-surface"],
];

let failures = 0;
function check(ok, msg) {
  if (!ok) {
    failures++;
    console.log(`FAIL  ${msg}`);
  }
}

const schemes = [
  ["light-standard (M3 0.0 / WCAG AA)", lightStd, "standard", "light"],
  ["light-medium (M3 +0.5 / Enhanced AA)", lightMed, "medium", "light"],
  ["light-high (M3 +1.0 / WCAG AAA)", lightHigh, "high", "light"],
  ["dark-standard (M3 0.0 / WCAG AA)", darkStd, "standard", "dark"],
  ["dark-medium (M3 +0.5 / Enhanced AA)", darkMed, "medium", "dark"],
  ["dark-high (M3 +1.0 / WCAG AAA)", darkHigh, "high", "dark"],
];

for (const [label, vars, level, polarity] of schemes) {
  console.log(`\n## ${label}`);
  let schemePass = 0;

  for (const [fg, bg, kind] of pairs) {
    const min = CURVE[kind][level];
    const f = resolve(vars, fg);
    const b = resolve(vars, bg);
    const r = ratio(f, b);
    const ok = r + 1e-6 >= min;
    if (ok) schemePass++;
    check(ok, `${r.toFixed(2).padStart(5)}:1 (need ≥${min})  ${fg} ${f}  on  ${bg} ${b}`);
  }

  // Verify M3 Tonal Container Inversion contrast against surfaces in Medium (+0.5) & High (+1.0)
  if (level === "medium" || level === "high") {
    const minContainer = level === "high" ? 4.5 : 3.0;
    for (const [containerTok, surfaceTok] of invertedContainers) {
      const cHex = resolve(vars, containerTok);
      const sHex = resolve(vars, surfaceTok);
      const r = ratio(cHex, sHex);
      const ok = r + 1e-6 >= minContainer;
      if (ok) schemePass++;
      check(
        ok,
        `CONTAINER ${r.toFixed(2).padStart(5)}:1 (need ≥${minContainer})  ${containerTok} ${cHex}  vs  ${surfaceTok} ${sHex}`,
      );
    }
  }

  // Verify 5-step Surface Container monotonicity + Dark anti-halation
  const surfOrder = [
    "--ds-surface-container-lowest",
    "--ds-surface-container-low",
    "--ds-surface-container",
    "--ds-surface-container-high",
    "--ds-surface-container-highest",
  ].map((tok) => ({ tok, hex: resolve(vars, tok), y: luminance(resolve(vars, tok)) }));

  for (let i = 0; i < surfOrder.length - 1; i++) {
    const a = surfOrder[i];
    const b = surfOrder[i + 1];
    const monoOk = polarity === "light" ? a.y > b.y : a.y < b.y;
    check(
      monoOk,
      `SURFACE_MONOTONICITY ${a.tok} (${a.hex}, Y=${a.y.toFixed(4)}) -> ${b.tok} (${b.hex}, Y=${b.y.toFixed(4)})`,
    );
  }

  if (polarity === "dark") {
    const canvasHex = resolve(vars, "--ds-color-canvas");
    check(
      canvasHex !== "#000000",
      `ANTI_HALATION --ds-color-canvas must not be #000000 in ${label} (got ${canvasHex})`,
    );
  }

  console.log(`PASS  ${schemePass} checks verified in ${label}`);
}

// Verify 100% parity between explicit attribute selectors and @media blocks
const mediaChecks = [
  [
    "prefers-contrast: more (light)",
    block(':root[data-theme="light"][data-contrast="high"]'),
    mediaInnerBlock("@media (prefers-contrast: more)", ':root[data-contrast="auto"]'),
  ],
  [
    "prefers-color-scheme: dark (standard)",
    block(':root[data-theme="dark"]'),
    mediaInnerBlock("@media (prefers-color-scheme: dark)", ':root[data-theme="auto"]'),
  ],
  [
    "prefers-color-scheme: dark (medium)",
    block(':root[data-theme="dark"][data-contrast="medium"]'),
    mediaInnerBlock(
      "@media (prefers-color-scheme: dark)",
      ':root[data-theme="auto"][data-contrast="medium"]',
    ),
  ],
  [
    "prefers-color-scheme: dark (high)",
    block(':root[data-theme="dark"][data-contrast="high"]'),
    mediaInnerBlock(
      "@media (prefers-color-scheme: dark)",
      ':root[data-theme="auto"][data-contrast="high"]',
    ),
  ],
  [
    "prefers-contrast: more (explicit dark)",
    block(':root[data-theme="dark"][data-contrast="high"]'),
    mediaInnerBlock(
      "@media (prefers-contrast: more)",
      ':root[data-theme="dark"][data-contrast="auto"]',
    ),
  ],
  [
    "prefers-color-scheme: dark + prefers-contrast: more",
    block(':root[data-theme="dark"][data-contrast="high"]'),
    mediaInnerBlock(
      "@media (prefers-color-scheme: dark) and (prefers-contrast: more)",
      ':root[data-theme="auto"][data-contrast="auto"]',
    ),
  ],
];

for (const [name, attrVars, mediaVars] of mediaChecks) {
  const attrStr = JSON.stringify(attrVars);
  const mediaStr = JSON.stringify(mediaVars);
  check(attrStr === mediaStr, `MEDIA_PARITY mismatch in ${name}`);
}

// Static guard against forbidden M3 cross-pairings in components.css
const ruleRegex = /([^{}]+)\{([^{}]+)\}/g;
for (const m of rawComponentsCss.matchAll(ruleRegex)) {
  const sel = m[1].trim().replace(/\s+/g, " ");
  const body = m[2];
  if (
    body.includes("var(--ds-menu-item-hover)") &&
    body.includes("var(--ds-sidebar-active-text)")
  ) {
    check(false, `FORBIDDEN_PAIRING in components.css (${sel}): --ds-menu-item-hover with --ds-sidebar-active-text`);
  }
  if (
    body.includes("var(--ds-color-primary-soft)") &&
    (body.includes("var(--ds-sidebar-active-text)") || body.includes("var(--ds-color-primary-text)"))
  ) {
    check(false, `FORBIDDEN_PAIRING in components.css (${sel}): --ds-color-primary-soft with non-container text role`);
  }
  if (
    sel === '.ds-bottom-nav__item[aria-current="page"]' &&
    body.includes("var(--ds-sidebar-active-text)")
  ) {
    check(false, `FORBIDDEN_PAIRING in components.css (${sel}): label sits on sidebar-bg, must use --ds-sidebar-text`);
  }
}

console.log(`\nTotal failures: ${failures}`);
process.exit(failures ? 1 : 0);
