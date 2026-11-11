import { tr } from "../../domain/i18n.js";
import type { UserSession } from "../../domain/types.js";
import {
  ASSET_VERSION,
  esc,
  html,
  INLINE_ICONS_SVG,
  iconSvg,
  raw,
  stripDomainQuery,
} from "./html.js";

export type StatusKind = "not_found" | "forbidden" | "maintenance" | "server_error";

export interface StatusPageOptions {
  statusCode: number;
  kind?: StatusKind;
  title?: string;
  message?: string;
  retryHref?: string;
  session: UserSession;
}

interface StatusMeta {
  badgeVariant: "danger" | "warning" | "info";
  badgeIcon: string;
  heroIcon: string;
  badgeFr: string;
  badgeEn: string;
  titleFr: string;
  titleEn: string;
  msgFr: string;
  msgEn: string;
  showRetry: boolean;
}

const STATUS_META: Record<StatusKind, StatusMeta> = {
  forbidden: {
    badgeVariant: "danger",
    badgeIcon: "ic-lock",
    heroIcon: "ic-lock",
    badgeFr: "Accès restreint",
    badgeEn: "Restricted Access",
    titleFr: "Accès réservé aux administrateurs",
    titleEn: "Administrator access required",
    msgFr:
      "Cette action destructive ou de supervision est réservée aux comptes administrateurs habilités.",
    msgEn:
      "This destructive or administrative action is restricted to authorized administrator accounts.",
    showRetry: false,
  },
  not_found: {
    badgeVariant: "warning",
    badgeIcon: "ic-warning",
    heroIcon: "ic-folder-open",
    badgeFr: "Page introuvable",
    badgeEn: "Page Not Found",
    titleFr: "Page ou dossier introuvable",
    titleEn: "Page or record not found",
    msgFr: "L'adresse demandée n'existe pas ou le dossier clinique a été déplacé.",
    msgEn: "The requested URL does not exist or the clinical record has been moved.",
    showRetry: false,
  },
  maintenance: {
    badgeVariant: "info",
    badgeIcon: "ic-clock",
    heroIcon: "ic-clock",
    badgeFr: "Maintenance en cours",
    badgeEn: "Scheduled Maintenance",
    titleFr: "Plateforme en cours de maintenance",
    titleEn: "Platform under maintenance",
    msgFr:
      "Une mise à jour ou une maintenance technique est en cours. Vos dossiers patients et analyses RCP locales sont intégralement préservés.",
    msgEn:
      "A system update or maintenance is in progress. Your local patient records and MDT analyses remain safely preserved.",
    showRetry: true,
  },
  server_error: {
    badgeVariant: "danger",
    badgeIcon: "ic-error",
    heroIcon: "ic-error",
    badgeFr: "Incident technique",
    badgeEn: "Server Error",
    titleFr: "Service temporairement indisponible",
    titleEn: "Service temporarily unavailable",
    msgFr:
      "Une erreur interne est survenue lors du traitement de la requête. Veuillez réessayer dans quelques instants ou revenir à l'accueil.",
    msgEn:
      "An internal error occurred while processing your request. Please try again in a moment or return to the home page.",
    showRetry: true,
  },
};

function resolveStatusKind(statusCode: number, explicitKind?: StatusKind): StatusKind {
  if (explicitKind) return explicitKind;
  if (statusCode === 403) return "forbidden";
  if (statusCode === 404) return "not_found";
  if (statusCode === 503) return "maintenance";
  return "server_error";
}

export function renderStatusPage(opts: StatusPageOptions): string {
  const { statusCode, session } = opts;
  const lang = session.language;
  const kind = resolveStatusKind(statusCode, opts.kind);
  const meta = STATUS_META[kind];
  const domainParam = encodeURIComponent(session.domain);
  const homeHref = session.hostBoundDomain ? "/worklist" : `/worklist?domain=${domainParam}`;

  const badgeCode =
    kind === "forbidden"
      ? 403
      : kind === "not_found"
        ? 404
        : kind === "maintenance"
          ? 503
          : statusCode;
  const badgeHtml = html`<span class="ds-badge ds-badge--${meta.badgeVariant}">${raw(iconSvg(meta.badgeIcon))} ${badgeCode} · ${tr(lang, meta.badgeFr, meta.badgeEn)}</span>`;
  const title = opts.title ?? tr(lang, meta.titleFr, meta.titleEn);
  const message = opts.message ?? tr(lang, meta.msgFr, meta.msgEn);
  const domainSubtitle =
    session.domain === "sma"
      ? tr(lang, "RCP Maladies Rares · SMA", "Rare Diseases MDT · SMA")
      : tr(lang, "RCP Oncologie Digestive", "Digestive Oncology MDT");

  const contrastPref = session.contrast ?? "auto";

  const pageHtml = html`<!doctype html>
<html lang="${lang}" data-theme="${session.theme}" data-theme-pref="${session.theme}" data-contrast="${contrastPref}" data-contrast-pref="${contrastPref}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} (${statusCode}) — MedSyntis</title>
  <link rel="icon" href="/public/img/medsyntis-icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/public/css/tokens.css?v=${ASSET_VERSION}">
  <link rel="stylesheet" href="/public/css/components.css?v=${ASSET_VERSION}">
</head>
<body class="ds-shell" style="min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:var(--ds-space-6)">
  ${raw(INLINE_ICONS_SVG)}
  <main id="main" style="width:100%;max-width:34rem">
    <section class="ds-card" style="padding:var(--ds-space-6);text-align:center;align-items:center;gap:var(--ds-space-4)" data-testid="status-page-${statusCode}">
      <a class="ds-brand" href="${raw(homeHref)}" style="justify-content:center;margin-bottom:var(--ds-space-1)">
        <img class="ds-brand__logo" src="/public/img/medsyntis-icon.svg" alt="" width="36" height="36">
        <span class="ds-brand__text" style="text-align:left">
          <span class="ds-brand__name">Med<b>Syntis</b></span>
          <span class="ds-brand__domain">${domainSubtitle}</span>
        </span>
      </a>
      <div>${raw(badgeHtml)}</div>
      <div class="ds-empty__icon" style="margin-inline:auto">${raw(iconSvg(meta.heroIcon, "ds-icon--lg"))}</div>
      <h1 style="font-size:var(--ds-text-xl);margin:0">${title}</h1>
      <p class="ds-muted" style="margin:0;max-width:28rem;line-height:1.5">${message}</p>
      <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:var(--ds-space-3);margin-top:var(--ds-space-2)">
        <a class="ds-btn ds-btn--primary" href="${raw(homeHref)}" data-testid="btn_status_home">
          ${raw(iconSvg("ic-worklist"))} ${tr(lang, "Retour à l'accueil", "Back to home")}
        </a>
        ${raw(
          meta.showRetry
            ? `<a class="ds-btn ds-btn--tonal" href="${esc(opts.retryHref || "/")}" data-testid="btn_status_retry">
                 ${iconSvg("ic-refresh")} ${tr(lang, "Réessayer", "Retry")}
               </a>`
            : "",
        )}
      </div>
    </section>
  </main>
</body>
</html>`;

  return session.hostBoundDomain ? stripDomainQuery(pageHtml) : pageHtml;
}
