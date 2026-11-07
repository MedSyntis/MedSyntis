# MedSyntis — Web Design System (`ds-*`)

> Pure CSS, framework-free, build-step-free, **100% self-hosted** (CSP `default-src 'self'`): zero CDNs, zero external fonts.
> Key files:
> - [`public/css/tokens.css`](../public/css/tokens.css): design tokens (CSS custom properties), Light and Dark themes
> - [`public/css/components.css`](../public/css/components.css): `ds-*` Material Design 3 components and SVG icon system
> - [`public/img/icons.svg`](../public/img/icons.svg): vector sprite of 73 Material Design 3 icons (`<symbol id="ic-…">`, `24×24` optical grid, `1.85px` rounded stroke)
> - [`public/js/app.js`](../public/js/app.js): dependency-free vanilla JS progressive enhancement (`fetch` partial updates with `HX-Request: true` + real-time `EventSource('/events/queue')` SSE streaming)
> - [`styleguide/index.html`](../styleguide/index.html): living styleguide with interactive icon catalog (`#tokens-icons`)
> - [`scripts/check-contrast.mjs`](../scripts/check-contrast.mjs): zero-dependency WCAG 2.2 token contrast checker (`node web/scripts/check-contrast.mjs`, exits with code 1 if any pair fails)

Brand source of truth: `application/.streamlit/config.toml` and `web/public/img/medsyntis-icon.svg`. This design system shares the same clinical color semantics across the Material Design 3 Web UI and the legacy Streamlit dashboard.

---

## 1. Core Principles

1. **Zero-friction clinical readability.** Every screen must be understood in one second for two hospital personas:
   - **MDT Physician / Specialist**: clinical urgency, pre-MDT orientation, synoptic clinical markers, longitudinal deltas since the previous MDT session, specialty opinions, and grounded citations.
   - **MDT Medical Secretary / Coordinator**: record completeness, missing clinical items, required specialties to convene, and patient identity.
2. **Sober and rigorous.** Matte stone canvas (`canvas`) to prevent visual glare on hospital monitors, elevated paper cards, and a single primary accent (clinical teal). No marketing tone.
3. **Never rely on color alone.** Every status combines **icon + text label + color** (WCAG 1.4.1). Longitudinal variations (deltas) include a directional arrow and a signed value.
4. **Rose has a strict semantic meaning.** It is exclusively reserved for 🚨 **High Priority** (`priority-high`) and **destructive actions** (`btn_del_` / `btn_danger_`). Never use rose elsewhere.
5. **Medico-legal neutrality.** MedSyntis prepares the multidisciplinary team meeting; it never makes clinical decisions. All orientations are phrased as non-prescriptive proposals (see § 6).
6. **The clinician has the final word.** Every manual edit is explicitly badged (✍️) with provenance and is never silently overwritten.
7. **KISS.** Semantic HTML and native browser states (`<dialog>`, `<details>`, `aria-*`, `:disabled`) come before custom classes. No JS is required for initial SSR rendering; [`public/js/app.js`](../public/js/app.js) provides dependency-free vanilla JS interactivity (`fetch` with `HX-Request: true` for partial DOM updates and `EventSource('/events/queue')` for live queue updates).

---

## 2. Design Tokens

All tokens use the `--ds-` prefix. Components consume **only semantic tokens** (`--ds-color-*`, `--ds-urgency-*`, etc.), never primitive palette variables (`--ds-teal-600`) or hardcoded hex values.

### 2.1 Theme Modes

| Mechanism | Effect |
| :--- | :--- |
| Default | Light theme |
| `<html data-theme="dark">` | Forced Dark theme |
| `<html data-theme="light">` | Forced Light theme (overrides OS preference) |
| `<html data-theme="auto">` or no attribute + OS in Dark mode | Automatic Dark theme (`prefers-color-scheme: dark`) |

The dark token block is **intentionally duplicated** (explicit attribute selector + media query) to remain compatible with older hospital browsers (without relying on `light-dark()`). Keep both blocks synchronized.

### 2.2 Colors (Contrast Ratios Computed per WCAG 2.x)

Normal text: ≥ 4.5:1 (AA). UI components, form field borders, focus rings: ≥ 3:1.

