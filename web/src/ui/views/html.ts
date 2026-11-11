import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, type Tokens } from "marked";
import type { Language } from "../../domain/types.js";

export const ASSET_VERSION = "37";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_SVG_PATH = path.resolve(__dirname, "../../../public/img/icons.svg");
export const INLINE_ICONS_SVG = fs.existsSync(ICONS_SVG_PATH)
  ? fs.readFileSync(ICONS_SVG_PATH, "utf8")
  : "";

const ISO_MIDNIGHT_RE = /(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

const EMOJI_RE =
  /(\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier})?)*)/gu;

const clinicalMarkdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    text(
      this: { parser: { parseInline(tokens: Tokens.Generic[]): string } },
      token: Tokens.Text | Tokens.Escape,
    ): string {
      if ("tokens" in token && token.tokens) {
        return this.parser.parseInline(token.tokens);
      }
      return token.text.replace(EMOJI_RE, (match) =>
        match ? `<span class="ds-emoji">${match}</span>` : "",
      );
    },
    link(
      this: { parser: { parseInline(tokens: Tokens.Generic[]): string } },
      { href, title, tokens }: Tokens.Link,
    ): string {
      const label = this.parser.parseInline(tokens);
      const safeHref = (href ?? "").trim();
      if (!/^(?:https?:\/\/|mailto:|\/|#)/i.test(safeHref)) {
        return label;
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

/**
 * Safely renders clinical LLM Markdown replies into sanitized semantic HTML using `marked`.
 * Raw HTML blocks/tags are escaped via the custom `html` renderer.
 */
export function renderSafeMarkdown(markdown: string | null | undefined): string {
  const rawStr = String(markdown ?? "");
  const dateNormalized = rawStr.includes("T00:00:00")
    ? rawStr.replace(ISO_MIDNIGHT_RE, "$3/$2/$1")
    : rawStr;
  const normalized = dateNormalized.trim();
  if (!normalized) return "";
  return clinicalMarkdown.parse(normalized, { async: false }) as string;
}

/**
 * Safely renders inline Markdown into sanitized HTML without wrapping `<p>` tags.
 */
export function renderSafeInlineMarkdown(markdown: string | null | undefined): string {
  const rawStr = String(markdown ?? "");
  const dateNormalized = rawStr.includes("T00:00:00")
    ? rawStr.replace(ISO_MIDNIGHT_RE, "$3/$2/$1")
    : rawStr;
  const normalized = dateNormalized.trim();
  if (!normalized) return "";
  return clinicalMarkdown.parseInline(normalized, { async: false }) as string;
}

const plainTextMarkdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    heading({ tokens }): string {
      return `${this.parser.parseInline(tokens, this.parser.textRenderer)} `;
    },
    paragraph({ tokens }): string {
      return `${this.parser.parseInline(tokens, this.parser.textRenderer)} `;
    },
    blockquote({ tokens }): string {
      return `${this.parser.parse(tokens)} `;
    },
    list(token): string {
      return `${token.items.map((item) => this.listitem(item)).join(" ")} `;
    },
    listitem(item): string {
      return `${this.parser.parse(item.tokens)} `;
    },
    code({ text }): string {
      return `${text} `;
    },
    hr(): string {
      return " ";
    },
    text(token): string {
      return "tokens" in token && token.tokens
        ? this.parser.parseInline(token.tokens, this.parser.textRenderer)
        : token.text;
    },
  },
});

/**
 * Strips Markdown formatting syntax (`**bold**`, `*italic*`, `` `code` ``, `[label](url)`, headings, list markers)
 * into clean plain text via `marked`'s built-in `TextRenderer` for HTML attributes (`title`, `data-tooltip`) and `<summary>` previews.
 */
