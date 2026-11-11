import crypto from "node:crypto";
import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyMultipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { MedsyntisApiPort } from "../application/ports/medsyntis-api.port.js";
import { AgendaUseCase } from "../application/use-cases/agenda.use-case.js";
import { FeedbackUseCase } from "../application/use-cases/feedback.use-case.js";
import { GuidelinesUseCase } from "../application/use-cases/guidelines.use-case.js";
import { IngestUseCase } from "../application/use-cases/ingest.use-case.js";
import { PatientDossierUseCase } from "../application/use-cases/patient-dossier.use-case.js";
import { QueueAdminUseCase } from "../application/use-cases/queue-admin.use-case.js";
import { WorklistUseCase } from "../application/use-cases/worklist.use-case.js";
import type { WebAppConfig } from "../config.js";
import type {
  ClinicalDomain,
  ContrastMode,
  Language,
  ThemeMode,
  UserSession,
} from "../domain/types.js";
import { bffRequestContext } from "../infrastructure/api/http-medsyntis-api.adapter.js";
import {
  AgendaEnrollBodySchema,
  AgendaMoveBodySchema,
  AgendaOptionsBodySchema,
  AgendaScheduleBodySchema,
  ChatBodySchema,
  FeedbackCreateBodySchema,
  FeedbackStatusBodySchema,
  MissingItemsBodySchema,
  normalizeFormStringList,
  PreferencesBodySchema,
  parseWorklistFilter,
  QueueCleanBodySchema,
} from "../infrastructure/validation/schemas.js";
import {
  renderAgendaPage,
  renderAgentsPage,
  renderChatLogMessagePartial,
  renderDossierPage,
  renderFeedbackPage,
  renderGuidelinesPage,
  renderIngestPage,
  renderQueueAdminPage,
  renderQueueBannerPartial,
  renderQueueNavBadges,
  renderSectionDetailsPartial,
  renderStatusPage,
  renderWorklistPage,
  stripDomainQuery,
} from "./templates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../public");
const STYLEGUIDE_PATH = path.resolve(__dirname, "../../styleguide/index.html");

const SAFE_IDENTIFIER_RE = /^[\p{L}\p{N}._\-\s()[\]+@'’–—§,;:°%]+$/u;

export function verifyProxySecret(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export function sanitizeLocalRedirect(
  rawReferer: string | undefined,
  fallback = "/worklist",
): string {
  if (!rawReferer) return fallback;
  try {
    if (rawReferer.startsWith("/")) {
      if (rawReferer.startsWith("//") || rawReferer.startsWith("/\\")) return fallback;
      return rawReferer;
    }
    const parsed = new URL(rawReferer);
    const candidate = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\")) {
      return fallback;
    }
    return candidate;
  } catch {
    return fallback;
  }
}

export function isSafeFilename(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return false;
  }
  return SAFE_IDENTIFIER_RE.test(name);
}

export function sanitizeContentDispositionFilename(name: string): string {
  const cleaned = path
    .basename(String(name || "document.pdf"))
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, "_")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u0153/g, "oe")
    .replace(/\u0152/g, "OE")
    .replace(/\u00E6/g, "ae")
    .replace(/\u00C6/g, "AE")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/["\\\r\n\0]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .trim();
  return cleaned || "document.pdf";
}

const PUBLIC_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const gunzipAsync = promisify(zlib.gunzip);
const gunzipCache = new Map<string, Buffer>();
const staticAssetCache = new Map<string, { mtimeMs: number; etag: string; content: Buffer }>();
let styleguideHtmlCache: { mtimeMs: number; html: string } | null = null;

async function fileStatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function sendPdfBufferWithRange(
  req: FastifyRequest,
  reply: FastifyReply,
  buf: Buffer,
  filename: string,
) {
  const etag = `"pdf-${buf.byteLength}-${crypto.createHash("sha1").update(buf.subarray(0, 4096)).digest("hex").slice(0, 16)}"`;
  reply.header("Content-Type", "application/pdf");
  reply.header("Accept-Ranges", "bytes");
  reply.header("ETag", etag);
  reply.header(
    "Content-Disposition",
    `inline; filename="${sanitizeContentDispositionFilename(filename)}"`,
  );

  if (req.headers["if-none-match"] === etag) {
    return reply.code(304).send();
  }

  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = Number.parseInt(parts[0] ?? "0", 10);
    const end = parts[1] ? Number.parseInt(parts[1], 10) : buf.byteLength - 1;
    if (
      !Number.isNaN(start) &&
      !Number.isNaN(end) &&
      start >= 0 &&
      end < buf.byteLength &&
      start <= end
    ) {
      const chunk = buf.subarray(start, end + 1);
      reply.header("Content-Range", `bytes ${start}-${end}/${buf.byteLength}`);
      reply.header("Content-Length", String(chunk.byteLength));
      return reply.code(206).send(chunk);
    }
  }

  reply.header("Content-Length", String(buf.byteLength));
  return reply.send(buf);
}

export interface BuildServerOptions {
  config: WebAppConfig;
  api: MedsyntisApiPort;
}