| Role | Token | Light | Dark | Contrast (Light / Dark) |
| :--- | :--- | :--- | :--- | :--- |
| Workspace canvas | `--ds-color-canvas` | `#E6ECF0` | `#0F172A` | — |
| Card surface | `--ds-color-surface` | `#FBFDFF` | `#162032` | — |
| Sunken surface | `--ds-color-surface-sunken` | `#F1F5F9` | `#111A2B` | — |
| Primary text | `--ds-color-text` | `#2A3647` | `#E2E8F0` | 11.99 / 13.24 on surface |
| Secondary text | `--ds-color-text-muted` | `#4A5A70` | `#A3B1C4` | 6.89 / 7.49 on surface, 5.90 / 8.20 on canvas |
| Subtle text | `--ds-color-text-subtle` | `#5F6E82` | `#8D9BB0` | 5.10 / 5.79 |
| Input border | `--ds-color-border-strong` | `#7A8799` | `#64748B` | 3.58 / 3.43 (UI) |
| Primary (clinical teal) | `--ds-color-primary` | `#467E79` | `#72A8A2` | button text: 4.65 (white) / 7.03 (`#0B1120`) |
| Link, active tab | `--ds-color-primary-text` | `#3A6B66` | `#88BDB7` | 5.93 / 7.78 on surface, 5.07 / 8.51 on canvas |
| Focus ring | `--ds-color-focus` | `#3B6E9C` | `#7FB2F0` | 4.52 / 8.10 on canvas (UI) |
| Success / compliance (sage) | `--ds-color-success-fg` / `-bg` | `#2E544A` / `#E6F1EE` | `#BFE3D6` / `#16362E` | 7.32 / 9.48 |
| Warning (amber) | `--ds-color-warning-fg` / `-bg` | `#7C4718` / `#FBF0E4` | `#FCD9A8` / `#43290F` | 6.74 / 10.00 |
| Danger (rose) | `--ds-color-danger` | `#B83B5E` | `#E11D48` | white text: 5.49 / 4.70 |
| Danger badge | `--ds-color-danger-fg` / `-bg` | `#882644` / `#F9E8EC` | `#FECDD6` / `#4A1424` | 7.39 / 10.53 |
| Info (clinical blue) | `--ds-color-info-fg` / `-bg` | `#234B6E` / `#E3EFF8` | `#DBEAFE` / `#1E3A5F` | 7.80 / 9.43 |
| Neutral | `--ds-color-neutral-fg` / `-bg` | `#3D4A5C` / `#E2E8EE` | `#CBD5E1` / `#273449` | 7.29 / 8.45 |
| 🧭 Care adaptation suggested | `--ds-orientation-adapt-fg` / `-bg` | `#2C5753` / `#E2EFED` | `#BCE0DB` / `#173A37` | 6.86 / 8.74 |
| ✍️ Manually edited | `--ds-manual-fg` / `-bg` | `#6E4F12` / `#FAF3E0` | `#F5DFA6` / `#3D3010` | 6.80 / 9.82 |
| Required specialty | `--ds-specialty-fg` / `-bg` | `#3B475C` / `#EAEFF5` | `#D3DCE8` / `#2A3548` | 8.10 / 8.92 |
| Oncology domain | `--ds-domain-onco-fg` / `-bg` | `#1F5470` / `#E1EEF5` | `#BFE0F0` / `#123247` | 6.93 / 9.62 |
| SMA domain | `--ds-domain-sma-fg` / `-bg` | `#56427A` / `#EFEAF6` | `#DCD0F0` / `#2E2447` | 7.24 / 9.81 |
| Navigation rail | `--ds-sidebar-bg` / `-text` | `#2B3748` / `#E8EEF3` | `#0B1120` / `#E2E8F0` | 10.30 / 15.27 |
| Table header | `--ds-table-header-bg` / `-text` | `#2B3748` / `#F1F5F9` | `#0B1120` / `#F8FAFC` | 11.00 / 18.00 |

Clinical semantic aliases:

| Clinical Meaning | Tokens | Maps To |
| :--- | :--- | :--- |
| High priority 🚨 | `--ds-urgency-high*` | danger (rose) |
| Medium priority 🟠 | `--ds-urgency-medium*` | warning (amber) |
| Standard priority 🟢 | `--ds-urgency-low*` | success (sage) |
| Not evaluated ⚪ | `--ds-urgency-none*` | neutral |
| Standard care / guideline-aligned ✅ | `--ds-orientation-standard*` | success |
| Care adaptation suggested 🧭 | `--ds-orientation-adapt*` | **primary teal (non-alarmist)** |
| To discuss / pending ⏳ | `--ds-orientation-pending*` | neutral |

### 2.3 Typography

System font stack `--ds-font-sans` (`system-ui`, `Segoe UI`, `Roboto`, `Noto Sans`, `Liberation Sans`, etc. + emoji fonts). Monospace stack: `--ds-font-mono`.

| Token | Size | Usage |
| :--- | :--- | :--- |
| `--ds-text-xs` | 12 px | Metadata, timestamps (never for body copy) |
| `--ds-text-sm` | 13 px | Dense tables, badges, buttons |
| `--ds-text-md` | 15 px | Body text |
| `--ds-text-lg` | 17 px | Section or card titles |
| `--ds-text-xl` | 20 px | `h2` headings |
| `--ds-text-2xl` | 24 px | Page title, patient name |
| `--ds-text-3xl` | 30 px | KPI values |

Font weights: 400 / 500 / 600 / 700. Tabular numerals (`font-variant-numeric: tabular-nums`) are enforced on tables, KPIs, and longitudinal deltas.

### 2.4 Spacing, Radii, Shadows, Z-Index & Motion

- **Spacing** (4 px grid): `--ds-space-1` (4 px) → `--ds-space-12` (48 px).
- **Border radii**: `sm` 4 px · `md` 6 px (buttons, inputs) · `lg` 8 px (cards) · `xl` 12 px (modals) · `pill` (badges).
- **Shadows**: `sm` (cards) · `md` (hover, synoptic card) · `lg` (modal, drawer, toast).
- **Z-index**: sticky 10 · sidebar 20 · topbar 30 · queue banner 40 · drawer 50 · modal 60 · toast 70.
- **Motion**: 120 / 200 / 320 ms with `--ds-ease`. Under `prefers-reduced-motion: reduce`, transition durations drop to 0, spinners slow down, and skeleton shimmer / typing dots stop animating.

---

## 3. Components

BEM naming convention: `.ds-block`, `.ds-block__element`, `.ds-block--modifier`. Interactive state relies on native HTML or ARIA attributes first.