export function stripMarkdown(markdown: string | null | undefined): string {
  if (markdown === null || markdown === undefined) return "";
  const rawStr = String(markdown);
  const dateNormalized = rawStr.includes("T00:00:00")
    ? rawStr.replace(ISO_MIDNIGHT_RE, "$3/$2/$1")
    : rawStr;
  const parsed = plainTextMarkdown.parse(dateNormalized, { async: false }) as string;
  return parsed.split(/\s+/).filter(Boolean).join(" ");
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const HTML_ESCAPE_TEST_RE = /[&<>"']/;
const HTML_ESCAPE_REPLACE_RE = /[&<>"']/g;

/**
 * Pure HTML escaping without date formatting side-effects.
 */
export function escapeHtml(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  return HTML_ESCAPE_TEST_RE.test(str)
    ? str.replace(HTML_ESCAPE_REPLACE_RE, (ch) => HTML_ESCAPES[ch] ?? ch)
    : str;
}

/**
 * Escapes HTML and normalizes ISO midnight timestamps (`YYYY-MM-DDT00:00:00...` -> `DD/MM/YYYY`).
 * Fast-path skips the regex unless `T00:00:00` is present in the string.
 */
export function esc(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  const normalized = str.includes("T00:00:00") ? str.replace(ISO_MIDNIGHT_RE, "$3/$2/$1") : str;
  return escapeHtml(normalized);
}

/**
 * Marker class for pre-sanitized / trusted HTML fragments inside `html` tagged templates.
 */
export class SafeHtml {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/**
 * Marks a string as trusted HTML so the `html` tagged template does not double-escape it.
 */
export function raw(trustedHtml: string | SafeHtml | null | undefined): SafeHtml {
  if (!trustedHtml) return new SafeHtml("");
  if (trustedHtml instanceof SafeHtml) return trustedHtml;
  return new SafeHtml(trustedHtml);
}

function renderInterpolatedValue(val: unknown): string {
  if (val === null || val === undefined || val === false) return "";
  if (val instanceof SafeHtml) return val.value;
  if (Array.isArray(val)) {
    return val.map(renderInterpolatedValue).join("");
  }
  return esc(val);
}

/**
 * Auto-escaping tagged template literal for XSS-safe SSR HTML generation.
 * All interpolated values are automatically escaped via `esc()` unless wrapped in `raw()`.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      out += renderInterpolatedValue(values[i]);
    }
  }
  return out;
}

/**
 * Formats a duration in seconds as "X min YY s" (e.g., "0 min 12 s", "1 min 08 s").
 */
export function formatDurationMinSec(seconds: number): string {
  const totalSec = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins} min ${String(secs).padStart(2, "0")} s`;
}

export function iconSvg(id: string, sizeClass = ""): string {
  const cls = sizeClass ? `ds-icon ${sizeClass}` : "ds-icon";
  return `<svg class="${cls}" aria-hidden="true"><use href="#${escapeHtml(id)}"/></svg>`;
}

export function deriveRcpTone(
  priorityLevel: string | undefined,
  isComplete = true,
): "red" | "orange" | "green" {
  const norm = (priorityLevel ?? "").toLowerCase();
  if (norm === "high" || (norm.includes("urgent") && !norm.includes("semi"))) {
    return "red";
  }
  if (norm === "medium" || norm.includes("semi") || norm.includes("mod") || !isComplete) {
    return "orange";
  }
  return "green";
}

export function extractDobFromPatientId(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = id.match(/(?:_|-)(\d{4})[_-](\d{2})[_-](\d{2})$/);
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function formatPatientSubtitle(id: string, rcpCount: number, lang: Language = "fr"): string {
  const sessionLabel =
    lang === "fr"
      ? `${rcpCount} ${rcpCount > 1 ? "séances RCP" : "séance RCP"}`
      : `${rcpCount} ${rcpCount > 1 ? "MDT sessions" : "MDT session"}`;
  const dob = extractDobFromPatientId(id);
  if (dob) {
    return lang === "fr" ? `Né(e) le ${dob} · ${sessionLabel}` : `Born ${dob} · ${sessionLabel}`;
  }
  if (id && !id.includes("_") && !id.toLowerCase().endsWith(".pdf")) {
    return lang === "fr" ? `Dossier ${id} · ${sessionLabel}` : `Record ${id} · ${sessionLabel}`;
  }
  return sessionLabel;
}

export function stripDomainQuery(input: string): string {
  return input
    .replace(/<input type="hidden" name="domain" value="(?:oncology|sma)">\s*/g, "")
    .replace(/ data-domain="(?:oncology|sma)"/g, "")
    .replace(/\?domain=(?:oncology|sma)&/g, "?")
    .replace(/&domain=(?:oncology|sma)(?=[&#"'\s]|$)/g, "")
    .replace(/\?domain=(?:oncology|sma)(?=[#"'\s]|$)/g, "");
}
