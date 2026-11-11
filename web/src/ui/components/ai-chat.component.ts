import type { ChatReply } from "../../application/ports/medsyntis-api.port.js";
import type { AgentModuleInfo, ClinicalDomain, Language } from "../../domain/types.js";
import {
  iconSvg as baseIconSvg,
  esc,
  renderSafeInlineMarkdown,
  renderSafeMarkdown,
  stripMarkdown,
} from "../views/html.js";

export { renderSafeInlineMarkdown, renderSafeMarkdown, stripMarkdown };

function iconSvg(id: string, extraClass = ""): string {
  return baseIconSvg(id, esc(extraClass));
}

export function resolveCitationPdfHref(
  rawName: string,
  page: string | number | null | undefined,
  domain: ClinicalDomain = "oncology",
  fallbackFormFile?: string,
): string {
  const domainParam = encodeURIComponent(domain);
  const pageNum = page ? String(page).replace(/[^\d]/g, "") || "1" : "1";
  const pageHash = `#page=${encodeURIComponent(pageNum)}&amp;view=FitH`;
  const cleaned = (rawName || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.\.+/g, ".")
    .replace(/\//g, " - ")
    .replace(/[\r\n\0]+/g, " ")
    .trim();
  if (!cleaned && fallbackFormFile) {
    return `/files/forms/${encodeURIComponent(fallbackFormFile)}/pdf?domain=${domainParam}${pageHash}`;
  }
  const formQuery = fallbackFormFile ? `&amp;formFile=${encodeURIComponent(fallbackFormFile)}` : "";
  return `/files/resources/${encodeURIComponent(cleaned || "document.pdf")}?domain=${domainParam}${formQuery}${pageHash}`;
}

export interface AiChatScopeConfig {
  rcpCount: number;
  activeFormLabel: string;
}

export interface AiChatComponentOptions {
  formAction: string;
  formTestId: string;
  logId: string;
  inputId: string;
  inputTestId: string;
  inputPlaceholder: string;
  inputLabel: string;
  submitTestId: string;
  submitLabel: string;
  welcomeMessage: string;
  chatHistory: Array<{ question: string; reply: ChatReply }>;
  quickPrompts: string[];
  quickPromptsHeading?: string;
  quickPromptsTestId?: string;
  hiddenFields?: Record<string, string>;
  scopeConfig?: AiChatScopeConfig;
  agents?: Array<Pick<AgentModuleInfo, "name" | "label" | "icon">>;
  defaultAgentName?: string;
  domain?: ClinicalDomain;
  lang?: Language;
}

/**
 * Dedicated Material Design 3 UX component displayed while waiting for clinical synthesis.
 */
export function renderAiThinkingModule(agentLabel?: string, lang: Language = "fr"): string {
  const resolvedLabel = agentLabel ?? (lang === "fr" ? "Assistant clinique" : "Clinical Assistant");
  const statusText =
    lang === "fr" ? "Analyse clinique en cours…" : "Clinical analysis in progress…";
  const timerText = lang === "fr" ? "0 min 00 s" : "0 min 00 s";
  const stepsLabel = lang === "fr" ? "Étapes d'analyse" : "Analysis steps";
  const step0 = lang === "fr" ? "Lecture du dossier médical" : "Reading medical record";
  const step1 =
    lang === "fr"
      ? "Consultation des recommandations de bonne pratique"
      : "Checking clinical guidelines";
  const step2 = lang === "fr" ? "Rédaction de la réponse sourcée" : "Drafting sourced reply";

  return `<li class="ds-chat__msg ds-chat__msg--assistant ds-chat__msg--thinking" data-chat-temp="true" data-testid="chat-thinking-indicator" role="status" aria-live="polite">
    <div class="ds-ai-thinking">
      <div class="ds-ai-thinking__header">
        <span class="ds-ai-thinking__avatar" aria-hidden="true">
          ${iconSvg("ic-sparkle", "ds-icon--xs")}
        </span>
        <div class="ds-ai-thinking__titles">
          <span class="ds-ai-thinking__agent" data-thinking-agent>${esc(resolvedLabel)}</span>
          <span class="ds-ai-thinking__status" data-thinking-status>${esc(statusText)}</span>
        </div>
        <span class="ds-ai-thinking__timer ds-mono" data-thinking-timer>${timerText}</span>
      </div>
      <div class="ds-ai-thinking__bar" aria-hidden="true">
        <span class="ds-ai-thinking__bar-fill"></span>
      </div>
      <ol class="ds-ai-thinking__steps" aria-label="${esc(stepsLabel)}">
        <li class="ds-ai-thinking__step is-active" data-thinking-step="0">
          <span class="ds-ai-thinking__dot" aria-hidden="true"></span>
          <span>${esc(step0)}</span>
        </li>
        <li class="ds-ai-thinking__step" data-thinking-step="1">
          <span class="ds-ai-thinking__dot" aria-hidden="true"></span>
          <span>${esc(step1)}</span>
        </li>
        <li class="ds-ai-thinking__step" data-thinking-step="2">
          <span class="ds-ai-thinking__dot" aria-hidden="true"></span>
          <span>${esc(step2)}</span>
        </li>
      </ol>
    </div>
  </li>`;
}

/**
 * Renders a user question bubble + assistant reply bubble pair inside the chat log.
 */
export function renderChatLogMessagePartial(
  question: string,
  reply: ChatReply,
  domain: ClinicalDomain = "oncology",
  fallbackFormFile?: string,
  lang: Language = "fr",
): string {
  const sourcesLabel = lang === "fr" ? "Sources" : "Sources";
  const userLabel = lang === "fr" ? "Vous" : "You";
  const assistantLabel = lang === "fr" ? "Assistant clinique" : "Clinical Assistant";

  const refsHtml =
    reply.references.length === 0
      ? ""
      : `<ul class="ds-refs" aria-label="${sourcesLabel}">
          ${reply.references
            .map((r) => {
              const pdfHref = resolveCitationPdfHref(r.name, r.page, domain, fallbackFormFile);
              const pageNum = r.page ? String(r.page).replace(/[^\d]/g, "") || "1" : "1";
              const openTitle =
                lang === "fr"
                  ? `Ouvrir ${r.name}${r.page ? ` à la page ${r.page}` : ""}`
                  : `Open ${r.name}${r.page ? ` at page ${r.page}` : ""}`;
              return `<li class="ds-ref"><a class="ds-ref__source ds-ref__link" href="${pdfHref}" target="_blank" rel="noopener" title="${esc(openTitle)}" data-cite-resource="${esc(r.name)}" data-cite-page="${esc(pageNum)}" data-cite-form="${esc(fallbackFormFile ?? "")}">${iconSvg("ic-file-pdf", "ds-icon--xs")} ${esc(r.name)}${r.page ? ` p. ${esc(r.page)}` : ""}</a>${r.excerpt ? `<span class="ds-ref__quote ds-markdown-inline">« ${renderSafeInlineMarkdown(r.excerpt)} »</span>` : ""}</li>`;
            })
            .join("")}
        </ul>`;

  return `<li class="ds-chat__msg ds-chat__msg--user">
    <span class="ds-chat__author">${userLabel}</span>
    <div class="ds-chat__bubble">${esc(question)}</div>
  </li>
  <li class="ds-chat__msg ds-chat__msg--assistant" data-testid="chat-assistant-reply">
    <span class="ds-chat__author">${iconSvg("ic-sparkle", "ds-icon--xs")} ${assistantLabel}</span>
    <div class="ds-chat__bubble">
      <div class="ds-chat__markdown">${renderSafeMarkdown(reply.answer)}</div>
      ${refsHtml}
    </div>
  </li>`;
}

/**
 * Standalone, fixed-height Material Design 3 Clinical AI Chat UX Component.
 * - Compact single-line header bar (Specialty M3 dropdown + Scope segmented pill)
 * - Fixed-height scrollable message log (never stretches the page as messages accumulate)
 * - Sleek M3 Composer Dock with M3 Split Button for inserting clinical suggestions
 * - Enter submits the question, Shift+Enter inserts a line break
 */
export function renderAiChatComponent(opts: AiChatComponentOptions): string {
  const lang = opts.lang ?? "fr";
  const hiddenInputsHtml = Object.entries(opts.hiddenFields ?? {})
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");

  const hasControlBar = Boolean(opts.scopeConfig || (opts.agents && opts.agents.length > 0));
  const agentOptionsHtml = (opts.agents ?? [])
    .map((ag, idx) => {
      const selected = ag.name === opts.defaultAgentName || (idx === 0 && !opts.defaultAgentName);
      return `<option value="${esc(ag.name)}" data-icon="${esc(ag.icon || "ic-stethoscope")}" data-agent-label="${esc(ag.label)}" ${selected ? "selected" : ""}>${esc(ag.label)}</option>`;
    })
    .join("");

  const specialtyLabel =
    lang === "fr" ? "Spécialité médicale consultée" : "Consulted medical specialty";
  const scopeLabel = lang === "fr" ? "Périmètre du dossier" : "Record scope";
  const allMdtLabel =
    lang === "fr"
      ? `Tout le suivi (${opts.scopeConfig?.rcpCount ?? 0} RCP)`
      : `Full follow-up (${opts.scopeConfig?.rcpCount ?? 0} MDT)`;
  const sessionFormLabel =
    lang === "fr"
      ? `Séance du ${esc(opts.scopeConfig?.activeFormLabel ?? "")}`
      : `Session of ${esc(opts.scopeConfig?.activeFormLabel ?? "")}`;

  const controlBarHtml = hasControlBar
    ? `<div class="ds-assistant-bar" data-testid="assistant-control-bar">
        ${
          opts.agents && opts.agents.length > 0
            ? `<div class="ds-assistant-bar__specialty">
                <label class="ds-assistant-bar__label" for="${esc(opts.logId)}-specialty">
                  ${iconSvg("ic-stethoscope", "ds-icon--xs")} ${esc(specialtyLabel)}
                </label>
                <select id="${esc(opts.logId)}-specialty" name="agentName" class="ds-select ds-select--specialty" data-testid="chat-agent-selector">
                  ${agentOptionsHtml}
                </select>
              </div>`
            : ""
        }
        ${
          opts.scopeConfig
            ? `<div class="ds-segmented ds-segmented--sm ds-assistant-bar__scope" role="radiogroup" aria-label="${esc(scopeLabel)}">
                <input type="radio" name="scope" id="${esc(opts.logId)}-scope-patient" value="patient" checked>
                <label for="${esc(opts.logId)}-scope-patient">${iconSvg("ic-users", "ds-icon--xs")} ${allMdtLabel}</label>
                <input type="radio" name="scope" id="${esc(opts.logId)}-scope-form" value="form">
                <label for="${esc(opts.logId)}-scope-form">${iconSvg("ic-file-pdf", "ds-icon--xs")} ${sessionFormLabel}</label>
              </div>`
            : ""
        }
      </div>`
    : "";

  const chatMessagesHtml =
    opts.chatHistory.length === 0
      ? `<li class="ds-chat__msg ds-chat__msg--assistant">
          <span class="ds-chat__author">${iconSvg("ic-sparkle", "ds-icon--xs")} ${lang === "fr" ? "Assistant clinique" : "Clinical Assistant"}</span>
          <div class="ds-chat__bubble">${esc(opts.welcomeMessage)}</div>
        </li>`
      : opts.chatHistory
          .map((h) =>
            renderChatLogMessagePartial(
              h.question,
              h.reply,
              opts.domain ?? "oncology",
              opts.hiddenFields?.filename,
              lang,
            ),
          )
          .join("");

  const suggestedHeading =
    opts.quickPromptsHeading || (lang === "fr" ? "Questions suggérées" : "Suggested questions");
  const toggleLabel =
    lang === "fr" ? "Insérer une question suggérée" : "Insert a suggested question";

  const mergedSubmitSplitBtnHtml =
    opts.quickPrompts.length === 0
      ? `<button type="submit" class="ds-btn ds-btn--primary ds-btn--sm" data-chat-submit-btn data-testid="${esc(opts.submitTestId)}">
          ${iconSvg("ic-send", "ds-icon--xs")} <span>${esc(opts.submitLabel)}</span>
        </button>`
      : `<div class="ds-split-btn ds-split-btn--primary" data-split-prompt ${opts.quickPromptsTestId ? `data-testid="${esc(opts.quickPromptsTestId)}"` : ""}>
          <button type="submit" class="ds-split-btn__main" data-chat-submit-btn data-testid="${esc(opts.submitTestId)}" title="${esc(opts.submitLabel)} (${lang === "fr" ? "Entrée" : "Enter"})">
            ${iconSvg("ic-send", "ds-icon--xs")}
            <span>${esc(opts.submitLabel)}</span>
          </button>
          <button type="button" class="ds-split-btn__toggle" data-split-prompt-toggle aria-haspopup="menu" aria-expanded="false" aria-label="${esc(suggestedHeading)}" title="${esc(toggleLabel)}">
            <svg class="ds-icon ds-icon--md" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="ds-split-btn__menu" role="menu" aria-label="${esc(suggestedHeading)}">
            <div class="ds-menu__header">${esc(suggestedHeading)}</div>
            ${opts.quickPrompts
              .map(
                (qp) =>
                  `<button type="button" class="ds-menu__item" role="menuitem" data-quick-prompt="${esc(qp)}" data-target-input="${esc(opts.inputId)}">
                    ${iconSvg("ic-sparkle", "ds-icon--xs")}
                    <span>${esc(qp)}</span>
                  </button>`,
              )
              .join("")}
          </div>
        </div>`;

  const conversationAriaLabel =
    lang === "fr" ? "Conversation avec l'assistant" : "Conversation with assistant";
  const disclaimerText =
    lang === "fr"
      ? "Assistant IA d'aide à la préparation RCP (Règlement UE 2024/1689 Art. 50 · CSP Art. L. 4001-2) — Contenu généré par IA locale à titre strictement indicatif et non prescriptif ; vérifiez systématiquement les pièces sources. La décision médicale relève exclusivement du collège de la RCP."
      : "AI Assistant for MDT preparation (EU Regulation 2024/1689 Art. 50 · French CSP Art. L. 4001-2) — Local AI-generated content for informational, non-prescriptive support; systematically review source records. Medical decisions remain exclusively with the MDT board.";

  return `<form class="ds-chat" method="post" action="${esc(opts.formAction)}" data-ajax-chat="${esc(opts.logId)}" data-testid="${esc(opts.formTestId)}">
    ${hiddenInputsHtml}
    ${controlBarHtml}

    <!-- Full-height scrollable conversation viewport -->
    <ol class="ds-chat__log" id="${esc(opts.logId)}" aria-live="polite" aria-label="${esc(conversationAriaLabel)}">
      ${chatMessagesHtml}
    </ol>

    <!-- Template cloned immediately on submit to display the M3 AI Reflection Module -->
    <template data-chat-thinking-template>
      ${renderAiThinkingModule(undefined, lang)}
    </template>

    <!-- M3 Elevated Composer Dock with Unified M3 Primary Split Button (Send + Suggestions) -->
    <div class="ds-chat__composer">
      <span class="ds-chat__composer-icon" aria-hidden="true">${iconSvg("ic-chat", "ds-icon--sm")}</span>
      <label class="ds-sr-only" for="${esc(opts.inputId)}">${esc(opts.inputLabel)}</label>
      <textarea class="ds-textarea ds-chat__input" id="${esc(opts.inputId)}" name="question" rows="1" required placeholder="${esc(opts.inputPlaceholder)}" data-chat-enter-submit="true" data-testid="${esc(opts.inputTestId)}"></textarea>
      <div class="ds-chat__composer-actions">
        ${mergedSubmitSplitBtnHtml}
      </div>
    </div>
    <p class="ds-disclaimer ds-chat__disclaimer" data-testid="ai-chat-disclaimer">
      ${esc(disclaimerText)}
    </p>
  </form>`;
}

export interface AiChatDrawerOptions extends AiChatComponentOptions {
  drawerTitle?: string;
  drawerSubtitle?: string;
  fabLabel?: string;
}

/**
 * Renders the Material Design 3 Floating Extended FAB (`.ds-fab-menu`)
 * that directly opens the Full-Height Non-Blocking Co-Pilot Side Sheet (`.ds-copilot-drawer`)
 * using M3 spatial transitions (suggestions remain inside the drawer's merged Split Button).
 */
export function renderAiChatDrawer(opts: AiChatDrawerOptions): string {
  const lang = opts.lang ?? "fr";
  const defaultTitle = lang === "fr" ? "Assistant clinique" : "Clinical Assistant";
  const defaultFab = lang === "fr" ? "Assistant IA" : "AI Assistant";
  const title = opts.drawerTitle ?? defaultTitle;
  const subtitle = opts.drawerSubtitle ?? "";
  const fabLabel = opts.fabLabel ?? defaultFab;

  const resizerLabel =
    lang === "fr" ? "Redimensionner le panneau Assistant IA" : "Resize AI Assistant panel";
  const resizerTitle =
    lang === "fr"
      ? "Glisser pour ajuster la largeur (double-clic pour réinitialiser)"
      : "Drag to resize width (double-click to reset)";

  const expandLabel = lang === "fr" ? "Agrandir" : "Expand";
  const shrinkLabel = lang === "fr" ? "Réduire" : "Shrink";
  const sizeBtnAria =
    lang === "fr" ? "Agrandir le panneau Assistant IA" : "Expand AI Assistant panel";
  const sizeBtnTitle = lang === "fr" ? "Agrandir / Réduire la largeur" : "Expand / Shrink width";

  const closeAria =
    lang === "fr" ? "Replier le tiroir de l'assistant" : "Collapse assistant side sheet";
  const closeTitle =
    lang === "fr" ? "Replier le panneau latéral (Échap)" : "Collapse side panel (Esc)";
  const closeText = lang === "fr" ? "Replier" : "Collapse";

  return `
    <!-- Material Design 3 Floating Extended FAB (Directly Opens AI Co-Pilot Side Sheet) -->
    <div class="ds-fab-menu" id="ai-chat-fab" data-testid="ai-fab-menu">
      <button type="button" id="btn_fab_ai_chat" class="ds-fab-menu__trigger" data-action="open-chat-drawer" aria-controls="ai-chat-drawer" aria-expanded="false" aria-label="${esc(fabLabel)}" data-testid="btn_fab_ai_chat">
        <span class="ds-fab-menu__icon ds-fab-menu__icon--open" aria-hidden="true">${iconSvg("ic-sparkle", "ds-icon--md")}</span>
        <span class="ds-fab-menu__label">${esc(fabLabel)}</span>
      </button>
    </div>

    <!-- Material Design 3 Full-Height Non-Blocking Co-Pilot Side Sheet -->
    <aside class="ds-copilot-drawer" id="ai-chat-drawer" aria-label="${esc(title)}" aria-hidden="true" data-testid="ai-chat-drawer">
      <div class="ds-copilot-drawer__resizer" data-copilot-resizer role="separator" aria-orientation="vertical" tabindex="0" aria-label="${esc(resizerLabel)}" title="${esc(resizerTitle)}" data-testid="resizer_ai_chat"></div>
      <button type="button" class="ds-copilot-drawer__handle" data-action="close-chat-drawer" aria-label="${esc(closeAria)}" title="${esc(closeTitle)}">
        <svg class="ds-icon ds-icon--xs" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      <header class="ds-copilot-drawer__header">
        <div class="ds-copilot-drawer__title-group">
          <span class="ds-copilot-drawer__avatar" aria-hidden="true">${iconSvg("ic-sparkle", "ds-icon--sm")}</span>
          <div>
            <h2 class="ds-copilot-drawer__title">${esc(title)}</h2>
            ${subtitle ? `<p class="ds-copilot-drawer__subtitle">${esc(subtitle)}</p>` : ""}
          </div>
        </div>
        <div class="ds-copilot-drawer__actions">
          <button type="button" class="ds-copilot-drawer__size-btn" data-action="toggle-chat-size" aria-pressed="false" aria-label="${esc(sizeBtnAria)}" title="${esc(sizeBtnTitle)}" data-label-expand="${esc(expandLabel)}" data-label-shrink="${esc(shrinkLabel)}" data-testid="btn_expand_ai_chat">
            ${iconSvg("ic-expand", "ds-icon--xs")}
            <span data-chat-size-label>${esc(expandLabel)}</span>
          </button>
          <button type="button" class="ds-copilot-drawer__close-pill" data-action="close-chat-drawer" aria-label="${esc(closeAria)}" title="${esc(closeTitle)}" data-testid="btn_close_ai_chat">
            <svg class="ds-icon ds-icon--xs" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="3"/>
              <path d="M15 3v18"/>
              <path d="m8 9 3 3-3 3"/>
            </svg>
            <span>${esc(closeText)}</span>
          </button>
        </div>
      </header>
      <div class="ds-copilot-drawer__body">
        ${renderAiChatComponent(opts)}
      </div>
    </aside>`;
}