| Component | Classes | State & Notes |
| :--- | :--- | :--- |
| App Shell & M3 Navigation Rail | `ds-shell`, `ds-sidebar`, `ds-nav-rail`, `ds-rail__fab`, `ds-nav__indicator`, `ds-main`, `ds-topbar`, `ds-workspace`, `ds-bottom-nav`, `ds-skip-link` | `aria-current="page"` on active navigation item. Rail collapses to `72px` (`body.ds-shell--sidebar-collapsed`). Below `48rem` (`768px`), renders mobile bottom navigation `ds-bottom-nav` + off-canvas drawer `ds-shell--mobile-nav-open`. |
| Live Queue Banner | `ds-queue-banner` (`--idle`, `--success`, `--error`, `--offline`), `__msg`, `__progress`, `__action` | `role="status" aria-live="polite" aria-atomic="true"`, updated live via `EventSource('/events/queue')` in [`public/js/app.js`](../public/js/app.js). Single-line layout. |
| GPU Queue Drawer | `<dialog class="ds-drawer">`, `__header`, `__body`, `__footer`, `ds-job` | Opened via `showModal()`; closed via `<form method="dialog">` or `Escape`. |
| AI Co-Pilot (Side Sheet) | `ds-fab-menu` (`btn_fab_ai_chat`), `<aside class="ds-copilot-drawer">` (`#ai-chat-drawer`), `ds-m3-select`, `ds-split-btn`, `ds-ai-thinking` | Full-height non-blocking side sheet. On mobile, synchronizes `--ds-vvh` with `window.visualViewport` and toggles `.is-keyboard-open` when the chat input is focused. |
| Next MDT Agenda Builder | `ds-agenda-item` (`--focused`, `--dimmed`), `ds-agenda-section-bar`, `ds-agenda-focus-bar`, `ds-agenda-dossier-nav`, `ds-agenda-onboarding` | Dynamic specialty highlighting (`data-focus-expert`), inter-dossier navigation bar (`← Dossier précédent` / `Dossier suivant →`), and meeting onboarding dialog. |
| Buttons | `ds-btn` + `--primary`, `--secondary`, `--tonal`, `--ghost`, `--danger-soft`, `--danger`; `--sm`, `--lg`, `--icon`, `--block` | Loading state: `aria-busy="true"` + `disabled`. Icon-only buttons require `aria-label`. |
| Badges | `ds-badge` + `--urgency-{high,medium,low,none}`, `--complete`, `--incomplete`, `--orientation-{standard,adapt,pending}`, `--specialty`, `--domain-{onco,sma}`, `--manual`, `--success`, `--warning`, `--danger`, `--info`, `--neutral`; `--sm`, `--outline`; `ds-badge-list` | SVG icon inside `<svg class="ds-icon" aria-hidden="true">`, label ≤ 24 characters. |
| Cards | `ds-card`, `__header`, `__title`, `__body`, `__footer`, `--interactive`, `--flush` | Equal-height cards in grid layouts; actions aligned in footer. |
| KPI Cards | `ds-kpi-grid`, `ds-kpi` (`--danger`, `--warning`, `--success`, `--info`), `__label`, `__value`, `__meta` | Clickable KPIs are `<a>` links pointing to the corresponding filtered view. |
| Synoptic Strip | `ds-synoptic` (sticky), `--static`, `__row`, `__label`, `ds-markers` (`dl`), `dd.is-missing` | Row 1: priority, completeness, orientation. Row 2: required specialties. Row 3: clinical markers and longitudinal deltas. |
| Longitudinal Delta | `ds-delta--better`, `--worse`, `--stable`, `--new` | Directional arrow + signed value + reference date. Clinical worsening uses **amber**, never rose. |
| Patient Header & Grid | `ds-patient-header`, `ds-patient-grid`, `ds-patient-card` (`--urgent`) | — |
| Data Table | `ds-table-wrap`, `ds-table` (`--dense`, `--comfortable`), `ds-sort`, `tr.is-urgent`, `ds-table__primary-link`, `__num`, `__actions` | Sorting via `<th aria-sort>` + `<button class="ds-sort">`. Sticky header. Includes `<caption>` (`ds-sr-only` when visually hidden). |
| Toolbar & Segmented Control | `ds-toolbar`, `ds-segmented` | Segmented controls use native radio inputs. |
| Form Controls | `ds-field`, `ds-label`, `ds-hint`, `ds-error-text`, `ds-input`, `ds-select`, `ds-textarea`, `ds-check`, `ds-toggle` | Validation error: `aria-invalid="true"` + `aria-describedby` pointing to `ds-error-text`. Switch: `<input type="checkbox" role="switch" class="ds-toggle">`. |
| PDF Dropzone | `ds-dropzone` (`.is-dragover`), `ds-file-list` | `<label>` wrapping `<input type="file" multiple accept="application/pdf" class="ds-sr-only">`: fully keyboard-accessible without JS. |
| Editable Clinical Section | `<details class="ds-section">` (`--manual`, `.is-editing`), `__title`, `__summary`, `__body`, `__actions`, `__duration`, `__provenance` | Collapsed by default with a 1-line summary in `<summary>`. Manually edited sections receive `--manual` + `ds-badge--manual` + provenance (author and timestamp) and are updated inline via `fetch` (`HX-Request: true`). |
| Alerts | `ds-alert` (`--success`, `--warning`, `--danger`, `--guidance`), `__icon`, `__title` | `role="alert"` only for blocking errors; otherwise `role="note"` or no live role. |
| Snackbars / Toasts | `ds-toast-region` (`role="status" aria-live="polite"`), `ds-toast` (`--success`, `--warning`, `--danger`) | Dismiss button with `aria-label`. Error toasts never auto-dismiss. |
| Tabs | `ds-tabs[role=tablist]`, `ds-tab[role=tab][aria-selected]`, `ds-tabpanel[role=tabpanel]` | Left/Right arrow navigation and roving `tabindex`. Link-based tabs use `aria-current="page"`. |
| Longitudinal Timeline | `ds-timeline`, `__item`, `__link` (`aria-current="step"`), `__marker--{high,medium,low}`, `__date`, `__meta` | Marker displays a glyph; meta displays a short status label. |
| Specialty Opinions | `<details class="ds-opinion">`, `ds-refs`, `ds-ref__source`, `ds-ref__quote`, `ds-disclaimer` | One accordion per specialty, ordered by relevance then urgency. |
| AI Chat Log | `ds-chat`, `__log` (`aria-live="polite"`), `__msg--user`, `__msg--assistant`, `__bubble`, `__typing`, `__composer` | Grounded PDF citations are rendered directly below the assistant bubble. |
| Progress & Stepper | `ds-progress` (`<progress>`, `--success`, `--danger`), `ds-progress-label`, `ds-stepper`, `ds-step--{done,active,error}` | `aria-label` with percentage; `aria-current="step"` on active step. |
| Confirmation Modal | `<dialog class="ds-modal">` (`--danger`, `--lg`), `__header`, `__body`, `__footer` | Initial focus on **Cancel** (`autofocus`). Uses `aria-labelledby` and `aria-describedby`. |
| Skeleton & Empty State | `ds-skeleton` (`--title`, `--block`, `--w-60`, `--w-80`), `ds-empty` | Loading container sets `aria-busy="true"`. Empty states always provide the next primary action. |
| Split View | `ds-split` (`--40-60`), `ds-split__pane` (`--sticky`), `ds-pdf-frame` | Collapses to a single column below `75rem`. PDFs are served from the same origin (CSP compliant). |
| Layout Utilities | `ds-stack` (`--sm`, `--lg`), `ds-cluster`, `ds-grid`, `ds-sr-only`, `ds-muted`, `ds-small`, `ds-mono`, `ds-nowrap` | — |