export async function buildServer({ config, api }: BuildServerOptions): Promise<FastifyInstance> {
  const isTestEnv = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
  const app = Fastify({
    logger:
      config.devMode || isTestEnv
        ? false
        : {
            level: "info",
            serializers: {
              req(req) {
                return {
                  method: req.method,
                  url: String(req.url || "").split("?")[0],
                  remoteAddress: req.ip,
                };
              },
            },
          },
  });

  function hasVerifiedProxySecret(req: FastifyRequest): boolean {
    const providedSecret =
      (req.headers["x-medsyntis-proxy-secret"] as string | undefined) ||
      (req.headers["x-proxy-secret"] as string | undefined);
    return Boolean(config.proxySecret) && verifyProxySecret(providedSecret, config.proxySecret);
  }

  // Callback-style AsyncLocalStorage isolation wrapping ALL routes (prevents HTTP keep-alive context bleed)
  app.addHook("onRequest", (req, _reply, done) => {
    const requestId = String(req.headers["x-request-id"] || "").trim() || crypto.randomUUID();
    const proxyMatched = hasVerifiedProxySecret(req);
    const trustedRealIp = proxyMatched ? String(req.headers["x-real-ip"] || "").trim() : "";
    const forwardedIp = proxyMatched
      ? String(req.headers["x-forwarded-for"] || "")
          .split(",")[0]
          ?.trim() || ""
      : "";
    const clientIp = trustedRealIp || req.ip || forwardedIp || "127.0.0.1";
    bffRequestContext.run({ clientIp, requestId }, done);
  });

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 52_428_800, // 50 MB
      files: 20,
    },
  });

  // Hardened canonical async static asset server for /public/* (non-blocking I/O + ETag cache)
  app.get("/public/*", async (req, reply) => {
    const wildcard = ((req.params as Record<string, string>)["*"] ?? "").replace(/^\/+/, "");
    if (!wildcard || wildcard.includes("\0") || wildcard.includes("..")) {
      return reply.code(400).send("Chemin statique invalide");
    }
    const resolved = path.resolve(PUBLIC_DIR, wildcard);
    if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
      return reply.code(403).send("Accès interdit");
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime = PUBLIC_MIME_TYPES[ext];
    if (!mime) {
      return reply.code(404).send("Ressource statique introuvable");
    }
    const st = await fileStatOrNull(resolved);
    if (st) {
      let cached = staticAssetCache.get(resolved);
      if (!cached || cached.mtimeMs !== st.mtimeMs) {
        const content = await fsp.readFile(resolved);
        const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
        cached = { mtimeMs: st.mtimeMs, etag, content };
        staticAssetCache.set(resolved, cached);
      }
      reply.header("Content-Type", mime);
      reply.header("ETag", cached.etag);
      reply.header("Cache-Control", "no-store, max-age=0");
      if (req.headers["if-none-match"] === cached.etag) {
        return reply.code(304).send();
      }
      return reply.send(cached.content);
    }
    const gzResolved = `${resolved}.gz`;
    const gzStat = await fileStatOrNull(gzResolved);
    if (gzStat) {
      let unzipped = gunzipCache.get(gzResolved);
      if (!unzipped) {
        const gzBuf = await fsp.readFile(gzResolved);
        unzipped = await gunzipAsync(gzBuf);
        gunzipCache.set(gzResolved, unzipped);
      }
      reply.header("Content-Type", mime);
      reply.header("Cache-Control", "public, max-age=86400");
      return reply.send(unzipped);
    }
    return reply.code(404).send("Ressource statique introuvable");
  });

  function isProxyTrusted(req: FastifyRequest): boolean {
    return config.proxySecret ? hasVerifiedProxySecret(req) : config.devMode !== false;
  }

  function detectHostDomain(
    req: FastifyRequest,
    trustProxyHeaders: boolean,
  ): ClinicalDomain | undefined {
    const headerDomain = trustProxyHeaders
      ? (req.headers["x-medsyntis-domain"] as string | undefined)?.trim().toLowerCase()
      : undefined;
    if (headerDomain === "sma" || headerDomain === "oncology") {
      return headerDomain;
    }
    const rawHost =
      String(req.headers.host || "")
        .split(",")[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (rawHost.startsWith("sma.") || rawHost.startsWith("sma-")) {
      return "sma";
    }
    if (
      rawHost.startsWith("oncologic.") ||
      rawHost.startsWith("oncologic-") ||
      rawHost.startsWith("oncology.") ||
      rawHost.startsWith("oncology-")
    ) {
      return "oncology";
    }
    return undefined;
  }

  function validateStateChangingCsrf(req: FastifyRequest): string | null {
    const methodUpper = req.method.toUpperCase();
    if (
      methodUpper !== "POST" &&
      methodUpper !== "PUT" &&
      methodUpper !== "PATCH" &&
      methodUpper !== "DELETE"
    ) {
      return null;
    }
    const secFetchSite = String(req.headers["sec-fetch-site"] ?? "")
      .trim()
      .toLowerCase();
    if (secFetchSite === "cross-site") {
      return "Requête cross-site refusée (CSRF).";
    }
    const rawOrigin = req.headers.origin;
    if (typeof rawOrigin !== "string" || rawOrigin.trim().length === 0) {
      return null;
    }
    const trimmedOrigin = rawOrigin.trim();
    if (trimmedOrigin.toLowerCase() === "null") {
      // Browsers serialize Origin as "null" on native <form method="post"> when Referrer-Policy is "no-referrer".
      // Accept it only when the browser-controlled Fetch Metadata header attests exact same-origin initiation.
      return secFetchSite === "same-origin" ? null : "En-tête Origin invalide (CSRF).";
    }
    let originHost = "";
    try {
      originHost = new URL(trimmedOrigin).host.toLowerCase();
    } catch {
      return "En-tête Origin invalide (CSRF).";
    }
    const expectedHost =
      String(req.headers.host ?? "")
        .split(",")[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (!originHost || !expectedHost || originHost !== expectedHost) {
      return "Origine non autorisée (CSRF).";
    }
    return null;
  }

  // Zero-Trust Proxy Secret Verification + State-Changing CSRF Guard
  app.addHook("onRequest", async (req, reply) => {
    const csrfError = validateStateChangingCsrf(req);
    if (csrfError) {
      return reply.code(403).type("text/plain; charset=utf-8").send(csrfError);
    }

    if (req.url === "/health" || req.url.startsWith("/public/")) {
      return;
    }

    if (config.authMode === "oauth_proxy") {
      if (!hasVerifiedProxySecret(req)) {
        return reply
          .code(403)
          .type("text/plain; charset=utf-8")
          .send("Accès refusé : secret proxy invalide.");
      }
    }
    // Strip redundant ?domain=... query parameter when domain is determined by hostname
    if (req.method === "GET" && req.url.includes("domain=")) {
      const hostDomain = detectHostDomain(req, isProxyTrusted(req));
      if (hostDomain) {
        const cleanUrl = stripDomainQuery(req.url);
        if (cleanUrl !== req.url) {
          return reply.redirect(cleanUrl);
        }
      }
    }
  });

  // Strict Hospital-Grade HTTP Security Headers (100% self-hosted)
  app.addHook("onSend", async (req, reply, payload) => {
    const isStyleguide = req.url.startsWith("/styleguide");
    const isPdfFile = req.url.startsWith("/files/");
    if (!reply.getHeader("content-security-policy")) {
      const scriptSrc = isStyleguide ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
      reply.header(
        "Content-Security-Policy",
        `default-src 'self'; style-src 'self' 'unsafe-inline'; ${scriptSrc}; worker-src 'self' blob:; img-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`,
      );
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", isPdfFile ? "SAMEORIGIN" : "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    if (!config.devMode) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (!req.url.startsWith("/public/") && !reply.getHeader("cache-control")) {
      reply.header("Cache-Control", "no-store, max-age=0");
    }

    const hostDomain = !req.url.startsWith("/public/")
      ? detectHostDomain(req, isProxyTrusted(req))
      : undefined;
    if (hostDomain) {
      const loc = reply.getHeader("location");
      if (typeof loc === "string" && loc.includes("domain=")) {
        reply.header("Location", stripDomainQuery(loc));
      }
      if (typeof payload === "string" && payload.includes("domain")) {
        return stripDomainQuery(payload);
      }
    }
    return payload;
  });

  const worklistUseCase = new WorklistUseCase(api);
  const agendaUseCase = new AgendaUseCase(api);
  const dossierUseCase = new PatientDossierUseCase(api);
  const ingestUseCase = new IngestUseCase(api);
  const guidelinesUseCase = new GuidelinesUseCase(api);
  const feedbackUseCase = new FeedbackUseCase(api);
  const queueAdminUseCase = new QueueAdminUseCase(api);

  function resolveSession(req: FastifyRequest): UserSession {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const cookies = req.cookies ?? {};

    const trustIdentityHeaders = isProxyTrusted(req);

    const hostDomain = detectHostDomain(req, trustIdentityHeaders);
    const rawDomain = (
      hostDomain ||
      query.domain ||
      cookies.ds_domain ||
      config.defaultDomain
    ).toLowerCase();
    const domain: ClinicalDomain =
      rawDomain === "sma" && config.allowedDomains.includes("sma") ? "sma" : "oncology";

    const rawLang = (query.lang || cookies.ds_lang || config.defaultLanguage).toLowerCase();
    const language: Language = rawLang === "en" ? "en" : "fr";

    const rawTheme = (query.theme || cookies.ds_theme || config.defaultTheme).toLowerCase();
    const theme: ThemeMode = rawTheme === "dark" ? "dark" : rawTheme === "light" ? "light" : "auto";

    const rawContrast = (query.contrast || cookies.ds_contrast || "auto").toLowerCase();
    const contrast: ContrastMode =
      rawContrast === "high" ? "high" : rawContrast === "standard" ? "standard" : "auto";

    const expertMode = cookies.ds_expert === "true" || query.expert === "true";

    const headerUser = trustIdentityHeaders
      ? (req.headers["x-auth-request-preferred-username"] as string | undefined) ||
        (req.headers["x-auth-request-user"] as string | undefined) ||
        (req.headers["x-forwarded-user"] as string | undefined) ||
        (req.headers["x-medsyntis-user"] as string | undefined)
      : undefined;
    const headerEmailOrName = trustIdentityHeaders
      ? (req.headers["x-medsyntis-user-name"] as string | undefined) ||
        (req.headers["x-auth-request-email"] as string | undefined) ||
        (req.headers["x-forwarded-email"] as string | undefined) ||
        headerUser
      : undefined;

    const userId = String(headerUser || "dr.local")
      .trim()
      .slice(0, 128);
    const userName = String(headerEmailOrName || "Dr A. Exemple (Local)")
      .trim()
      .slice(0, 128);

    const store = bffRequestContext.getStore();
    if (store) {
      store.userId = userId;
      store.userName = userName;
    }

    const adminList = config.adminUsers ?? [];
    const isExplicitAdmin =
      adminList.includes(userId.toLowerCase()) || adminList.includes(userName.toLowerCase());
    const isAdmin = adminList.length === 0 ? Boolean(config.devMode) : isExplicitAdmin;

    return {
      userId,
      userName,
      isAdmin,
      domain,
      hostBoundDomain: Boolean(hostDomain),
      allowedDomains: config.allowedDomains,
      language,
      theme,
      contrast,
      expertMode,
    };
  }

  async function loadShellQueue(domain: ClinicalDomain, isAdmin: boolean) {
    const allDomains = Boolean(isAdmin);
    const [queueStats, queueJobs] = await Promise.all([
      api.getQueueStats(domain, allDomains),
      api.listQueueJobs(domain, allDomains),
    ]);
    return { queueStats, queueJobs };
  }

  // 1. Root & Styleguide
  app.get("/", async (_req, reply) => {
    return reply.redirect("/worklist");
  });

  app.get("/health", async () => {
    return { status: "ok", service: "medsyntis-web" };
  });

  app.get("/styleguide", async (_req, reply) => {
    const st = await fileStatOrNull(STYLEGUIDE_PATH);
    if (!styleguideHtmlCache || (st && styleguideHtmlCache.mtimeMs !== st.mtimeMs)) {
      const rawHtml = await fsp.readFile(STYLEGUIDE_PATH, "utf8");
      styleguideHtmlCache = {
        mtimeMs: st?.mtimeMs ?? Date.now(),
        html: rawHtml.replace(/\.\.\/public\//g, "/public/"),
      };
    }
    return reply.type("text/html; charset=utf-8").send(styleguideHtmlCache.html);
  });

  // 2. Preferences (Theme, Language, Domain, Expert Mode)
  app.post("/preferences", async (req, reply) => {
    const body = PreferencesBodySchema.parse(req.body ?? {});
    const cookieOpts = {
      path: "/",
      httpOnly: false,
      sameSite: "lax" as const,
      secure: config.devMode === false,
    };

    if (body.theme) {
      reply.setCookie("ds_theme", body.theme, cookieOpts);
    }
    if (body.contrast) {
      reply.setCookie("ds_contrast", body.contrast, cookieOpts);
    }
    if (body.language) {
      reply.setCookie("ds_lang", body.language, cookieOpts);
    }
    if (body.domain) {
      reply.setCookie("ds_domain", body.domain, cookieOpts);
    }
    if (body.expertMode) {
      reply.setCookie("ds_expert", body.expertMode, cookieOpts);
    }

    if (
      req.headers["hx-request"] === "true" &&
      (body.theme || body.contrast) &&
      !body.domain &&
      !body.language
    ) {
      return reply.code(204).send();
    }

    if (body.domain) {
      return reply.redirect(`/worklist?domain=${encodeURIComponent(body.domain)}`);
    }
    return reply.redirect(sanitizeLocalRedirect(req.headers.referer, "/worklist"));
  });

  // 3. Worklist
  app.get("/worklist", async (req, reply) => {
    const session = resolveSession(req);
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    if (query.domain === "oncology" || query.domain === "sma") {
      reply.setCookie("ds_domain", query.domain, {
        path: "/",
        sameSite: "lax",
        secure: config.devMode === false,
      });
    }

    const isMobileUa =
      req.headers["sec-ch-ua-mobile"] === "?1" ||
      /Mobile|Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(
        String(req.headers["user-agent"] || ""),
      );
    const defaultDisplay = isMobileUa ? "cards" : "table";

    const filter = parseWorklistFilter(req.query, session.domain, defaultDisplay);

    const [view, { queueStats, queueJobs }] = await Promise.all([
      worklistUseCase.execute(session.domain, filter),
      loadShellQueue(session.domain, session.isAdmin),
    ]);

    const html = renderWorklistPage(view, session, queueStats, queueJobs);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/patients/:patientId/delete", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply
        .code(403)
        .type("text/plain; charset=utf-8")
        .send("Accès réservé aux administrateurs.");
    }
    const { patientId } = req.params as { patientId: string };
    if (patientId.toLowerCase().endsWith(".pdf")) {
      await worklistUseCase.deleteForm(patientId, session.domain);
    } else {
      await worklistUseCase.deletePatient(patientId, session.domain);
    }
    return reply.redirect(`/worklist?domain=${encodeURIComponent(session.domain)}`);
  });

  app.delete("/patients/:patientId", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply.code(403).send({ ok: false, error: "Accès réservé aux administrateurs." });
    }
    const { patientId } = req.params as { patientId: string };
    if (patientId.toLowerCase().endsWith(".pdf")) {
      await worklistUseCase.deleteForm(patientId, session.domain);
    } else {
      await worklistUseCase.deletePatient(patientId, session.domain);
    }
    return reply.code(200).send({ deleted: patientId });
  });

  app.post("/forms/:filename/delete", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply
        .code(403)
        .type("text/plain; charset=utf-8")
        .send("Accès réservé aux administrateurs.");
    }
    const { filename } = req.params as { filename: string };
    await worklistUseCase.deleteForm(filename, session.domain);
    return reply.redirect(`/worklist?domain=${encodeURIComponent(session.domain)}`);
  });

  app.delete("/forms/:filename", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply.code(403).send({ ok: false, error: "Accès réservé aux administrateurs." });
    }
    const { filename } = req.params as { filename: string };
    await worklistUseCase.deleteForm(filename, session.domain);
    return reply.code(200).send({ deleted: filename });
  });

  // 3b. Next RCP / MDT Session Agenda Builder
  app.get("/agenda", async (req, reply) => {
    const session = resolveSession(req);
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const openOnboarding = query.onboarding === "1" || query.onboarding === "true";
    const focusExpert = query.focusExpert?.trim() || null;
    const [agenda, { queueStats, queueJobs }] = await Promise.all([
      agendaUseCase.getAgenda(session.domain),
      loadShellQueue(session.domain, session.isAdmin),
    ]);
    const html = renderAgendaPage(
      agenda,
      session,
      queueStats,
      queueJobs,
      openOnboarding,
      focusExpert,
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/agenda/options", async (req, reply) => {
    const session = resolveSession(req);
    const body = AgendaOptionsBodySchema.parse(req.body ?? {});

    const deferIncompleteFiles =
      body.deferIncompleteFilesPresent === "true"
        ? body.deferIncompleteFiles === "true"
        : undefined;

    const attendingExperts = normalizeFormStringList(
      body.attendingExpertsPresent,
      body.attendingExperts,
    );

    await agendaUseCase.updateOptions(
      {
        sessionDate: body.sessionDate,
        sortStrategy: body.sortStrategy,
        deferIncompleteFiles,
        attendingExperts,
        toggleExpert: body.toggleExpert,
      },
      session.domain,
    );
    return reply.redirect(`/agenda?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/agenda/schedule", async (req, reply) => {
    const session = resolveSession(req);
    const body = AgendaScheduleBodySchema.parse(req.body ?? {});

    const attendingExperts = normalizeFormStringList(
      body.attendingExpertsPresent,
      body.attendingExperts,
    );
    const patientIds = normalizeFormStringList(body.patientIdsPresent, body.patientIds);

    await agendaUseCase.updateOptions(
      {
        sessionDate: body.sessionDate,
        sortStrategy: body.sortStrategy,
        deferIncompleteFiles: false,
        attendingExperts,
        patientIds,
        resetEnrolledPatients: true,
      },
      session.domain,
    );
    return reply.redirect(`/agenda?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/agenda/patients", async (req, reply) => {
    const session = resolveSession(req);
    const body = AgendaEnrollBodySchema.parse(req.body ?? {});

    await agendaUseCase.enrollPatients(
      {
        patientId: body.patientId,
        patientIds: body.patientIds,
        enrollAllCandidates: body.enrollAllCandidates,
        filterMode: body.filterMode,
      },
      session.domain,
    );
    return reply.redirect(`/agenda?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/agenda/patients/:patientId/remove", async (req, reply) => {
    const session = resolveSession(req);
    const { patientId } = req.params as { patientId: string };
    await agendaUseCase.removePatient(patientId, session.domain);
    return reply.redirect(`/agenda?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/agenda/patients/clear", async (req, reply) => {
    const session = resolveSession(req);
    await agendaUseCase.clearAgenda(session.domain);
    return reply.redirect(`/agenda?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/agenda/patients/:patientId/move", async (req, reply) => {
    const session = resolveSession(req);
    const { patientId } = req.params as { patientId: string };
    const body = AgendaMoveBodySchema.parse(req.body ?? {});

    await agendaUseCase.movePatient(
      patientId,
      {
        direction: body.direction,
        targetPosition: body.targetPosition,
        pinned: body.pinned,
      },
      session.domain,
    );
    return reply.redirect(`/agenda?domain=${encodeURIComponent(session.domain)}`);
  });

  // 4. Ingest & Batch Tracking
  app.get("/ingest", async (req, reply) => {
    const session = resolveSession(req);
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const [patients, batch, { queueStats, queueJobs }] = await Promise.all([
      ingestUseCase.listExistingPatients(session.domain),
      query.batchId
        ? ingestUseCase.getBatchStatus(query.batchId, session.domain)
        : Promise.resolve(null),
      loadShellQueue(session.domain, session.isAdmin),
    ]);

    const html = renderIngestPage(
      patients,
      batch,
      session,
      queueStats,
      queueJobs,
      query.patientId ?? null,
      query.duplicate ?? null,
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/ingest/upload", async (req, reply) => {
    const session = resolveSession(req);
    const files: Array<{
      filename: string;
      content: Buffer;
      patientId?: string | null;
    }> = [];
    let patientId: string | null = null;

    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          const buf = await part.toBuffer();
          const cleanName = path.basename(part.filename || "");
          if (cleanName.toLowerCase().endsWith(".pdf") && isSafeFilename(cleanName)) {
            files.push({ filename: cleanName, content: buf });
          }
        } else if (part.fieldname === "patientId" && typeof part.value === "string") {
          patientId = part.value.trim() || null;
        }
      }
    }

    for (const f of files) {
      f.patientId = patientId;
    }

    const res = await ingestUseCase.uploadBatch(files, session.domain);
    const firstDuplicate = res.duplicates?.[0];
    const dupParam = firstDuplicate ? `&duplicate=${encodeURIComponent(firstDuplicate)}` : "";
    return reply.redirect(
      `/ingest?domain=${encodeURIComponent(session.domain)}&batchId=${encodeURIComponent(res.batchId)}${dupParam}`,
    );
  });

  app.get("/ingest/batches/:batchId", async (req, reply) => {
    const session = resolveSession(req);
    const { batchId } = req.params as { batchId: string };
    const status = await ingestUseCase.getBatchStatus(batchId, session.domain);
    return reply.send(status);
  });

  // 5. Patient Dossier & RCP Forms
  app.get("/resolve", async (req, reply) => {
    const session = resolveSession(req);
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const target = query.target ?? "";
    const resolved = await api.resolveTarget(target, session.domain);
    const lookupKey = resolved.patientId ?? resolved.filename ?? target;
    const existingDossier = lookupKey
      ? await dossierUseCase.getDossier(lookupKey, session.domain)
      : null;
    if (!existingDossier) {
      return reply.redirect(`/admin/queue?domain=${encodeURIComponent(session.domain)}`);
    }
    if (existingDossier.patientId) {
      return reply.redirect(
        `/patients/${encodeURIComponent(existingDossier.patientId)}?domain=${encodeURIComponent(session.domain)}`,
      );
    }
    return reply.redirect(
      `/forms/${encodeURIComponent(existingDossier.currentForm.file)}?domain=${encodeURIComponent(session.domain)}`,
    );
  });

  async function resolveAgendaDossierNav(
    dossier: {
      patientId: string | null;
      currentForm: { file: string };
      timeline: Array<{ file: string }>;
    },
    domain: ClinicalDomain,
    fromQuery: string | undefined,
    requestedTarget?: string,
    requestedFile?: string,
  ) {
    if (fromQuery !== "agenda") return undefined;
    const agenda = await agendaUseCase.getAgenda(domain);
    if (agenda.items.length === 0) return undefined;
    const timelineFiles = new Set(dossier.timeline.map((t) => t.file));
    const idx = agenda.items.findIndex(
      (i) =>
        (requestedTarget && (i.patientId === requestedTarget || i.filename === requestedTarget)) ||
        (requestedFile && (i.filename === requestedFile || i.patientId === requestedFile)) ||
        (dossier.patientId !== null && i.patientId === dossier.patientId) ||
        i.filename === dossier.currentForm.file ||
        timelineFiles.has(i.filename),
    );
    if (idx < 0) return undefined;
    const prev = idx > 0 ? agenda.items[idx - 1] : undefined;
    const next = idx < agenda.items.length - 1 ? agenda.items[idx + 1] : undefined;
    return {
      position: idx + 1,
      total: agenda.items.length,
      sessionDate: agenda.sessionDate,
      prevPatientId: prev?.patientId ?? null,
      prevPatientName: prev?.patientName ?? null,
      prevFilename: prev?.filename ?? null,
      nextPatientId: next?.patientId ?? null,
      nextPatientName: next?.patientName ?? null,
      nextFilename: next?.filename ?? null,
    };
  }

  app.get("/patients/:patientId", async (req, reply) => {
    const session = resolveSession(req);
    const { patientId } = req.params as { patientId: string };
    const query = (req.query ?? {}) as Record<string, string | undefined>;

    const [dossier, { queueStats, queueJobs }] = await Promise.all([
      dossierUseCase.getDossier(patientId, session.domain, session.language, query.file),
      loadShellQueue(session.domain, session.isAdmin),
    ]);
    if (!dossier) {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(
          renderStatusPage({
            statusCode: 404,
            kind: "not_found",
            title: "Dossier introuvable",
            session,
          }),
        );
    }

    const agendaNav = await resolveAgendaDossierNav(
      dossier,
      session.domain,
      query.from,
      patientId,
      query.file,
    );
    const editTargetTab = query.editSection
      ? dossier.sections.find((s) => s.name === query.editSection)?.meta.tab
      : undefined;
    const activeTab =
      query.view === "dashboard" ||
      query.view === "patient-dashboard" ||
      query.tab === "patient-dashboard" ||
      query.tab === "dashboard"
        ? "patient-dashboard"
        : query.tab === "opinions" || editTargetTab === "opinions"
          ? "opinions"
          : "clinical";
    const html = renderDossierPage(
      dossier,
      session,
      queueStats,
      queueJobs,
      [],
      query.editSection,
      agendaNav,
      activeTab,
      query.save_error ?? null,
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/patients/:patientId/summary", async (req, reply) => {
    const session = resolveSession(req);
    const { patientId } = req.params as { patientId: string };
    const body = (req.body ?? {}) as Record<string, string | boolean | undefined>;
    const force = body.force !== "false" && body.force !== false;

    await dossierUseCase.triggerPatientSummary(patientId, session.domain, force);
    return reply.redirect(
      `/patients/${encodeURIComponent(patientId)}?domain=${encodeURIComponent(session.domain)}&view=dashboard#patient-summary-card`,
    );
  });

  app.get("/forms/:filename", async (req, reply) => {
    const session = resolveSession(req);
    const { filename } = req.params as { filename: string };
    const query = (req.query ?? {}) as Record<string, string | undefined>;

    const [dossier, { queueStats, queueJobs }] = await Promise.all([
      dossierUseCase.getDossier(filename, session.domain, session.language, filename),
      loadShellQueue(session.domain, session.isAdmin),
    ]);
    if (!dossier) {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(
          renderStatusPage({
            statusCode: 404,
            kind: "not_found",
            title: "Fiche RCP introuvable",
            session,
          }),
        );
    }

    const agendaNav = await resolveAgendaDossierNav(
      dossier,
      session.domain,
      query.from,
      filename,
      filename,
    );
    const editTargetTab = query.editSection
      ? dossier.sections.find((s) => s.name === query.editSection)?.meta.tab
      : undefined;
    const activeTab =
      query.view === "dashboard" ||
      query.view === "patient-dashboard" ||
      query.tab === "patient-dashboard" ||
      query.tab === "dashboard"
        ? "patient-dashboard"
        : query.tab === "opinions" || editTargetTab === "opinions"
          ? "opinions"
          : "clinical";
    const html = renderDossierPage(
      dossier,
      session,
      queueStats,
      queueJobs,
      [],
      query.editSection,
      agendaNav,
      activeTab,
      query.save_error ?? null,
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/forms/:filename/sections/:section/edit", async (req, reply) => {
    const session = resolveSession(req);
    const { filename, section } = req.params as {
      filename: string;
      section: string;
    };
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const isCancelToView = query.view === "1";
    const dossier = await dossierUseCase.getDossier(
      filename,
      session.domain,
      session.language,
      filename,
    );
    const secView = dossier?.sections.find((s) => s.name === section);
    if (!dossier || !secView) {
      return reply.code(404).send("Rubrique introuvable");
    }

    if (req.headers["hx-request"] === "true") {
      return reply
        .type("text/html; charset=utf-8")
        .send(
          renderSectionDetailsPartial(
            secView,
            filename,
            session.domain,
            !isCancelToView,
            session.expertMode,
          ),
        );
    }

    if (isCancelToView) {
      const targetUrl = dossier.patientId
        ? `/patients/${encodeURIComponent(dossier.patientId)}?file=${encodeURIComponent(filename)}&domain=${encodeURIComponent(session.domain)}#section-${encodeURIComponent(section)}`
        : `/forms/${encodeURIComponent(filename)}?domain=${encodeURIComponent(session.domain)}#section-${encodeURIComponent(section)}`;
      return reply.redirect(targetUrl);
    }

    const { queueStats, queueJobs } = await loadShellQueue(session.domain, session.isAdmin);
    const html = renderDossierPage(
      dossier,
      session,
      queueStats,
      queueJobs,
      [],
      section,
      undefined,
      secView.meta.tab,
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/api/schema", async (req, reply) => {
    const session = resolveSession(req);
    const schema = await api.getDomainSchema(session.domain);
    return reply.type("application/json; charset=utf-8").send(schema);
  });

  function classifySectionMutationError(err: unknown): { statusCode: 422 | 502; message: string } {
    const rawMsg = err instanceof Error ? err.message : String(err ?? "Erreur d'enregistrement");
    const isValidation =
      /postérieure|validation|invalide|invalid|valueerror|zoderror|http (400|422)\b/i.test(rawMsg);
    const cleanMsg = rawMsg.replace(/^MedSyntis API HTTP \d+ on [^:]+:\s*/i, "").trim();
    return {
      statusCode: isValidation ? 422 : 502,
      message: cleanMsg || "Impossible d'enregistrer les modifications de la rubrique.",
    };
  }

  async function sendSectionMutationError(
    req: FastifyRequest,
    reply: FastifyReply,
    session: ReturnType<typeof resolveSession>,
    filename: string,
    section: string,
    err: unknown,
  ) {
    const { statusCode, message } = classifySectionMutationError(err);
    const acceptHeader = String(req.headers.accept ?? "").toLowerCase();
    const isPureFullPageNav =
      !req.headers["hx-request"] &&
      !req.headers["x-requested-with"] &&
      acceptHeader.includes("text/html") &&
      !acceptHeader.includes("application/json");

    if (!isPureFullPageNav) {
      return reply
        .code(statusCode)
        .type("application/json; charset=utf-8")
        .send({ ok: false, error: message });
    }

    const dossier = await dossierUseCase
      .getDossier(filename, session.domain, session.language, filename)
      .catch(() => null);
    const targetUrl = dossier?.patientId
      ? `/patients/${encodeURIComponent(dossier.patientId)}?file=${encodeURIComponent(filename)}&domain=${encodeURIComponent(session.domain)}&editSection=${encodeURIComponent(section)}&save_error=${encodeURIComponent(message)}#section-${encodeURIComponent(section)}`
      : `/forms/${encodeURIComponent(filename)}?domain=${encodeURIComponent(session.domain)}&editSection=${encodeURIComponent(section)}&save_error=${encodeURIComponent(message)}#section-${encodeURIComponent(section)}`;
    return reply.redirect(targetUrl);
  }

  async function sendSectionMutationResponse(
    req: FastifyRequest,
    reply: FastifyReply,
    session: ReturnType<typeof resolveSession>,
    filename: string,
    section: string,
  ) {
    const dossier = await dossierUseCase.getDossier(
      filename,
      session.domain,
      session.language,
      filename,
    );
    const secView = dossier?.sections.find((s) => s.name === section);

    if (req.headers["hx-request"] === "true" && secView) {
      return reply
        .type("text/html; charset=utf-8")
        .send(
          renderSectionDetailsPartial(secView, filename, session.domain, false, session.expertMode),
        );
    }

    const targetUrl = dossier?.patientId
      ? `/patients/${encodeURIComponent(dossier.patientId)}?file=${encodeURIComponent(filename)}&domain=${encodeURIComponent(session.domain)}#section-${encodeURIComponent(section)}`
      : `/forms/${encodeURIComponent(filename)}?domain=${encodeURIComponent(session.domain)}#section-${encodeURIComponent(section)}`;
    return reply.redirect(targetUrl);
  }

  app.post("/forms/:filename/sections/:section", async (req, reply) => {
    const session = resolveSession(req);
    const { filename, section } = req.params as {
      filename: string;
      section: string;
    };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const editedBy = session.userId || session.userName;

    try {
      await dossierUseCase.updateSection(filename, section, body, editedBy, session.domain);
    } catch (err) {
      req.log.warn({ filename, section }, "Section update failed");
      return sendSectionMutationError(req, reply, session, filename, section, err);
    }

    return sendSectionMutationResponse(req, reply, session, filename, section);
  });

  app.post("/forms/:filename/sections/:section/rollback", async (req, reply) => {
    const session = resolveSession(req);
    const { filename, section } = req.params as {
      filename: string;
      section: string;
    };

    try {
      await dossierUseCase.rollbackSection(filename, section, session.domain);
    } catch (err) {
      req.log.warn({ filename, section }, "Section rollback failed");
      return sendSectionMutationError(req, reply, session, filename, section, err);
    }

    return sendSectionMutationResponse(req, reply, session, filename, section);
  });

  app.post("/forms/:filename/missing-items", async (req, reply) => {
    const session = resolveSession(req);
    const { filename } = req.params as { filename: string };
    const body = MissingItemsBodySchema.parse(req.body ?? {});
    const editedBy = session.userId || session.userName;

    await dossierUseCase.updateMissingItems(
      filename,
      {
        toggleItem: body.toggle_item,
        hideMissingItems: body.restore_all ? false : body.hide_missing_items,
        hiddenMissingItems: body.restore_all ? [] : undefined,
        editedBy,
      },
      session.domain,
    );

    const fallback = `/forms/${encodeURIComponent(filename)}?domain=${encodeURIComponent(session.domain)}#section-MTDCompleted`;
    const redirectUrl = sanitizeLocalRedirect(req.headers.referer, fallback);
    return reply.redirect(redirectUrl);
  });

  app.post("/forms/:filename/sections/:section/rerun", async (req, reply) => {
    const session = resolveSession(req);
    const { filename, section } = req.params as {
      filename: string;
      section: string;
    };
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const preserve = body.preserve_manual_edits !== "false";

    await dossierUseCase.rerunSection(filename, section, preserve, session.domain);
    const fallback = `/forms/${encodeURIComponent(filename)}?domain=${encodeURIComponent(session.domain)}#section-${encodeURIComponent(section)}`;
    return reply.redirect(sanitizeLocalRedirect(req.headers.referer, fallback));
  });

  app.post("/forms/:filename/process", async (req, reply) => {
    const session = resolveSession(req);
    const { filename } = req.params as { filename: string };
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const preserve = body.preserve_manual_edits !== "false";

    await dossierUseCase.processFullForm(filename, preserve, session.domain);
    const fallback = `/forms/${encodeURIComponent(filename)}?domain=${encodeURIComponent(session.domain)}`;
    return reply.redirect(sanitizeLocalRedirect(req.headers.referer, fallback));
  });

  app.post("/forms/:filename/link-patient", async (req, reply) => {
    const session = resolveSession(req);
    const { filename } = req.params as { filename: string };
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const patientId = (body.patientId ?? "").trim() || null;
    const editedBy = session.userId || session.userName;

    await dossierUseCase.linkPatient(filename, patientId, session.domain, editedBy);
    if (patientId) {
      return reply.redirect(
        `/patients/${encodeURIComponent(patientId)}?domain=${encodeURIComponent(session.domain)}`,
      );
    }
    return reply.redirect(
      `/forms/${encodeURIComponent(filename)}?domain=${encodeURIComponent(session.domain)}`,
    );
  });

  app.post("/patients/:patientId/chat", async (req, reply) => {
    const session = resolveSession(req);
    const { patientId } = req.params as { patientId: string };
    const body = ChatBodySchema.parse(req.body ?? {});
    const target =
      body.scope === "form" && body.filename
        ? { filename: body.filename }
        : { patientId, filename: body.filename };

    const chatReply = await dossierUseCase.askQuestion(
      target,
      body.question,
      session.domain,
      session.language,
      body.agentName,
    );

    if (req.headers["hx-request"] === "true") {
      return reply
        .type("text/html; charset=utf-8")
        .send(renderChatLogMessagePartial(body.question, chatReply, session.domain, body.filename));
    }

    const [dossier, { queueStats, queueJobs }] = await Promise.all([
      dossierUseCase.getDossier(patientId, session.domain, session.language, body.filename),
      loadShellQueue(session.domain, session.isAdmin),
    ]);
    if (!dossier) return reply.redirect(`/worklist?domain=${encodeURIComponent(session.domain)}`);
    return reply
      .type("text/html; charset=utf-8")
      .send(
        renderDossierPage(dossier, session, queueStats, queueJobs, [
          { question: body.question, reply: chatReply },
        ]),
      );
  });

  app.post("/forms/:filename/chat", async (req, reply) => {
    const session = resolveSession(req);
    const { filename } = req.params as { filename: string };
    const body = ChatBodySchema.parse(req.body ?? {});

    const chatReply = await dossierUseCase.askQuestion(
      { filename },
      body.question,
      session.domain,
      session.language,
      body.agentName,
    );

    if (req.headers["hx-request"] === "true") {
      return reply
        .type("text/html; charset=utf-8")
        .send(renderChatLogMessagePartial(body.question, chatReply, session.domain, filename));
    }

    const [dossier, { queueStats, queueJobs }] = await Promise.all([
      dossierUseCase.getDossier(filename, session.domain, session.language, filename),
      loadShellQueue(session.domain, session.isAdmin),
    ]);
    if (!dossier) return reply.redirect(`/worklist?domain=${encodeURIComponent(session.domain)}`);
    return reply
      .type("text/html; charset=utf-8")
      .send(
        renderDossierPage(dossier, session, queueStats, queueJobs, [
          { question: body.question, reply: chatReply },
        ]),
      );
  });

  // 6. Same-Origin PDF Streaming (Forms & Guidelines with HTTP Byte-Range & ETag support)
  app.get("/files/forms/:filename/pdf", async (req, reply) => {
    const session = resolveSession(req);
    const { filename } = req.params as { filename: string };
    if (!isSafeFilename(filename)) {
      return reply.code(400).send("Nom de fichier invalide");
    }
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const variant = query.variant === "bbox" ? "bbox" : "plain";
    const buf = await api.getFormPdfBuffer(filename, session.domain, variant);
    if (!buf) {
      return reply.code(404).send("PDF introuvable");
    }
    return sendPdfBufferWithRange(req, reply, buf, filename);
  });

  app.get("/files/resources/:filename", async (req, reply) => {
    const session = resolveSession(req);
    const { filename } = req.params as { filename: string };
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    if (
      !filename ||
      filename.length > 255 ||
      filename.includes("..") ||
      filename.includes("/") ||
      filename.includes("\\") ||
      filename.includes("\0")
    ) {
      return reply.code(400).send("Nom de fichier invalide");
    }

    const safeFormFile =
      query.formFile && isSafeFilename(query.formFile) ? query.formFile : undefined;
    let buf = await api.getResourcePdfBuffer(filename, session.domain, safeFormFile);

    if (!buf && safeFormFile) {
      buf = await api.getFormPdfBuffer(safeFormFile, session.domain);
    }

    if (!buf) {
      return reply.code(404).send("Référentiel PDF introuvable");
    }
    return sendPdfBufferWithRange(req, reply, buf, filename);
  });

  // 7. Guidelines & Specialty Agents
  app.get("/guidelines", async (req, reply) => {
    const session = resolveSession(req);
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const [overview, { queueStats, queueJobs }] = await Promise.all([
      guidelinesUseCase.getOverview(session.domain, session.language, query.file),
      loadShellQueue(session.domain, session.isAdmin),
    ]);

    const html = renderGuidelinesPage(overview, session, queueStats, queueJobs);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/agents", async (req, reply) => {
    const session = resolveSession(req);
    const [agents, resources, { queueStats, queueJobs }] = await Promise.all([
      api.listAgents(session.domain, session.language),
      api.listResources(session.domain),
      loadShellQueue(session.domain, session.isAdmin),
    ]);
    const html = renderAgentsPage(agents, session, queueStats, queueJobs, resources);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/guidelines/upload", async (req, reply) => {
    const session = resolveSession(req);
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === "file" && part.filename) {
          const cleanName = path.basename(part.filename);
          const buf = await part.toBuffer();
          if (cleanName.toLowerCase().endsWith(".pdf") && isSafeFilename(cleanName)) {
            await guidelinesUseCase.uploadResource(cleanName, buf, session.domain);
          }
        }
      }
    }
    return reply.redirect(`/guidelines?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/guidelines/:filename/reindex", async (req, reply) => {
    const session = resolveSession(req);
    const { filename } = req.params as { filename: string };
    if (!isSafeFilename(filename)) {
      return reply.code(400).send("Nom de fichier invalide");
    }
    await guidelinesUseCase.reindexResource(filename, session.domain);
    return reply.redirect(
      `/guidelines?file=${encodeURIComponent(filename)}&domain=${encodeURIComponent(session.domain)}`,
    );
  });

  app.post("/guidelines/:filename/delete", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply
        .code(403)
        .type("text/plain; charset=utf-8")
        .send("Accès réservé aux administrateurs.");
    }
    const { filename } = req.params as { filename: string };
    if (!isSafeFilename(filename)) {
      return reply.code(400).send("Nom de fichier invalide");
    }
    await guidelinesUseCase.deleteResource(filename, session.domain);
    return reply.redirect(`/guidelines?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/guidelines/chat", async (req, reply) => {
    const session = resolveSession(req);
    const body = ChatBodySchema.parse(req.body ?? {});
    const chatReply = await guidelinesUseCase.askGuidelineQuestion(
      body.question,
      session.domain,
      session.language,
      body.filename,
    );

    if (req.headers["hx-request"] === "true") {
      return reply
        .type("text/html; charset=utf-8")
        .send(renderChatLogMessagePartial(body.question, chatReply, session.domain, body.filename));
    }

    const [overview, { queueStats, queueJobs }] = await Promise.all([
      guidelinesUseCase.getOverview(session.domain, session.language, body.filename),
      loadShellQueue(session.domain, session.isAdmin),
    ]);
    return reply
      .type("text/html; charset=utf-8")
      .send(
        renderGuidelinesPage(overview, session, queueStats, queueJobs, [
          { question: body.question, reply: chatReply },
        ]),
      );
  });

  // 8. Feedback & Bug Reports
  app.get("/feedback", async (req, reply) => {
    const session = resolveSession(req);
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const [bugs, { queueStats, queueJobs }] = await Promise.all([
      feedbackUseCase.listBugs(session.domain, {
        status: query.status,
        category: query.category,
      }),
      loadShellQueue(session.domain, session.isAdmin),
    ]);

    const html = renderFeedbackPage(bugs, session, queueStats, queueJobs);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/feedback", async (req, reply) => {
    const session = resolveSession(req);
    const body = FeedbackCreateBodySchema.parse(req.body ?? {});
    await feedbackUseCase.createBug({
      title: body.title,
      description: body.description,
      category: body.category,
      severity: body.severity,
      domain: session.domain,
      patientOrFile: body.patientOrFile,
      author: session.userName,
    });
    return reply.redirect(`/feedback?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/feedback/:bugId/status", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply
        .code(403)
        .type("text/plain; charset=utf-8")
        .send("Accès réservé aux administrateurs.");
    }
    const { bugId } = req.params as { bugId: string };
    const body = FeedbackStatusBodySchema.parse(req.body ?? {});
    await feedbackUseCase.updateStatus(bugId, body.status, session.domain);
    return reply.redirect(`/feedback?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/feedback/:bugId/delete", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply
        .code(403)
        .type("text/plain; charset=utf-8")
        .send("Accès réservé aux administrateurs.");
    }
    const { bugId } = req.params as { bugId: string };
    await feedbackUseCase.deleteBug(bugId, session.domain);
    return reply.redirect(`/feedback?domain=${encodeURIComponent(session.domain)}`);
  });

  app.delete("/feedback/:bugId", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply.code(403).send({ ok: false, error: "Accès réservé aux administrateurs." });
    }
    const { bugId } = req.params as { bugId: string };
    await feedbackUseCase.deleteBug(bugId, session.domain);
    return reply.code(200).send({ deleted: bugId });
  });

  // 9. Queue Supervision & SSE Stream
  app.get("/admin/queue", async (req, reply) => {
    const session = resolveSession(req);
    const dashboard = await queueAdminUseCase.getDashboard(
      session.domain,
      Boolean(session.isAdmin),
    );
    const html = renderQueueAdminPage(dashboard, session);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/queue", async (req, reply) => {
    const session = resolveSession(req);
    const dashboard = await queueAdminUseCase.getDashboard(
      session.domain,
      Boolean(session.isAdmin),
    );
    const html = renderQueueAdminPage(dashboard, session);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.post("/admin/queue/jobs/:jobId/retry", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply.code(403).send("Accès réservé aux administrateurs.");
    }
    const { jobId } = req.params as { jobId: string };
    await queueAdminUseCase.retryJob(jobId, session.domain);
    return reply.redirect(`/admin/queue?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/admin/queue/jobs/:jobId/delete", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply.code(403).send("Accès réservé aux administrateurs.");
    }
    const { jobId } = req.params as { jobId: string };
    await queueAdminUseCase.cancelOrDeleteJob(jobId, session.domain);
    return reply.redirect(`/admin/queue?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/admin/queue/clean", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply.code(403).send("Accès réservé aux administrateurs.");
    }
    const body = QueueCleanBodySchema.parse(req.body ?? {});
    await queueAdminUseCase.cleanQueue(body.mode, session.domain);
    return reply.redirect(`/admin/queue?domain=${encodeURIComponent(session.domain)}`);
  });

  app.post("/admin/queue/locks/release", async (req, reply) => {
    const session = resolveSession(req);
    if (!session.isAdmin) {
      return reply.code(403).send("Accès réservé aux administrateurs.");
    }
    await queueAdminUseCase.releaseLocks(session.domain);
    return reply.redirect(`/admin/queue?domain=${encodeURIComponent(session.domain)}`);
  });

  app.get("/events/queue", async (req, reply) => {
    const session = resolveSession(req);
    const stats = await api.getQueueStats(session.domain, Boolean(session.isAdmin));
    const bannerHtml = renderQueueBannerPartial(stats, session).replace(/\n/g, " ");
    const badgesHtml = renderQueueNavBadges(stats, session.language).replace(/\n/g, " ");
    const retryMs = stats.running > 0 || stats.pending > 0 ? 3000 : 8000;
    reply.header("Content-Type", "text/event-stream; charset=utf-8");
    reply.header("Cache-Control", "no-cache, no-transform");
    reply.header("Connection", "keep-alive");
    return reply.send(
      `retry: ${retryMs}\nevent: banner\ndata: ${bannerHtml}\n\nevent: badges\ndata: ${badgesHtml}\n\n`,
    );
  });

  // 10. Maintenance, 404 Not Found & 5xx Server Error Pages
  app.get("/maintenance", async (req, reply) => {
    const session = resolveSession(req);
    return reply
      .code(503)
      .type("text/html; charset=utf-8")
      .send(renderStatusPage({ statusCode: 503, kind: "maintenance", session }));
  });

  app.setNotFoundHandler(async (req, reply) => {
    const session = resolveSession(req);
    return reply
      .code(404)
      .type("text/html; charset=utf-8")
      .send(renderStatusPage({ statusCode: 404, kind: "not_found", session }));
  });

  app.setErrorHandler(async (err, req, reply) => {
    const rawCode =
      typeof (err as { statusCode?: unknown })?.statusCode === "number"
        ? ((err as { statusCode: number }).statusCode ?? 500)
        : 500;
    const statusCode = rawCode >= 400 && rawCode < 600 ? rawCode : 500;
    const session = resolveSession(req);
    if (statusCode === 404) {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(renderStatusPage({ statusCode: 404, kind: "not_found", session }));
    }
    return reply
      .code(statusCode)
      .type("text/html; charset=utf-8")
      .send(
        renderStatusPage({
          statusCode,
          kind: statusCode === 503 ? "maintenance" : "server_error",
          session,
        }),
      );
  });

  return app;
}