### Destructive Actions

| Step | Class | `data-testid` | Visual Style |
| :--- | :--- | :--- | :--- |
| Trigger button (opens confirmation dialog) | `ds-btn--danger-soft` | `btn_del_<object>_<id>` | Rose outline and rose text |
| Irreversible confirmation (inside `<dialog class="ds-modal ds-modal--danger">`) | `ds-btn--danger` | `btn_danger_<action>` | Solid rose fill |

The confirmation dialog always contains a `ds-alert--danger` detailing what will be permanently deleted, with an explicit action label (`Supprimer définitivement`, never `OK`).

### `data-testid` Conventions

Stable `snake_case` or `kebab-case` identifiers without real patient data: `kpi-priority-high`, `worklist-row-<id>`, `badge-orientation-adapt`, `section-<key>`, `btn_edit_section_<key>`, `btn_del_…`, `btn_danger_…`, `queue-banner`, `queue-drawer`.

---

## 4. Do / Don't

| ✅ Do | ❌ Don't |
| :--- | :--- |
| Render `🧭 Adaptation suggérée` in neutral clinical teal | Render care orientation in red/rose or label it "Non-compliant" |
| Render `🚨 Priorité haute` in rose with outline | Use rose for links, active tabs, or non-urgent KPIs |
| Combine SVG icon + text label + color | Use a color dot alone or colored text alone |
| Keep badge labels ≤ 24 characters (details in tooltip/panel) | Put a full sentence inside a badge |
| Display `"Non renseigné"` in subtle italic | Display `"Not documented in record"`, `"null"`, or `"N/A"` |
| Use short specialty names (`🧠 Neurologie`) | Use `"Expert neurologue"` or detective emojis (`🕵️`) |
| Render checkmarks (`✓`) in sage green | Render `✓` on a red or rose background |
| Require two-step confirmation (`btn_del_` → `btn_danger_`) | Trigger destructive deletion in a single click |
| Reference semantic CSS tokens (`var(--ds-*)`) | Hardcode hex colors in templates |
| Use system fonts and self-hosted assets under `/public` | Load Google Fonts, external CDNs, or remote icon scripts |

---

## 5. Accessibility Checklist (WCAG 2.2 AA)

- [ ] Contrast ratios: `node web/scripts/check-contrast.mjs` passes (normal text ≥ 4.5:1, UI ≥ 3:1) in both Light and Dark themes.
- [ ] `:focus-visible` is always clearly visible (2 px `--ds-color-focus` ring with offset); never apply `outline: none` without a replacement focus indicator.
- [ ] Skip link `ds-skip-link` targets `<main id="main">`.
- [ ] Landmarks: `<aside>` or `<nav>` with `aria-label`, `<header>`, `<main>`; a single logical heading hierarchy per page.
- [ ] Status indicators never rely on color alone; decorative icons have `aria-hidden="true"` next to readable text.
- [ ] Queue banner uses `role="status"` + `aria-live="polite"`. Never use `assertive` except for blocking errors.
- [ ] Native dialogs (`<dialog>` + `showModal()`) handle focus trapping, `Escape` dismissal, and focus restoration natively.
- [ ] Tabs implement ARIA `tablist` / `tab` / `tabpanel` roles, `aria-selected`, and Left/Right arrow key navigation.
- [ ] Tables include `<caption>`, `<th scope>`, and announce sorting via `aria-sort`.
- [ ] Forms associate every input with a `<label>` and link validation errors via `aria-describedby` + `aria-invalid`.
- [ ] Icon-only buttons provide an explicit `aria-label` naming the target object (e.g., `"Supprimer le dossier de …"`).
- [ ] Interactive targets measure at least 24 × 24 px (`--sm` buttons are at least 30 px tall).
- [ ] Layouts remain readable at 200% browser zoom and 320 px viewport width (no horizontal scrolling outside data tables).
- [ ] `prefers-reduced-motion` is respected across all animations.
- [ ] `<html lang="fr">` or `<html lang="en">` matches the active interface language.

---

## 6. Medico-Legal Wording Rules

MedSyntis is a **clinical decision-preparation assistant** for Multidisciplinary Team Meetings (RCP / MDT). The therapeutic decision belongs exclusively to the medical board. All UI terminology must reflect this non-prescriptive positioning.

| Clinical Context | Recommended Wording | Prohibited Wording |
| :--- | :--- | :--- |
| Orientation aligned with guidelines | `✅ Suivi habituel` / `Conforme au référentiel` | `"Traitement validé"`, `"Décision"` |
| Potential deviation from guidelines | `🧭 Adaptation suggérée` · `"à discuter en RCP"` | `"Non conforme"`, `"Hors recommandations"`, `"Erreur"`, red/rose color |
| Insufficient clinical data | `⏳ À discuter en RCP` · `⚠️ Données insuffisantes` | `"Impossible"`, `"Refusé"` |
| AI specialty agent proposal | `"Proposition 1 — Discuter…"`, `"Envisager…"` | `"Prescrire"`, `"Il faut"`, `"Le patient doit"` |
| Case priority | `🚨 Priorité haute` · `"à présenter en premier"` | `"Urgence vitale"` (clinical qualification reserved for physicians) |
| Missing record item | `⚠️ 2 pièces manquantes` (factual list) | `"Dossier invalide"` |
| Medico-legal footer disclaimer | `"Proposition d'aide à la préparation de la RCP générée localement. La décision thérapeutique appartient exclusivement au collège médical de la RCP."` | — |
| Human-in-the-loop edit | `✍️ Modifié manuellement` · `"Modifié par Dr X le JJ/MM/AAAA à HH:MM"` | Silent overwrite without provenance |

Additional rules:

- Always **cite the source** (guideline + section, or source PDF + page) beneath any AI proposal (`ds-refs`).
- Format dates as `DD/MM/YYYY` in French (`YYYY-MM-DD` in ISO/English contexts) and include clinical units (`412 U/mL`).
- Never include real patient names or hospital identifiers in the styleguide, tests, or screenshots. Use explicit fictitious names (`FICTIVE`, `EXEMPLE`, `MODÈLE`).
