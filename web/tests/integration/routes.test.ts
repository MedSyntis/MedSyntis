import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { bffRequestContext } from "../../src/infrastructure/api/http-medsyntis-api.adapter.js";
import { InMemoryMedsyntisApiFake } from "../../src/infrastructure/api/in-memory-medsyntis-api.fake.js";
import {
  cleanNullableString,
  formatCleanIsoDate,
} from "../../src/infrastructure/validation/schemas.js";
import { validateStartupConfig } from "../../src/main.js";
import {
  renderChatLogMessagePartial,
  renderSafeMarkdown,
} from "../../src/ui/components/ai-chat.component.js";
import {
  buildServer,
  isSafeFilename,
  sanitizeLocalRedirect,
  verifyProxySecret,
} from "../../src/ui/server.js";
import { html, raw } from "../../src/ui/templates.js";
import { renderStatusPage } from "../../src/ui/views/status.view.js";

async function createTestApp() {
  const api = new InMemoryMedsyntisApiFake();
  const config = loadConfig({
    PORT_WEB: "0",
    APP_DOMAIN: "oncology",
    APP_ALLOWED_DOMAINS: "oncology,sma",
  });
  const app = await buildServer({ config, api });
  return { app, api };
}

describe("Fastify BFF Routes & Material Design 3 HTML Views (Integration)", () => {
  it("GET / redirects to /worklist and sets strict self-hosted CSP header", async () => {
    const { app } = await createTestApp();
    const resRedirect = await app.inject({ method: "GET", url: "/" });
    expect(resRedirect.statusCode).toBe(302);
    expect(resRedirect.headers.location).toBe("/worklist");

    const res = await app.inject({ method: "GET", url: "/worklist" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.body).toContain('data-testid="sidebar"');
    expect(res.body).not.toContain('data-testid="queue-banner"');
    expect(res.body).toContain('data-testid="btn_queue_open"');
    expect(res.body).toContain('data-testid="nav-queue-badges"');
    expect(res.body).toContain('data-testid="badge-queue-running"');
    expect(res.body).toContain('data-testid="badge-queue-failed"');
    expect(res.body).toContain('data-theme-pref="auto"');
    expect(res.body).toContain('data-testid="theme-selector"');
    expect(res.body).toContain('data-testid="btn_theme_auto"');
    expect(res.body).toContain('data-testid="btn_theme_light"');
    expect(res.body).toContain('data-testid="btn_theme_dark"');
    expect(res.body).toContain('data-testid="kpi-structured"');
    expect(res.body).toContain('data-testid="kpi-priority-p1"');
    expect(res.body).toContain('data-testid="kpi-priority-not-assessed"');
    expect(res.body).toContain('data-testid="worklist-table"');
    expect(res.body).toContain("FICTIVE Jeanne");
    // Medico-legal check: never use "Intervention requise"
    expect(res.body).toContain("Adaptation suggérée");
    expect(res.body).not.toContain("Intervention requise");
    // Fixed domain per instance: no manual domain selector in sidebar
    expect(res.body).not.toContain('data-testid="domain-select"');
    // Material Design 3 Navigation Rail & Contextual Menus (...)
    expect(res.body).toContain("ds-nav-rail");
    expect(res.body).toContain('data-testid="rail-fab-ingest"');
    expect(res.body).toContain("ds-nav__indicator");
    expect(res.body).toContain('data-testid="menu-topbar-actions"');
    expect(res.body).toContain('data-testid="menu-patient-A-1042"');
    // Styleguide link hidden unless expertMode is enabled
    expect(res.body).not.toContain('data-testid="nav-styleguide"');

    const expertRes = await app.inject({
      method: "GET",
      url: "/worklist?expert=true",
    });
    expect(expertRes.body).toContain('data-testid="nav-styleguide"');

    const cardsRes = await app.inject({
      method: "GET",
      url: "/worklist?display=cards",
    });
    expect(cardsRes.statusCode).toBe(200);
    expect(cardsRes.body).toContain("ds-patient-grid");

    // Mobile User-Agent defaults to Cards view on /worklist when display is not explicitly passed
    const mobileCardsRes = await app.inject({
      method: "GET",
      url: "/worklist",
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
    });
    expect(mobileCardsRes.statusCode).toBe(200);
    expect(mobileCardsRes.body).toContain('<option value="cards" selected>');
    await app.close();
  });

  it("GET /styleguide serves the Material Design 3 styleguide with the SVG icon catalog", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/styleguide" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Catalogue d'icônes Material Design 3");
    expect(res.body).toContain('id="ic-compass"');
    await app.close();
  });

  it("GET /styleguide works in Zero-Trust production mode, bundles styleguide in Dockerfile.web, and handles trailing slash & missing file", async () => {
    // 1. Guard against production Docker image regressions: Dockerfile.web MUST copy web/styleguide -> ./styleguide
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const dockerfileWeb = fs.readFileSync(
      path.join(repoRoot, "dist/docker/Dockerfile.web"),
      "utf8",
    );
    expect(dockerfileWeb).toMatch(/COPY\s+--chown=1002:1002\s+web\/styleguide\s+\.\/styleguide/);

    const dockerignore = fs.readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
    expect(dockerignore).not.toMatch(/^(?:web\/)?styleguide\/?$/m);

    // 2. Production Fastify configuration behind Caddy + OAuth2-Proxy
    const api = new InMemoryMedsyntisApiFake();
    const prodConfig = loadConfig({
      PORT_WEB: "0",
      NODE_ENV: "production",
      APP_DEV_MODE: "false",
      APP_AUTH_MODE: "oauth_proxy",
      APP_PROXY_SECRET: "prod-secret-styleguide",
      APP_ALLOWED_DOMAINS: "oncology,sma",
    });
    const prodApp = await buildServer({ config: prodConfig, api });
    const prodHeaders = {
      host: "oncologic.medsyntis.fr",
      "x-medsyntis-proxy-secret": "prod-secret-styleguide",
      "x-medsyntis-domain": "oncology",
      "x-auth-request-user": "dr.prod",
    };

    const res = await prodApp.inject({
      method: "GET",
      url: "/styleguide?theme=dark&contrast=high",
      headers: prodHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(res.body).toContain('data-theme="dark"');
    expect(res.body).toContain('data-contrast="high"');
    expect(res.body).not.toContain("../public/");
    expect(res.body).toMatch(/href="\/public\/css\/tokens\.css\?v=\d+"/);
    expect(res.body).toMatch(/href="\/public\/css\/components\.css\?v=\d+"/);

    const csp = String(res.headers["content-security-policy"] ?? "");
    const nonceMatch = csp.match(/script-src 'self' 'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.body).toContain(`<script nonce="${nonceMatch?.[1]}">`);

    // Trailing slash redirects cleanly to canonical /styleguide preserving query string
    const slashRes = await prodApp.inject({
      method: "GET",
      url: "/styleguide/?contrast=medium",
      headers: prodHeaders,
    });
    expect(slashRes.statusCode).toBe(302);
    expect(slashRes.headers.location).toBe("/styleguide?contrast=medium");

    await prodApp.close();

    // 3. Missing styleguide file returns clean 404 instead of unhandled 500 ENOENT
    const missingApp = await buildServer({
      config: prodConfig,
      api,
      styleguidePath: path.join(repoRoot, "web/styleguide/does-not-exist.html"),
    });
    const missingRes = await missingApp.inject({
      method: "GET",
      url: "/styleguide",
      headers: prodHeaders,
    });
    expect(missingRes.statusCode).toBe(404);
    await missingApp.close();
  });

  it("GET /worklist filters by domain (sma) and completeness (incomplete)", async () => {
    const { app } = await createTestApp();
    const smaRes = await app.inject({
      method: "GET",
      url: "/worklist?domain=sma",
    });
    expect(smaRes.statusCode).toBe(200);
    expect(smaRes.body).toContain("EXEMPLE Léo");

    const incRes = await app.inject({
      method: "GET",
      url: "/worklist?domain=oncology&completeness=incomplete",
    });
    expect(incRes.statusCode).toBe(200);
    expect(incRes.body).toContain("FICTIVE Jeanne");
    expect(incRes.body).not.toContain("MODÈLE Paul");
    await app.close();
  });

  it("GET /patients/:patientId renders longitudinal timeline, synoptic card, sections, opinions, and saves manual edits", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/patients/A-1042",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-testid="synoptic-card"');
    expect(res.body).toContain('data-testid="marker-tumor_location"');
    expect(res.body).toContain('data-jump-section="TumorLocation"');
    expect(res.body).toContain('data-testid="marker-ca19_9"');
    expect(res.body).toContain('data-jump-section="TumorBiology"');
    expect(res.body).toContain('data-testid="marker-performance_status"');
    expect(res.body).toContain('data-jump-section="PatientPerformanceStatus"');
    expect(res.body).toContain('data-testid="badge-completeness"');
    expect(res.body).toContain('data-jump-section="MTDCompleted"');
    expect(res.body).toContain("2 spécialités");
    expect(res.body).toContain("Spécialités mobilisées (2)");
    expect(res.body).not.toContain("+1 spécialité(s)");
    expect(res.body).toContain('data-testid="session-timeline"');
    expect(res.body).toContain('data-testid="split-view"');
    expect(res.body).toContain("jeanne_fictive_2026_11_06.pdf");
    expect(res.body).toContain("TNCD Pancréas §4.2");
    // Timeline upcoming node & readable PDF iframe hash
    expect(res.body).toContain('data-testid="timeline-upcoming"');
    expect(res.body).toContain("Prochaine séance");
    expect(res.body).toContain("#navpanes=0&amp;pagemode=none&amp;view=FitH&amp;toolbar=1");
    expect(res.body).toContain('data-testid="btn_pdf_expand"');
    // AI reasoning (reasoning_thinking) & quick prompt chips
    expect(res.body).toContain('data-testid="reasoning-TumorLocation"');
    expect(res.body).toContain('data-testid="quick-prompt-chips"');
    // Collapsible RCP timeline drawer with label
    expect(res.body).toContain('data-testid="timeline-drawer"');
    expect(res.body).toContain("Frise chronologique RCP");
    // Missing items interactive list visible inside MTDCompleted (with hide_missing_items field name & zero duplicate kv field)
    expect(res.body).toContain('data-testid="missing-items-panel"');
    expect(res.body).toContain('data-testid="missing-items-list"');
    expect(res.body).toContain('name="hide_missing_items"');
    expect(res.body).toContain('class="ds-missing-list__content"');
    expect(res.body).toContain('class="ds-missing-list__icon"');
    expect(res.body).toContain('class="ds-missing-list__text ds-markdown"');
    // PatientMDTFormCheck hidden outside expert mode
    expect(res.body).not.toContain('data-testid="section-PatientMDTFormCheck"');
    // Zero raw JSON blocks for MTDCompleted or RadiologicalExams
    expect(res.body).not.toContain('{"is_mtd_complete"');

    // Toggle individual missing item visibility -> does NOT flip dossier to complete without explicit practitioner update
    const toggleMissingRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/missing-items?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "hide_missing_items=true",
    });
    expect([200, 302]).toContain(toggleMissingRes.statusCode);
    const afterHideRes = await app.inject({
      method: "GET",
      url: "/patients/A-1042",
    });
    expect(afterHideRes.body).toContain("La liste des éléments manquants est actuellement masquée");
    expect(afterHideRes.body).toContain("Dossier incomplet");

    // AJAX save on MTDCompleted preserves missing-items-panel and signals header refresh
    const editMtdRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/MTDCompleted",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      payload:
        "is_mtd_complete=true&what_missing=TEP-TDM+facultatif&reflection=Valid%C3%A9+par+le+praticien",
    });
    expect(editMtdRes.statusCode).toBe(200);
    expect(editMtdRes.headers["x-refresh-dossier"]).toBe("true");
    expect(editMtdRes.body).toContain('data-testid="missing-items-panel"');
    expect(editMtdRes.body).toContain("Éléments facultatifs manquants");

    // Save a manual edit on ChemotherapyTreament section
    const editRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/ChemotherapyTreament",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      payload:
        "chemotherapy_name=FOLFIRINOX+modifi%C3%A9+7+cures&chemotherapy_tolerance=Neuropathie+grade+1",
    });
    expect(editRes.statusCode).toBe(200);
    expect(editRes.body).toContain("Modifié manuellement");
    expect(editRes.body).toContain("FOLFIRINOX modifié 7 cures");
    expect(editRes.body).toContain("ds-kv--manual");
    expect(editRes.body).toContain('data-testid="field-manual-chemotherapy_name"');
    expect(editRes.body).toContain("Valeur IA initiale : FOLFIRINOX modifié, 6 cures");
    expect(editRes.body).toContain('data-testid="btn_rollback_section_ChemotherapyTreament"');

    // Cancel edit returns read-only partial without is-editing
    const cancelEditRes = await app.inject({
      method: "GET",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/ChemotherapyTreament/edit?view=1",
      headers: { "hx-request": "true" },
    });
    expect(cancelEditRes.statusCode).toBe(200);
    expect(cancelEditRes.body).not.toContain("is-editing");
    expect(cancelEditRes.body).toContain("FOLFIRINOX modifié 7 cures");

    // Rerun ChemotherapyTreament while preserving manual edits by default
    const rerunRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/ChemotherapyTreament/rerun",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "preserve_manual_edits=true",
    });
    expect([200, 302]).toContain(rerunRes.statusCode);

    const checkRes = await app.inject({
      method: "GET",
      url: "/patients/A-1042?expert=true",
    });
    expect(checkRes.body).toContain("Modifié manuellement");
    expect(checkRes.body).toContain("FOLFIRINOX modifié 7 cures");
    // Expert mode shows user prompt, AI vs Human trace, and Chunks
    expect(checkRes.body).toContain('data-testid="prompt-TumorLocation"');
    expect(checkRes.body).toContain('data-testid="trace-ChemotherapyTreament"');
    expect(checkRes.body).toContain("Chunk #1");

    // Rollback ChemotherapyTreament restores the original AI value and removes manual badge + field highlight
    const rollbackRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/ChemotherapyTreament/rollback",
      headers: { "hx-request": "true" },
    });
    expect(rollbackRes.statusCode).toBe(200);
    expect(rollbackRes.body).not.toContain("Modifié manuellement");
    expect(rollbackRes.body).not.toContain("ds-kv--manual");
    expect(rollbackRes.body).not.toContain("FOLFIRINOX modifié 7 cures");
    expect(rollbackRes.body).toContain("FOLFIRINOX modifié, 6 cures");
    await app.close();
  });

  it("POST /patients/:patientId/chat answers clinical questions with citations", async () => {
    const { app } = await createTestApp();
    const chatRes = await app.inject({
      method: "POST",
      url: "/patients/A-1042/chat",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      payload: "question=Evolution+du+CA+19-9",
    });
    expect(chatRes.statusCode).toBe(200);
    expect(chatRes.body).toContain("412 U/mL");
    expect(chatRes.body).toContain("TNCD Pancréas §4.2");
    await app.close();
  });

  it("GET /guidelines, GET /agents, and POST /guidelines/chat display TNCD/PNDS resources, dedicated agents page with prompts, and RAG answers", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/guidelines" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("TNCD_Pancreas_2026.pdf");
    expect(res.body).toContain('data-testid="btn_goto_agents"');

    const agentsRes = await app.inject({ method: "GET", url: "/agents" });
    expect(agentsRes.statusCode).toBe(200);
    expect(agentsRes.body).toContain('data-testid="agents-list"');
    expect(agentsRes.body).toContain('data-testid="agents-group-coordination"');
    expect(agentsRes.body).toContain('data-testid="agents-group-experts"');
    expect(agentsRes.body).toContain(
      'data-testid="agent-organ-resources-digestive surgeon expert-Pancreas"',
    );
    expect(agentsRes.body).toContain("Pancréas");
    expect(agentsRes.body).toContain("Prompts utilisateurs d'extraction");
    expect(agentsRes.body).toContain("Instructions système de l'agent");

    const smaAgentsRes = await app.inject({ method: "GET", url: "/agents?domain=sma" });
    expect(smaAgentsRes.statusCode).toBe(200);
    expect(smaAgentsRes.body).toContain('data-testid="agent-resources-neurologist expert"');
    expect(smaAgentsRes.body).toContain("PNDS_Amyotrophie_Spinale_SMA_2025.pdf");

    const chatRes = await app.inject({
      method: "POST",
      url: "/guidelines/chat",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      payload: "question=2e+ligne+apr%C3%A8s+FOLFIRINOX",
    });
    expect(chatRes.statusCode).toBe(200);
    expect(chatRes.body).toContain("gemcitabine");
    expect(chatRes.body).toContain("TNCD_Pancreas_2026.pdf");
    await app.close();
  });

  it("GET /feedback and POST /feedback manage bug reports", async () => {
    const { app } = await createTestApp();
    const getRes = await app.inject({ method: "GET", url: "/feedback" });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toContain("BUG-101");

    const postRes = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "title=Anomalie+affichage+date&description=La+date+RCP+est+vide&category=ui&severity=low&patientOrFile=%23A-1042",
    });
    expect([200, 302]).toContain(postRes.statusCode);

    const afterRes = await app.inject({ method: "GET", url: "/feedback" });
    expect(afterRes.body).toContain("Anomalie affichage date");
    await app.close();
  });

  it("GET /admin/queue and POST /admin/queue/* supervise jobs and locks", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/admin/queue" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("job-running-1042");
    expect(res.body).toContain("job-failed-1039");
    expect(res.body).toContain(
      'data-href="/resolve?target=jeanne_fictive_2026_11_06.pdf&domain=oncology"',
    );
    expect(res.body).toContain('data-testid="drawer-job-job-running-1042"');

    const resolveKnown = await app.inject({
      method: "GET",
      url: "/resolve?target=jeanne_fictive_2026_11_06.pdf&domain=oncology",
    });
    expect(resolveKnown.statusCode).toBe(302);
    expect(resolveKnown.headers.location).toContain("/patients/A-1042");

    const resolvePending = await app.inject({
      method: "GET",
      url: "/resolve?target=courrier_scan_illisible_1039.pdf&domain=oncology",
    });
    expect(resolvePending.statusCode).toBe(302);
    expect(resolvePending.headers.location).toContain("/admin/queue?domain=oncology");

    const retryRes = await app.inject({
      method: "POST",
      url: "/admin/queue/jobs/job-failed-1039/retry",
    });
    expect([200, 302]).toContain(retryRes.statusCode);

    const lockRes = await app.inject({
      method: "POST",
      url: "/admin/queue/locks/release",
    });
    expect([200, 302]).toContain(lockRes.statusCode);

    const cleanRes = await app.inject({
      method: "POST",
      url: "/admin/queue/clean",
    });
    expect([200, 302]).toContain(cleanRes.statusCode);
    await app.close();
  });

  it("GET /ingest and POST /preferences persist theme, language, and expertMode cookies", async () => {
    const { app } = await createTestApp();
    const ingestRes = await app.inject({
      method: "GET",
      url: "/ingest?domain=oncology",
    });
    expect(ingestRes.statusCode).toBe(200);
    expect(ingestRes.body).toContain('data-testid="input-ingest-files"');
    expect(ingestRes.body).toContain('data-testid="btn_ingest_submit"');
    expect(ingestRes.body).toContain('data-contrast="auto"');
    expect(ingestRes.body).toContain('data-contrast-pref="auto"');
    expect(ingestRes.body).toMatch(
      /aria-checked="true"[^>]*data-testid="btn_contrast_auto"|data-testid="btn_contrast_auto"[^>]*aria-checked="true"/,
    );

    const prefRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: "/worklist?domain=oncology",
      },
      payload: "theme=dark&contrast=high&language=en&expertMode=true",
    });
    expect(prefRes.statusCode).toBe(302);
    const setCookies = prefRes.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookies) ? setCookies.join("; ") : String(setCookies ?? "");
    expect(cookieStr).toContain("ds_theme=dark");
    expect(cookieStr).toContain("ds_contrast=high");
    expect(cookieStr).toContain("ds_lang=en");
    expect(cookieStr).toContain("ds_expert=true");

    const hxMediumContrastRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: { "hx-request": "true" },
      payload: { contrast: "medium" },
    });
    expect(hxMediumContrastRes.statusCode).toBe(204);
    expect(hxMediumContrastRes.cookies.find((c) => c.name === "ds_contrast")?.value).toBe("medium");

    const mediumWorklistRes = await app.inject({
      method: "GET",
      url: "/worklist",
      cookies: { ds_contrast: "medium", ds_theme: "light", ds_lang: "en" },
    });
    expect(mediumWorklistRes.statusCode).toBe(200);
    expect(mediumWorklistRes.body).toContain('data-contrast="medium"');
    expect(mediumWorklistRes.body).toContain('data-contrast-pref="medium"');
    expect(mediumWorklistRes.body).not.toContain('title="Plus d\'options"');

    const hxContrastRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: { "hx-request": "true" },
      payload: { contrast: "high" },
    });
    expect(hxContrastRes.statusCode).toBe(204);
    const contrastCookie = hxContrastRes.cookies.find((c) => c.name === "ds_contrast");
    expect(contrastCookie?.value).toBe("high");

    const worklistRes = await app.inject({
      method: "GET",
      url: "/worklist",
      cookies: { ds_contrast: "high", ds_theme: "dark" },
    });
    expect(worklistRes.statusCode).toBe(200);
    expect(worklistRes.body).toContain('data-contrast="high"');
    expect(worklistRes.body).toContain('data-contrast-pref="high"');
    expect(worklistRes.body).toContain('data-testid="contrast-selector"');
    expect(worklistRes.body).toContain('data-testid="btn_contrast_auto"');
    expect(worklistRes.body).toContain('data-testid="btn_contrast_standard"');
    expect(worklistRes.body).toContain('data-testid="btn_contrast_medium"');
    expect(worklistRes.body).toContain('data-testid="btn_contrast_high"');
    await app.close();
  });

  it("GET /files/forms/:filename/pdf and GET /files/resources/:filename serve inline PDFs", async () => {
    const { app } = await createTestApp();
    const formPdf = await app.inject({
      method: "GET",
      url: "/files/forms/jeanne_fictive_2026_11_06.pdf/pdf",
    });
    expect(formPdf.statusCode).toBe(200);
    expect(formPdf.headers["content-type"]).toContain("application/pdf");
    expect(formPdf.headers["content-disposition"]).toContain("inline");

    const resPdf = await app.inject({
      method: "GET",
      url: "/files/resources/TNCD_Pancreas_2026.pdf",
    });
    expect(resPdf.statusCode).toBe(200);
    expect(resPdf.headers["content-type"]).toContain("application/pdf");
    expect(resPdf.headers["x-frame-options"]).toBe("SAMEORIGIN");

    const citationPdf = await app.inject({
      method: "GET",
      url: "/files/resources/TNCD%20Pancr%C3%A9as%20%C2%A74.2?domain=oncology",
    });
    expect(citationPdf.statusCode).toBe(200);
    expect(citationPdf.headers["content-type"]).toContain("application/pdf");

    // SMA PNDS link with em-dash (—), section sign (§), and accents must never throw 500 ERR_INVALID_CHAR
    const smaPndsPdf = await app.inject({
      method: "GET",
      url: `/files/resources/${encodeURIComponent("PNDS — Amyotrophie Spinale 2025 §6.1")}?domain=sma`,
    });
    expect(smaPndsPdf.statusCode).toBe(200);
    expect(smaPndsPdf.headers["content-type"]).toContain("application/pdf");
    expect(smaPndsPdf.headers["content-disposition"]).toMatch(/^[\x20-\x7E]+$/);

    const pdfJsMod = await app.inject({
      method: "GET",
      url: "/public/vendor/pdfjs/pdf.mjs",
    });
    expect(pdfJsMod.statusCode).toBe(200);
    expect(pdfJsMod.headers["content-type"]).toContain("application/javascript");

    const pdfWorkerMod = await app.inject({
      method: "GET",
      url: "/public/vendor/pdfjs/pdf.worker.mjs",
    });
    expect(pdfWorkerMod.statusCode).toBe(200);
    expect(pdfWorkerMod.headers["content-type"]).toContain("application/javascript");
    await app.close();
  });

  it("enforces Zero-Trust proxy secret in oauth_proxy mode, blocks open redirects, and blocks path traversal", async () => {
    expect(verifyProxySecret("secret-123", "secret-123")).toBe(true);
    expect(verifyProxySecret("wrong", "secret-123")).toBe(false);
    expect(verifyProxySecret(undefined, "secret-123")).toBe(false);

    expect(sanitizeLocalRedirect("https://evil.example.com/phish", "/worklist")).toBe("/phish");
    expect(sanitizeLocalRedirect("//evil.example.com", "/worklist")).toBe("/worklist");
    expect(sanitizeLocalRedirect("/\\evil.example.com", "/worklist")).toBe("/worklist");
    expect(sanitizeLocalRedirect("/patients/A-1042?domain=oncology", "/worklist")).toBe(
      "/patients/A-1042?domain=oncology",
    );

    expect(isSafeFilename("jeanne_fictive_2026_11_06.pdf")).toBe(true);
    expect(isSafeFilename("../etc/passwd")).toBe(false);
    expect(isSafeFilename("sub/file.pdf")).toBe(false);

    const api = new InMemoryMedsyntisApiFake();
    const config = loadConfig({
      PORT_WEB: "0",
      APP_DEV_MODE: "false",
      APP_AUTH_MODE: "oauth_proxy",
      APP_PROXY_SECRET: "top-secret-proxy-key",
      APP_API_TOKEN: "top-secret-api-token",
      APP_ADMIN_USERS: "dr.admin",
    });
    expect(config.useFakeApiFallback).toBe(false);
    const app = await buildServer({ config, api });

    // Health endpoint remains accessible for Docker HEALTHCHECK
    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);

    // Unauthenticated request without X-MedSyntis-Proxy-Secret is rejected with 403
    const deniedRes = await app.inject({ method: "GET", url: "/worklist" });
    expect(deniedRes.statusCode).toBe(403);

    // Authenticated request with valid X-MedSyntis-Proxy-Secret + OAuth2-Proxy user header succeeds
    const allowedRes = await app.inject({
      method: "GET",
      url: "/worklist",
      headers: {
        "x-medsyntis-proxy-secret": "top-secret-proxy-key",
        "x-auth-request-preferred-username": "dr.martin",
        "x-auth-request-email": "dr.martin@chu-exemple.fr",
      },
    });
    expect(allowedRes.statusCode).toBe(200);
    expect(allowedRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(allowedRes.headers["x-frame-options"]).toBe("DENY");
    expect(allowedRes.body).toContain("dr.martin@chu-exemple.fr");

    // Non-admin user is denied queue mutation (403)
    const nonAdminQueueRes = await app.inject({
      method: "POST",
      url: "/admin/queue/locks/release",
      headers: {
        "x-medsyntis-proxy-secret": "top-secret-proxy-key",
        "x-auth-request-preferred-username": "dr.martin",
      },
    });
    expect(nonAdminQueueRes.statusCode).toBe(403);

    // Admin user is allowed queue mutation
    const adminQueueRes = await app.inject({
      method: "POST",
      url: "/admin/queue/locks/release",
      headers: {
        "x-medsyntis-proxy-secret": "top-secret-proxy-key",
        "x-auth-request-preferred-username": "dr.admin",
      },
    });
    expect(adminQueueRes.statusCode).toBe(302);

    // sma.<domain> subdomain automatically resolves to the SMA clinical domain and omits ?domain= query strings
    const smaRes = await app.inject({
      method: "GET",
      url: "/worklist",
      headers: {
        host: "sma.medsyntis.bricks-it.fr",
        "x-medsyntis-proxy-secret": "top-secret-proxy-key",
        "x-auth-request-preferred-username": "dr.martin",
      },
    });
    expect(smaRes.statusCode).toBe(200);
    expect(smaRes.body).toContain("Amyotrophie spinale");
    expect(smaRes.body).not.toContain("domain=sma");
    expect(smaRes.body).not.toContain('name="domain"');

    // oncologic.<domain> subdomain automatically resolves to the Oncology clinical domain and omits ?domain= query strings
    const oncoRes = await app.inject({
      method: "GET",
      url: "/worklist",
      headers: {
        host: "oncologic.medsyntis.bricks-it.fr",
        "x-medsyntis-proxy-secret": "top-secret-proxy-key",
        "x-auth-request-preferred-username": "dr.martin",
      },
    });
    expect(oncoRes.statusCode).toBe(200);
    expect(oncoRes.body).toContain("Oncologie");
    expect(oncoRes.body).not.toContain("domain=oncology");
    expect(oncoRes.body).not.toContain('name="domain"');

    // Redundant ?domain= query parameter on a domain-bound host redirects cleanly without domain=
    const redundantQueryRes = await app.inject({
      method: "GET",
      url: "/worklist?domain=oncology&priority=high",
      headers: {
        host: "oncologic.medsyntis.bricks-it.fr",
        "x-medsyntis-proxy-secret": "top-secret-proxy-key",
        "x-auth-request-preferred-username": "dr.martin",
      },
    });
    expect(redundantQueryRes.statusCode).toBe(302);
    expect(redundantQueryRes.headers.location).toBe("/worklist?priority=high");

    // 404 Not Found page with link back to index
    const notFoundRes = await app.inject({
      method: "GET",
      url: "/unknown-route-xyz",
      headers: {
        host: "oncologic.medsyntis.bricks-it.fr",
        "x-medsyntis-proxy-secret": "top-secret-proxy-key",
        "x-auth-request-preferred-username": "dr.martin",
      },
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.body).toContain('data-testid="status-page-404"');
    expect(notFoundRes.body).toContain('href="/worklist"');

    // 503 Maintenance page with link back to index and retry action
    const maintenanceRes = await app.inject({
      method: "GET",
      url: "/maintenance",
      headers: {
        host: "sma.medsyntis.bricks-it.fr",
        "x-medsyntis-proxy-secret": "top-secret-proxy-key",
        "x-auth-request-preferred-username": "dr.martin",
      },
    });
    expect(maintenanceRes.statusCode).toBe(503);
    expect(maintenanceRes.body).toContain('data-testid="status-page-503"');
    expect(maintenanceRes.body).toContain('data-testid="btn_status_home"');
    expect(maintenanceRes.body).toContain('data-testid="btn_status_retry"');

    await app.close();
  });

  it("renders Markdown safely via marked inside AI chat assistant replies", () => {
    const markdown = [
      "## Synthèse clinique",
      "Le patient présente un **adénocarcinome** avec mutation `KRAS`.",
      "",
      "- Stade : *cT3N1M0*",
      "- Traitement : FOLFOX",
      "",
      "<script>alert(1)</script>",
    ].join("\n");

    const html = renderSafeMarkdown(markdown);
    expect(html).toContain("<h2>Synthèse clinique</h2>");
    expect(html).toContain("<strong>adénocarcinome</strong>");
    expect(html).toContain("<code>KRAS</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<em>cT3N1M0</em>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    const partial = renderChatLogMessagePartial("Quel bilan ?", {
      answer: "**Conclusion** : discuter en RCP.",
      references: [],
    });
    expect(partial).toContain('class="ds-chat__markdown"');
    expect(partial).toContain("<strong>Conclusion</strong>");
  });

  it("auto-escapes XSS in html tagged templates, supports HTTP Range (206) & ETag (304) on PDFs/assets, and emits SSE retry directives", async () => {
    const untrusted = '<img src=x onerror="alert(1)">';
    const trusted = "<strong>Validé</strong>";
    const rendered = html`<div data-date="${"2026-11-06T00:00:00Z"}">${untrusted} ${raw(trusted)}</div>`;
    expect(rendered).toBe(
      '<div data-date="06/11/2026">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; <strong>Validé</strong></div>',
    );

    const { app } = await createTestApp();

    // 1. Static asset ETag + 304 Not Modified
    const assetRes = await app.inject({
      method: "GET",
      url: "/public/css/tokens.css",
    });
    expect(assetRes.statusCode).toBe(200);
    const assetEtag = assetRes.headers.etag;
    expect(assetEtag).toBeTruthy();

    const assetCached = await app.inject({
      method: "GET",
      url: "/public/css/tokens.css",
      headers: { "if-none-match": String(assetEtag) },
    });
    expect(assetCached.statusCode).toBe(304);

    // 2. PDF Byte-Range (206 Partial Content) + ETag (304 Not Modified)
    const rangeRes = await app.inject({
      method: "GET",
      url: "/files/forms/jeanne_fictive_2026_11_06.pdf/pdf",
      headers: { range: "bytes=0-4" },
    });
    expect(rangeRes.statusCode).toBe(206);
    expect(rangeRes.headers["accept-ranges"]).toBe("bytes");
    expect(rangeRes.headers["content-range"]).toMatch(/^bytes 0-4\/\d+$/);
    expect(rangeRes.rawPayload.byteLength).toBe(5);

    const pdfEtag = rangeRes.headers.etag;
    const pdfNotModified = await app.inject({
      method: "GET",
      url: "/files/forms/jeanne_fictive_2026_11_06.pdf/pdf",
      headers: { "if-none-match": String(pdfEtag) },
    });
    expect(pdfNotModified.statusCode).toBe(304);

    // 3. SSE /events/queue includes adaptive retry directive and nav badges event
    const sseRes = await app.inject({ method: "GET", url: "/events/queue" });
    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.headers["content-type"]).toContain("text/event-stream");
    expect(sseRes.body).toContain("retry: 3000\nevent: banner\ndata: ");
    expect(sseRes.body).toContain("event: badges\ndata: ");
    expect(sseRes.body).toContain("badge-queue-running");

    await app.close();
  });

  it("distributes domain JSON schemas via GET /api/schema and enforces strict field types on SMA & Oncology section updates without 500 errors", async () => {
    const { app } = await createTestApp();

    // 1. Verify GET /api/schema?domain=sma and GET /api/schema?domain=oncology
    const smaSchemaRes = await app.inject({
      method: "GET",
      url: "/api/schema?domain=sma",
    });
    expect(smaSchemaRes.statusCode).toBe(200);
    const smaSchema = smaSchemaRes.json();
    expect(smaSchema.domain).toBe("sma");
    expect(Array.isArray(smaSchema.sections)).toBe(true);
    const motorSection = smaSchema.sections.find(
      (s: { name: string }) => s.name === "MotorFunctionStatus",
    );
    expect(motorSection?.json_schema?.properties?.hfmse_score).toBeDefined();

    // 2. Verify SMA section edit endpoints render dynamic typed inputs from schema
    const smaMotorEditRes = await app.inject({
      method: "GET",
      url: "/forms/leo_exemple_2026_11_12.pdf/sections/MotorFunctionStatus/edit?domain=sma",
    });
    expect(smaMotorEditRes.statusCode).toBe(200);
    expect(smaMotorEditRes.body).toContain('data-field-type="integer"');
    expect(smaMotorEditRes.body).toContain('data-field-type="select"');
    expect(smaMotorEditRes.body).toContain('data-field-type="string_list"');

    const smaRespEditRes = await app.inject({
      method: "GET",
      url: "/forms/leo_exemple_2026_11_12.pdf/sections/RespiratoryFunction/edit?domain=sma",
    });
    expect(smaRespEditRes.statusCode).toBe(200);
    expect(smaRespEditRes.body).toContain('data-field-type="boolean"');
    expect(smaRespEditRes.body).toContain('data-field-type="float"');

    // 3. Update SMA MotorFunctionStatus with mixed string/number/placeholder inputs — must coerce cleanly (200 OK)
    const updateMotorRes = await app.inject({
      method: "POST",
      url: "/forms/leo_exemple_2026_11_12.pdf/sections/MotorFunctionStatus?domain=sma",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      payload:
        "best_motor_function=Assis+sans+appui+%28Sitter%29&hfmse_score=44&chop_intend_score=Non+renseign%C3%A9&rulm_score=31&motor_milestones=Station+assise+autonome%0APropulsion+fauteuil&physiotherapy_frequency=3+s%C3%A9ances+%2F+semaine",
    });
    expect(updateMotorRes.statusCode).toBe(200);
    expect(updateMotorRes.body).toContain(
      '<span class="ds-kv__value  ds-markdown-inline">44</span>',
    );
    expect(updateMotorRes.body).toContain("Station assise autonome ; Propulsion fauteuil");
    expect(updateMotorRes.body).toContain("Modifié manuellement");

    // 4. Update SMA RespiratoryFunction with boolean and float fields
    const updateRespRes = await app.inject({
      method: "POST",
      url: "/forms/leo_exemple_2026_11_12.pdf/sections/RespiratoryFunction?domain=sma",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      payload:
        "non_invasive_ventilation=false&daily_ventilation_hours=&forced_vital_capacity_percent=79.5&cough_assist_used=true&respiratory_infections_history=Aucune+infection",
    });
    expect(updateRespRes.statusCode).toBe(200);
    expect(updateRespRes.body).toContain("79.5");
    expect(updateRespRes.body).toContain("Modifié manuellement");

    await app.close();
  });

  it("renders visual processing indicators and auto-refresh attributes when a fiche is in progress, and adapts delete dialogs to patient names", async () => {
    const { app, api } = await createTestApp();

    // Trigger processing on jeanne_fictive_2026_11_06.pdf
    await api.processFullForm("jeanne_fictive_2026_11_06.pdf", true, "oncology");

    // 1. Worklist Table view shows processing badge & auto-refresh attribute and adapted delete dialog
    const worklistRes = await app.inject({
      method: "GET",
      url: "/worklist?domain=oncology",
    });
    expect(worklistRes.statusCode).toBe(200);
    expect(worklistRes.body).toContain('data-testid="badge-processing-A-1042"');
    expect(worklistRes.body).toContain('data-processing-active="true"');
    expect(worklistRes.body).toContain('data-patient-name="FICTIVE Jeanne"');
    expect(worklistRes.body).toContain(
      "Supprimer le dossier de <span data-del-patient-name>FICTIVE Jeanne</span> ?",
    );
    expect(worklistRes.body).toContain(
      "<strong data-del-patient-name>FICTIVE Jeanne</strong> (#A-1042)",
    );

    // 2. Worklist Cards view also contains delete menu button and dialog
    const cardsRes = await app.inject({
      method: "GET",
      url: "/worklist?domain=oncology&display=cards",
    });
    expect(cardsRes.statusCode).toBe(200);
    expect(cardsRes.body).toContain('data-testid="badge-processing-A-1042"');
    expect(cardsRes.body).toContain('data-open="del-dialog-A-1042"');
    expect(cardsRes.body).toContain('id="del-dialog-A-1042"');

    // 3. Dossier view shows processing badge in header and M3 processing banner with auto-refresh attribute
    const dossierRes = await app.inject({
      method: "GET",
      url: "/patients/A-1042?domain=oncology",
    });
    expect(dossierRes.statusCode).toBe(200);
    expect(dossierRes.body).toContain('data-testid="badge-processing-status"');
    expect(dossierRes.body).toContain('data-testid="dossier-processing-banner"');
    expect(dossierRes.body).toContain('data-processing-active="true"');
    expect(dossierRes.body).toContain('id="delete-dossier-modal"');
    expect(dossierRes.body).toContain(
      "Supprimer le dossier de <span data-del-patient-name>FICTIVE Jeanne</span> ?",
    );

    // 4. Deleting a single form via POST /forms/:filename/delete redirects to /worklist
    const delFormRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_09_18.pdf/delete?domain=oncology",
    });
    expect(delFormRes.statusCode).toBe(302);
    expect(delFormRes.headers.location).toContain("/worklist");

    // Trigger processing on paul_modele_2026_11_06.pdf (#A-1037, which had 0 missing items)
    // While AI processing is active, it must NOT be marked as "Dossier complet" in the worklist
    await api.processFullForm("paul_modele_2026_11_06.pdf", true, "oncology");
    const worklistWhilePaulProcessing = await app.inject({
      method: "GET",
      url: "/worklist?domain=oncology",
    });
    expect(worklistWhilePaulProcessing.statusCode).toBe(200);
    expect(worklistWhilePaulProcessing.body).toContain('data-testid="badge-processing-A-1037"');
    expect(worklistWhilePaulProcessing.body).toContain("En attente IA");
    expect(worklistWhilePaulProcessing.body).not.toContain("Dossier complet");

    // Complete filter must exclude records whose AI analysis is not completed
    const completeOnlyRes = await app.inject({
      method: "GET",
      url: "/worklist?domain=oncology&completeness=complete",
    });
    expect(completeOnlyRes.statusCode).toBe(200);
    expect(completeOnlyRes.body).not.toContain("MODÈLE Paul");

    await app.close();
  });

  it("handles delete endpoints, form view, link-patient, non-htmx chat, multipart uploads, and error/not-found routes", async () => {
    const { app } = await createTestApp();

    // 1. GET /forms/:filename (200 OK & 404 Not Found) and GET /patients/:patientId (404 Not Found)
    const formViewRes = await app.inject({
      method: "GET",
      url: "/forms/jeanne_fictive_2026_11_06.pdf?domain=oncology&from=agenda",
    });
    expect(formViewRes.statusCode).toBe(200);
    expect(formViewRes.body).toContain("jeanne_fictive_2026_11_06.pdf");

    const formNotFound = await app.inject({
      method: "GET",
      url: "/forms/unknown_missing.pdf?domain=oncology",
    });
    expect(formNotFound.statusCode).toBe(404);

    const patientNotFound = await app.inject({
      method: "GET",
      url: "/patients/P-UNKNOWN-999?domain=oncology",
    });
    expect(patientNotFound.statusCode).toBe(404);

    // 2. GET /forms/:filename/sections/:section/edit (non-htmx view=1 redirect, non-htmx edit page, and 404)
    const secEditNotFound = await app.inject({
      method: "GET",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/NonExistentSection/edit?domain=oncology",
    });
    expect(secEditNotFound.statusCode).toBe(404);

    const secCancelRedirect = await app.inject({
      method: "GET",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/ChemotherapyTreament/edit?view=1&domain=oncology",
    });
    expect(secCancelRedirect.statusCode).toBe(302);

    const secFullPageEdit = await app.inject({
      method: "GET",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/ChemotherapyTreament/edit?domain=oncology",
    });
    expect(secFullPageEdit.statusCode).toBe(200);

    // Non-htmx POST section update & rollback redirect
    const secUpdateRedirect = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/ChemotherapyTreament?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "chemotherapy_name=FOLFIRINOX",
    });
    expect(secUpdateRedirect.statusCode).toBe(302);

    const secRollbackRedirect = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/sections/ChemotherapyTreament/rollback?domain=oncology",
    });
    expect(secRollbackRedirect.statusCode).toBe(302);

    // 3. POST /forms/:filename/process & POST /forms/:filename/link-patient
    const processFormRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/process?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "preserve_manual_edits=true",
    });
    expect(processFormRes.statusCode).toBe(302);

    const linkPatientRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/link-patient?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "patientId=A-1042",
    });
    expect(linkPatientRes.statusCode).toBe(302);
    expect(linkPatientRes.headers.location).toContain("/patients/A-1042");

    const unlinkPatientRes = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/link-patient?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "patientId=",
    });
    expect(unlinkPatientRes.statusCode).toBe(302);
    expect(unlinkPatientRes.headers.location).toContain("/forms/jeanne_fictive_2026_11_06.pdf");

    // Re-link back to A-1042
    await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/link-patient?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "patientId=A-1042",
    });

    // 4. Non-htmx POST /patients/:patientId/chat, POST /forms/:filename/chat (htmx & non-htmx), POST /guidelines/chat (non-htmx)
    const patientChatFull = await app.inject({
      method: "POST",
      url: "/patients/A-1042/chat?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "question=Bilan+biologique&scope=form&filename=jeanne_fictive_2026_11_06.pdf",
    });
    expect(patientChatFull.statusCode).toBe(200);

    const formChatHtmx = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/chat?domain=oncology",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      payload: "question=Resume+clinique",
    });
    expect(formChatHtmx.statusCode).toBe(200);

    const formChatFull = await app.inject({
      method: "POST",
      url: "/forms/jeanne_fictive_2026_11_06.pdf/chat?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "question=Resume+clinique",
    });
    expect(formChatFull.statusCode).toBe(200);

    const guidelinesChatFull = await app.inject({
      method: "POST",
      url: "/guidelines/chat?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "question=Protocole+FOLFIRINOX&filename=TNCD_Pancreas_2026.pdf",
    });
    expect(guidelinesChatFull.statusCode).toBe(200);

    // 5. Guidelines upload (multipart), reindex, and delete
    const boundary = "----WebKitFormBoundaryTest123";
    const multipartBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="patientId"',
      "",
      "A-1042",
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="nouveau_doc_test.pdf"',
      "Content-Type: application/pdf",
      "",
      "%PDF-1.4 fake pdf content",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const ingestUploadRes = await app.inject({
      method: "POST",
      url: "/ingest/upload?domain=oncology",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });
    expect(ingestUploadRes.statusCode).toBe(302);
    expect(ingestUploadRes.headers.location).toContain("batchId=");

    const batchStatusRes = await app.inject({
      method: "GET",
      url: "/ingest/batches/batch-test?domain=oncology",
    });
    expect(batchStatusRes.statusCode).toBe(200);

    const ingestWithBatchPage = await app.inject({
      method: "GET",
      url: "/ingest?domain=oncology&batchId=batch-test",
    });
    expect(ingestWithBatchPage.statusCode).toBe(200);

    const guidelineUploadRes = await app.inject({
      method: "POST",
      url: "/guidelines/upload?domain=oncology",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });
    expect(guidelineUploadRes.statusCode).toBe(302);

    const reindexBad = await app.inject({
      method: "POST",
      url: "/guidelines/..%2Fbad.pdf/reindex?domain=oncology",
    });
    expect(reindexBad.statusCode).toBe(400);

    const reindexOk = await app.inject({
      method: "POST",
      url: "/guidelines/TNCD_Pancreas_2026.pdf/reindex?domain=oncology",
    });
    expect(reindexOk.statusCode).toBe(302);
    expect(reindexOk.headers.location).toContain("/guidelines?file=TNCD_Pancreas_2026.pdf");

    const reindexFromAgents = await app.inject({
      method: "POST",
      url: "/guidelines/TNCD_Pancreas_2026.pdf/reindex?domain=oncology",
      headers: { referer: "http://localhost:3000/agents?domain=oncology" },
    });
    expect(reindexFromAgents.statusCode).toBe(302);
    expect(reindexFromAgents.headers.location).toBe("/agents?domain=oncology");

    const deleteGuidelineBad = await app.inject({
      method: "POST",
      url: "/guidelines/..%2Fbad.pdf/delete?domain=oncology",
    });
    expect(deleteGuidelineBad.statusCode).toBe(400);

    const deleteGuidelineOk = await app.inject({
      method: "POST",
      url: "/guidelines/nouveau_doc_test.pdf/delete?domain=oncology",
    });
    expect(deleteGuidelineOk.statusCode).toBe(302);

    // 6. PDF edge cases (400 invalid filename, 404 missing PDF, resource fallback to formFile)
    const badFormPdf = await app.inject({
      method: "GET",
      url: "/files/forms/..%2Fsecret.pdf/pdf",
    });
    expect(badFormPdf.statusCode).toBe(400);

    const plainFormPdf = await app.inject({
      method: "GET",
      url: "/files/forms/jeanne_fictive_2026_11_06.pdf/pdf",
    });
    expect(plainFormPdf.statusCode).toBe(200);

    const badResPdf = await app.inject({
      method: "GET",
      url: "/files/resources/..%2Fsecret.pdf",
    });
    expect(badResPdf.statusCode).toBe(400);

    const fallbackResPdf = await app.inject({
      method: "GET",
      url: "/files/resources/unknown_ref.pdf?formFile=jeanne_fictive_2026_11_06.pdf&domain=oncology",
    });
    expect(fallbackResPdf.statusCode).toBe(200);
    expect(fallbackResPdf.rawPayload.equals(plainFormPdf.rawPayload)).toBe(true);

    const missingResPdf = await app.inject({
      method: "GET",
      url: "/files/resources/unknown_ref.pdf?domain=oncology",
    });
    expect(missingResPdf.statusCode).toBe(404);

    // 7. Feedback status update & Queue job delete
    const feedbackStatusRes = await app.inject({
      method: "POST",
      url: "/feedback/BUG-101/status?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "status=resolved",
    });
    expect(feedbackStatusRes.statusCode).toBe(302);

    const delQueueJobRes = await app.inject({
      method: "POST",
      url: "/admin/queue/jobs/job-failed-1039/delete?domain=oncology",
    });
    expect(delQueueJobRes.statusCode).toBe(302);

    // 8. Delete form and patient via DELETE & POST endpoints
    const delFormApi = await app.inject({
      method: "DELETE",
      url: "/forms/jeanne_fictive_2026_09_18.pdf?domain=oncology",
    });
    expect(delFormApi.statusCode).toBe(200);

    const delPatientPdfPost = await app.inject({
      method: "POST",
      url: "/patients/jeanne_fictive_2026_11_06.pdf/delete?domain=oncology",
    });
    expect(delPatientPdfPost.statusCode).toBe(302);

    const delPatientPost = await app.inject({
      method: "POST",
      url: "/patients/A-1042/delete?domain=oncology",
    });
    expect(delPatientPost.statusCode).toBe(302);

    const delPatientPdfApi = await app.inject({
      method: "DELETE",
      url: "/patients/paul_modele_2026_11_06.pdf?domain=oncology",
    });
    expect(delPatientPdfApi.statusCode).toBe(200);

    const delPatientApi = await app.inject({
      method: "DELETE",
      url: "/patients/A-1037?domain=oncology",
    });
    expect(delPatientApi.statusCode).toBe(200);

    await app.close();
  });

  it("renders Patient Dashboard at patient level (outside single-RCP split view) with M3 ds-* components, ECharts SVG curves, and clinical labels without technical class names", async () => {
    const { app } = await createTestApp();

    // 1. Default patient selection opens #tab-patient-rcp (Séances RCP) first, NOT the dashboard
    const dossierRes = await app.inject({
      method: "GET",
      url: "/patients/A-1042?domain=oncology",
    });
    expect(dossierRes.statusCode).toBe(200);
    expect(dossierRes.body).toContain(
      'id="tab-patient-rcp" aria-selected="true" aria-controls="patient-workspace-rcp"',
    );
    expect(dossierRes.body).toContain(
      'id="tab-patient-dashboard" aria-selected="false" aria-controls="panel-patient-dashboard"',
    );
    expect(dossierRes.body).toContain(
      'id="tab-clinical" aria-selected="true" aria-controls="panel-clinical"',
    );
    expect(dossierRes.body).toContain('data-patient-view="rcp"');

    // Fiche-level reprocess controls: desktop direct button + mobile discreet menu + confirmation protection
    expect(dossierRes.body).toContain('data-testid="btn_reprocess_form"');
    expect(dossierRes.body).toContain('data-testid="menu-clinical-mobile-actions"');
    expect(dossierRes.body).toContain('data-testid="btn_reprocess_form_mobile"');
    expect(dossierRes.body).toContain("data-confirm=");
    expect(dossierRes.body).toContain('class="ds-reprocess-btn--desktop"');
    expect(dossierRes.body).toContain('class="ds-menu ds-reprocess-menu--mobile"');

    // Tab button itself must NOT contain any obsolete warning badge
    const tabBtnMatch = dossierRes.body.match(
      /<button[^>]*id="tab-patient-dashboard"[^>]*>([\s\S]*?)<\/button>/,
    );
    expect(tabBtnMatch).not.toBeNull();
    expect(tabBtnMatch?.[1]).toContain("Tableau de bord patient");
    expect(tabBtnMatch?.[1]).not.toContain("Obsolète");
    expect(tabBtnMatch?.[1]).not.toContain("⚠️");

    // Inside #panel-patient-dashboard: M3 ds-* summary card + ECharts SVG curves + zero technical Section.field strings
    expect(dossierRes.body).toContain('id="panel-patient-dashboard"');
    expect(dossierRes.body).toContain('id="patient-summary-card"');
    expect(dossierRes.body).toContain(
      'class="ds-alert ds-alert--warning" role="status" data-testid="alert_summary_obsolete"',
    );
    expect(dossierRes.body).toContain('data-testid="patient_dashboard_charts_grid"');
    expect(dossierRes.body).toContain('data-testid="patient_dashboard_raw_table"');
    expect(dossierRes.body).toContain("<svg ");
    expect(dossierRes.body).not.toContain(">CancerDescription.tnm_status<");
    expect(dossierRes.body).not.toContain(">ChemotherapyTreament.chemotherapy_name<");

    // 2. Trigger on-demand summary regeneration via POST /patients/A-1042/summary
    const triggerRes = await app.inject({
      method: "POST",
      url: "/patients/A-1042/summary?domain=oncology",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "force=true",
    });
    expect(triggerRes.statusCode).toBe(302);
    expect(triggerRes.headers.location).toBe(
      "/patients/A-1042?domain=oncology&view=dashboard#patient-summary-card",
    );

    // 3. Following the redirect with ?view=dashboard opens the full-width patient dashboard view with an up-to-date summary
    const updatedRes = await app.inject({
      method: "GET",
      url: "/patients/A-1042?domain=oncology&view=dashboard",
    });
    expect(updatedRes.statusCode).toBe(200);
    expect(updatedRes.body).toContain('data-patient-view="dashboard"');
    expect(updatedRes.body).toContain(
      'id="tab-patient-dashboard" aria-selected="true" aria-controls="panel-patient-dashboard"',
    );
    expect(updatedRes.body).toContain('data-testid="badge_summary_up_to_date"');
    expect(updatedRes.body).not.toContain('data-testid="alert_summary_obsolete"');

    // 4. SMA patient S-0007 renders a single combined MFM chart (Total + D1/D2/D3) with legend, interactive point hover metadata, RULM chart, and NO HFMSE chart
    const smaRes = await app.inject({
      method: "GET",
      url: "/patients/S-0007?domain=sma&view=dashboard",
    });
    expect(smaRes.statusCode).toBe(200);
    expect(smaRes.body).toContain('data-testid="metric_chart_MotorFunctionStatus.mfm_total_score"');
    expect(smaRes.body).toContain('data-mfm-combined="true"');
    expect(smaRes.body).toContain('data-testid="mfm_chart_legend"');
    expect(smaRes.body).toContain(
      'data-testid="mfm_legend_item_MotorFunctionStatus.mfm_total_score"',
    );
    expect(smaRes.body).toContain('data-testid="mfm_legend_item_MotorFunctionStatus.mfm_d1_score"');
    expect(smaRes.body).toContain('data-testid="mfm_legend_item_MotorFunctionStatus.mfm_d2_score"');
    expect(smaRes.body).toContain('data-testid="mfm_legend_item_MotorFunctionStatus.mfm_d3_score"');
    expect(smaRes.body).toContain('data-chart-point="true"');
    expect(smaRes.body).toContain('data-point-value="65.6 %"');
    expect(smaRes.body).toContain('data-testid="chart_point_tooltip"');
    expect(smaRes.body).not.toContain(
      'data-testid="metric_chart_MotorFunctionStatus.mfm_d1_score"',
    );
    expect(smaRes.body).not.toContain('data-testid="metric_chart_MotorFunctionStatus.hfmse_score"');
    expect(smaRes.body).toContain('data-testid="metric_chart_MotorFunctionStatus.rulm_score"');
    expect(smaRes.body).toContain("Station assise sans appui");
    expect(smaRes.body).toContain("Position assise autonome stable");
    expect(smaRes.body).toContain("Voie orale");
    expect(smaRes.body).not.toContain(">MotorFunctionStatus.motor_milestones<");
    expect(smaRes.body).not.toContain(">RespiratoryFunction.ventilation_type<");

    await app.close();
  });

  it("supports human editing, saving, and rollback of CareOrientationProposal with authenticated editedBy", async () => {
    const api = new InMemoryMedsyntisApiFake();
    const config = loadConfig({
      APP_DEV_MODE: "false",
      APP_AUTH_MODE: "oauth_proxy",
      APP_PROXY_SECRET: "proxy-secret-xyz",
      APP_API_TOKEN: "api-token-xyz",
      APP_ADMIN_USERS: "dr.martin",
    });
    const app = await buildServer({ config, api });
    const authHeaders = {
      "x-proxy-secret": "proxy-secret-xyz",
      "x-forwarded-user": "dr.martin",
      "x-forwarded-preferred-username": "Dr Claire Martin",
    };

    const cards = await api.listPatientCards("oncology");
    const targetFile = cards[0]!.file;

    // 1. Inline edit partial for CareOrientationProposal renders editable fields
    const editPartialRes = await app.inject({
      method: "GET",
      url: `/forms/${encodeURIComponent(targetFile)}/sections/CareOrientationProposal/edit?domain=oncology`,
      headers: { ...authHeaders, "hx-request": "true" },
    });
    expect(editPartialRes.statusCode).toBe(200);
    expect(editPartialRes.body).toContain('name="care_adaptation_suggested"');
    expect(editPartialRes.body).toContain('name="suggested_priority"');
    expect(editPartialRes.body).toContain('name="priority_reason"');
    expect(editPartialRes.body).toContain('name="proposed_care_type"');
    expect(editPartialRes.body).toContain('name="orientation_rationale"');

    // 2. Save human-edited CareOrientationProposal and verify authenticated editedBy
    const saveRes = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(targetFile)}/sections/CareOrientationProposal?domain=oncology`,
      headers: { ...authHeaders, "hx-request": "true", "x-requested-with": "fetch" },
      payload: {
        care_adaptation_suggested: "true",
        suggested_priority: "Patient must be seen quickly (urgent)",
        priority_reason: "Validation collégiale urgente",
        proposed_care_type: "Chirurgie pancréatique après réévaluation",
        orientation_rationale: "Orientation validée par Dr Claire Martin (CSP Art. L. 4001-2).",
      },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body).toContain("Modifié manuellement par dr.martin");
    expect(saveRes.body).toContain("Chirurgie pancréatique après réévaluation");

    // 3. Rollback restores original AI proposal
    const rollbackRes = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(targetFile)}/sections/CareOrientationProposal/rollback?domain=oncology`,
      headers: { ...authHeaders, "hx-request": "true", "x-requested-with": "fetch" },
    });
    expect(rollbackRes.statusCode).toBe(200);
    expect(rollbackRes.body).not.toContain("Modifié manuellement par dr.martin");

    await app.close();
  });

  it("surfaces non-200 errors (422 validation & 502 upstream) on failed clinical section save and rollback", async () => {
    const { app, api } = await createTestApp();
    const cards = await api.listPatientCards("oncology");
    const targetFile = cards[0]!.file;

    // 1. AJAX save with date_birth > date_rcp returns HTTP 422 JSON error instead of silently mutating date_birth or returning 200
    const badDobRes = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(targetFile)}/sections/PatientAdministrative?domain=oncology`,
      headers: { "hx-request": "true", "x-requested-with": "fetch" },
      payload: {
        first_name: "Jeanne",
        last_name: "FICTIVE",
        date_birth: "2028-05-01",
        date_rcp: "2026-11-06",
      },
    });
    expect(badDobRes.statusCode).toBe(422);
    expect(badDobRes.json()).toEqual({
      ok: false,
      error: "La date de naissance ne peut pas être postérieure à la date de la RCP.",
    });

    // 2. Non-JS full-page form fallback redirects with save_error and renders visible danger alert banner
    const nonJsBadDobRes = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(targetFile)}/sections/PatientAdministrative?domain=oncology`,
      headers: { accept: "text/html,application/xhtml+xml" },
      payload: {
        first_name: "Jeanne",
        last_name: "FICTIVE",
        date_birth: "2028-05-01",
        date_rcp: "2026-11-06",
      },
    });
    expect(nonJsBadDobRes.statusCode).toBe(302);
    expect(nonJsBadDobRes.headers.location).toContain("save_error=");
    expect(nonJsBadDobRes.headers.location).not.toContain("saved=1");

    const redirectedPage = await app.inject({
      method: "GET",
      url: nonJsBadDobRes.headers.location!,
    });
    expect(redirectedPage.statusCode).toBe(200);
    expect(redirectedPage.body).toContain('data-testid="section-save-error-banner"');
    expect(redirectedPage.body).toContain(
      "La date de naissance ne peut pas être postérieure à la date de la RCP.",
    );

    // 3. Upstream API error on save or rollback returns HTTP 502 JSON error
    const updateSpy = vi
      .spyOn(api, "updateFormSection")
      .mockRejectedValueOnce(new Error("MongoDB primary stepdown"));
    const upstreamSaveErr = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(targetFile)}/sections/TumorBiology?domain=oncology`,
      headers: { "hx-request": "true", "x-requested-with": "fetch" },
      payload: { msi_state: "true" },
    });
    expect(upstreamSaveErr.statusCode).toBe(502);
    expect(upstreamSaveErr.json()).toEqual({
      ok: false,
      error: "MongoDB primary stepdown",
    });
    updateSpy.mockRestore();

    const rollbackSpy = vi
      .spyOn(api, "rollbackSection")
      .mockRejectedValueOnce(new Error("FastAPI connection refused"));
    const upstreamRollbackErr = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(targetFile)}/sections/TumorBiology/rollback?domain=oncology`,
      headers: { "hx-request": "true", "x-requested-with": "fetch" },
    });
    expect(upstreamRollbackErr.statusCode).toBe(502);
    expect(upstreamRollbackErr.json()).toEqual({
      ok: false,
      error: "FastAPI connection refused",
    });
    rollbackSpy.mockRestore();

    await app.close();
  });

  it("enforces CSRF protection, HSTS, fail-closed prod RBAC, startup secret validation, and AsyncLocalStorage context isolation", async () => {
    // 1. Startup config validation requires APP_PROXY_SECRET outside devMode for BOTH oauth_proxy and local auth modes
    expect(() =>
      validateStartupConfig(
        loadConfig({
          APP_DEV_MODE: "false",
          APP_AUTH_MODE: "local",
          APP_API_TOKEN: "tok",
          APP_PROXY_SECRET: "",
        }),
      ),
    ).toThrow(/APP_PROXY_SECRET/);
    expect(() =>
      validateStartupConfig(
        loadConfig({
          APP_DEV_MODE: "false",
          APP_AUTH_MODE: "oauth_proxy",
          APP_API_TOKEN: "tok",
          APP_PROXY_SECRET: "",
        }),
      ),
    ).toThrow(/APP_PROXY_SECRET/);

    // 2. Production server with empty APP_ADMIN_USERS is fail-closed (isAdmin === false)
    const api = new InMemoryMedsyntisApiFake();
    const prodConfig = loadConfig({
      APP_DEV_MODE: "false",
      APP_AUTH_MODE: "oauth_proxy",
      APP_PROXY_SECRET: "prod-secret",
      APP_API_TOKEN: "prod-token",
      APP_ADMIN_USERS: "",
      APP_DOMAIN: "oncology",
      APP_ALLOWED_DOMAINS: "oncology,sma",
    });
    const app = await buildServer({ config: prodConfig, api });
    const nonAdminHeaders = {
      "x-proxy-secret": "prod-secret",
      "x-forwarded-user": "dr.dupont",
      "x-real-ip": "10.99.0.12",
      "x-forwarded-for": "203.0.113.99",
    };

    // HSTS header is emitted outside devMode
    const getWorklist = await app.inject({
      method: "GET",
      url: "/worklist?domain=oncology",
      headers: nonAdminHeaders,
    });
    expect(getWorklist.statusCode).toBe(200);
    expect(getWorklist.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );

    // CSRF guard rejects cross-site Sec-Fetch-Site and mismatched Origin host
    const csrfSecFetchRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: {
        ...nonAdminHeaders,
        "sec-fetch-site": "cross-site",
      },
      payload: { theme: "dark" },
    });
    expect(csrfSecFetchRes.statusCode).toBe(403);

    const csrfOriginMismatchRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: {
        ...nonAdminHeaders,
        host: "medsyntis.chu.local",
        origin: "https://evil.example",
      },
      payload: { theme: "dark" },
    });
    expect(csrfOriginMismatchRes.statusCode).toBe(403);

    const csrfSameOriginRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: {
        ...nonAdminHeaders,
        host: "medsyntis.chu.local",
        origin: "https://medsyntis.chu.local",
        "hx-request": "true",
      },
      payload: { theme: "dark" },
    });
    expect(csrfSameOriginRes.statusCode).toBe(204);

    // Same-origin HTML <form method="post"> under Referrer-Policy: no-referrer sends Origin: "null" + Sec-Fetch-Site: "same-origin"
    const csrfNullOriginSameOriginFetchSiteRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: {
        ...nonAdminHeaders,
        host: "medsyntis.chu.local",
        origin: "null",
        "sec-fetch-site": "same-origin",
        "hx-request": "true",
      },
      payload: { theme: "dark" },
    });
    expect(csrfNullOriginSameOriginFetchSiteRes.statusCode).toBe(204);

    // Unattested Origin: "null" without Sec-Fetch-Site: "same-origin" (e.g. sandboxed iframe) must still be rejected
    const csrfNullOriginUnattestedRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: {
        ...nonAdminHeaders,
        host: "medsyntis.chu.local",
        origin: "null",
      },
      payload: { theme: "dark" },
    });
    expect(csrfNullOriginUnattestedRes.statusCode).toBe(403);

    const csrfNullOriginSameSiteRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: {
        ...nonAdminHeaders,
        host: "medsyntis.chu.local",
        origin: "null",
        "sec-fetch-site": "same-site",
      },
      payload: { theme: "dark" },
    });
    expect(csrfNullOriginSameSiteRes.statusCode).toBe(403);

    const csrfMalformedOriginRes = await app.inject({
      method: "POST",
      url: "/preferences",
      headers: {
        ...nonAdminHeaders,
        host: "medsyntis.chu.local",
        origin: "not-a-valid-url",
        "sec-fetch-site": "same-origin",
      },
      payload: { theme: "dark" },
    });
    expect(csrfMalformedOriginRes.statusCode).toBe(403);

    // Production Caddyfile must align Referrer-Policy with "same-origin" so HTML <form method="post"> preserves Origin
    const caddyfilePath = path.resolve(process.cwd(), "../dist/docker/compose/Caddyfile");
    if (fs.existsSync(caddyfilePath)) {
      const caddyfileContent = fs.readFileSync(caddyfilePath, "utf8");
      expect(caddyfileContent).toContain('Referrer-Policy "same-origin"');
      expect(caddyfileContent).not.toContain('Referrer-Policy "no-referrer"');
    }

    // Non-admin user receives HTTP 403 on all destructive admin routes
    for (const route of [
      { method: "POST" as const, url: "/patients/A-1042/delete?domain=oncology" },
      { method: "DELETE" as const, url: "/patients/A-1042?domain=oncology" },
      { method: "POST" as const, url: "/forms/jeanne_2026_11.pdf/delete?domain=oncology" },
      { method: "POST" as const, url: "/guidelines/TNCD_Pancreas.pdf/delete?domain=oncology" },
      { method: "POST" as const, url: "/feedback/BUG-001/status?domain=oncology" },
      { method: "POST" as const, url: "/feedback/BUG-001/delete?domain=oncology" },
      { method: "POST" as const, url: "/admin/queue/locks/release?domain=oncology" },
      { method: "POST" as const, url: "/admin/queue/clean?domain=oncology" },
      { method: "POST" as const, url: "/admin/queue/jobs/JOB-1/delete?domain=oncology" },
    ]) {
      const forbiddenRes = await app.inject({
        method: route.method,
        url: route.url,
        headers: nonAdminHeaders,
      });
      expect(forbiddenRes.statusCode).toBe(403);
    }

    // Domain-scoped queue visibility: non-admin requesting /queue?domain=oncology only gets oncology jobs (allDomains === false)
    const listJobsSpy = vi.spyOn(api, "listQueueJobs");
    const queuePageRes = await app.inject({
      method: "GET",
      url: "/queue?domain=oncology",
      headers: nonAdminHeaders,
    });
    expect(queuePageRes.statusCode).toBe(200);
    expect(listJobsSpy).toHaveBeenCalledWith("oncology", false);
    listJobsSpy.mockRestore();

    // Spoof-resistant clientIp & concurrent AsyncLocalStorage context isolation
    const observedContexts: Array<{ userId?: string; clientIp?: string }> = [];
    const listCardsOrig = api.listPatientCards.bind(api);
    vi.spyOn(api, "listPatientCards").mockImplementation(async (d) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const store = bffRequestContext.getStore();
      observedContexts.push({ userId: store?.userId, clientIp: store?.clientIp });
      return listCardsOrig(d);
    });

    await Promise.all([
      app.inject({
        method: "GET",
        url: "/worklist?domain=oncology",
        headers: {
          "x-proxy-secret": "prod-secret",
          "x-forwarded-user": "dr.alpha",
          "x-real-ip": "10.1.1.1",
          "x-forwarded-for": "198.51.100.77",
        },
      }),
      app.inject({
        method: "GET",
        url: "/worklist?domain=oncology",
        headers: {
          "x-proxy-secret": "prod-secret",
          "x-forwarded-user": "dr.beta",
          // No x-real-ip -> falls back to Fastify req.ip (127.0.0.1 in inject), NOT forged x-forwarded-for
          "x-forwarded-for": "198.51.100.88",
        },
      }),
    ]);

    expect(observedContexts).toContainEqual({ userId: "dr.alpha", clientIp: "10.1.1.1" });
    expect(observedContexts).toContainEqual({ userId: "dr.beta", clientIp: "127.0.0.1" });

    // UI medico-legal & GDPR notices and retry link fallback
    const dossierRes = await app.inject({
      method: "GET",
      url: "/patients/A-1042?domain=oncology",
      headers: nonAdminHeaders,
    });
    expect(dossierRes.body).toContain('data-testid="ai-chat-disclaimer"');
    expect(dossierRes.body).toContain('id="btn_fab_ai_chat"');

    const feedbackRes = await app.inject({
      method: "GET",
      url: "/feedback?domain=oncology",
      headers: nonAdminHeaders,
    });
    expect(feedbackRes.body).toContain('data-testid="feedback-gdpr-warning"');

    const statusHtml = renderStatusPage({
      statusCode: 503,
      kind: "maintenance",
      session: {
        userId: "dr.dupont",
        userName: "Dr Dupont",
        domain: "oncology",
        allowedDomains: ["oncology"],
        hostBoundDomain: false,
        language: "fr",
        theme: "auto",
        expertMode: false,
        isAdmin: false,
      },
    });
    expect(statusHtml).toContain('href="/" data-testid="btn_status_retry"');
    expect(statusHtml).toContain('data-contrast="auto"');
    expect(statusHtml).toContain('data-contrast-pref="auto"');

    // Status page EN / SMA / high-contrast & all status kinds + validation cleaners
    for (const kind of ["forbidden", "not_found", "maintenance", "server_error"] as const) {
      const enSmaHtml = renderStatusPage({
        statusCode: kind === "forbidden" ? 403 : kind === "not_found" ? 404 : 500,
        kind,
        retryHref: "/agenda",
        session: {
          userId: "dr.smith",
          userName: "Dr Smith",
          domain: "sma",
          allowedDomains: ["sma"],
          hostBoundDomain: true,
          language: "en",
          theme: "dark",
          contrast: "high",
          expertMode: true,
          isAdmin: false,
        },
      });
      expect(enSmaHtml).toContain("Rare Diseases MDT");
      expect(enSmaHtml).toContain('data-contrast="high"');
    }
    expect(formatCleanIsoDate(null)).toBeNull();
    expect(formatCleanIsoDate("Not_given")).toBeNull();
    expect(formatCleanIsoDate("2026-11-06T12:30:00Z")).toBe("2026-11-06");
    expect(formatCleanIsoDate("2026-11-06")).toBe("2026-11-06");
    expect(cleanNullableString(undefined)).toBeNull();
    expect(cleanNullableString("Non spécifié")).toBeNull();
    expect(cleanNullableString("  Pancréas  ")).toBe("Pancréas");

    // sanitizeLocalRedirect edge cases
    expect(sanitizeLocalRedirect(undefined, "/fallback")).toBe("/fallback");
    expect(sanitizeLocalRedirect("//evil.example/path", "/fallback")).toBe("/fallback");
    expect(sanitizeLocalRedirect("/\\evil.example/path", "/fallback")).toBe("/fallback");
    expect(sanitizeLocalRedirect("/patients/A-1042?domain=oncology", "/fallback")).toBe(
      "/patients/A-1042?domain=oncology",
    );
    expect(sanitizeLocalRedirect("https://medsyntis.local/queue?domain=sma#top", "/fallback")).toBe(
      "/queue?domain=sma#top",
    );
    expect(sanitizeLocalRedirect("https://medsyntis.local//double", "/fallback")).toBe("/fallback");
    expect(sanitizeLocalRedirect("not a valid url", "/fallback")).toBe("/fallback");

    // Admin app with explicit APP_ADMIN_USERS for privileged feedback deletion checks
    const adminApp = await buildServer({
      config: loadConfig({
        APP_DEV_MODE: "false",
        APP_AUTH_MODE: "oauth_proxy",
        APP_PROXY_SECRET: "prod-secret",
        APP_API_TOKEN: "prod-token",
        APP_ADMIN_USERS: "admin.ops",
        APP_DOMAIN: "oncology",
        APP_ALLOWED_DOMAINS: "oncology,sma",
      }),
      api,
    });
    const adminHeaders = {
      "x-proxy-secret": "prod-secret",
      "x-forwarded-user": "admin.ops",
      host: "medsyntis.chu.local",
      origin: "https://medsyntis.chu.local",
    };

    // Non-admin DELETE /feedback/:bugId returns 403 JSON
    const nonAdminDeleteBug = await app.inject({
      method: "DELETE",
      url: "/feedback/BUG-001?domain=oncology",
      headers: {
        ...nonAdminHeaders,
        host: "medsyntis.chu.local",
        origin: "https://medsyntis.chu.local",
      },
    });
    expect(nonAdminDeleteBug.statusCode).toBe(403);

    // Admin POST /feedback/:bugId/delete redirects 302 and DELETE /feedback/:bugId returns 200
    const createdBug1 = await api.createBug({
      title: "Temp bug 1",
      description: "Desc",
      category: "ui",
      severity: "low",
      domain: "oncology",
      patientOrFile: null,
      author: "admin.ops",
    });
    const adminPostDeleteBug = await adminApp.inject({
      method: "POST",
      url: `/feedback/${createdBug1.id}/delete?domain=oncology`,
      headers: adminHeaders,
    });
    expect(adminPostDeleteBug.statusCode).toBe(302);

    const createdBug2 = await api.createBug({
      title: "Temp bug 2",
      description: "Desc",
      category: "ui",
      severity: "low",
      domain: "oncology",
      patientOrFile: null,
      author: "admin.ops",
    });
    const adminDeleteBug = await adminApp.inject({
      method: "DELETE",
      url: `/feedback/${createdBug2.id}?domain=oncology`,
      headers: adminHeaders,
    });
    expect(adminDeleteBug.statusCode).toBe(200);
    expect(adminDeleteBug.json()).toEqual({ deleted: createdBug2.id });
    await adminApp.close();

    // Non-admin section mutation headers (with valid CSRF same-origin headers)
    const mutationHeaders = {
      ...nonAdminHeaders,
      host: "medsyntis.chu.local",
      origin: "https://medsyntis.chu.local",
    };

    // PDF ETag 304 and HTTP Range 206 partial content support
    const cards = await api.listPatientCards("oncology");
    const samplePdfFile = cards[0]!.file;
    const pdfFullRes = await app.inject({
      method: "GET",
      url: `/files/forms/${encodeURIComponent(samplePdfFile)}/pdf?domain=oncology`,
      headers: nonAdminHeaders,
    });
    expect(pdfFullRes.statusCode).toBe(200);
    const etag = pdfFullRes.headers.etag as string;
    expect(etag).toBeTruthy();

    const pdf304Res = await app.inject({
      method: "GET",
      url: `/files/forms/${encodeURIComponent(samplePdfFile)}/pdf?domain=oncology`,
      headers: { ...nonAdminHeaders, "if-none-match": etag },
    });
    expect(pdf304Res.statusCode).toBe(304);

    const pdf206Res = await app.inject({
      method: "GET",
      url: `/files/forms/${encodeURIComponent(samplePdfFile)}/pdf?domain=oncology`,
      headers: { ...nonAdminHeaders, range: "bytes=0-3" },
    });
    expect(pdf206Res.statusCode).toBe(206);
    expect(pdf206Res.headers["content-range"]).toMatch(/^bytes 0-3\/\d+$/);

    // Section mutation error handling: JSON (422 validation & 502 upstream) vs full-page HTML redirect
    const jsonValidationErrRes = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(samplePdfFile)}/sections/PatientAdministrative?domain=oncology`,
      headers: {
        ...mutationHeaders,
        accept: "application/json",
      },
      payload: {
        first_name: "Jeanne",
        last_name: "Fictive",
        date_birth: "2028-01-01",
        date_rcp: "2026-11-06",
      },
    });
    expect(jsonValidationErrRes.statusCode).toBe(422);
    expect(jsonValidationErrRes.json().ok).toBe(false);

    const htmlValidationErrRes = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(samplePdfFile)}/sections/PatientAdministrative?domain=oncology`,
      headers: {
        ...mutationHeaders,
        accept: "text/html,application/xhtml+xml",
      },
      payload: {
        first_name: "Jeanne",
        last_name: "Fictive",
        date_birth: "2028-01-01",
        date_rcp: "2026-11-06",
      },
    });
    expect(htmlValidationErrRes.statusCode).toBe(302);
    expect(htmlValidationErrRes.headers.location).toContain("save_error=");

    const rollbackSpy = vi
      .spyOn(api, "rollbackSection")
      .mockRejectedValueOnce(new Error("MedSyntis API HTTP 502 on POST /rollback: Gateway down"));
    const rollbackErrRes = await app.inject({
      method: "POST",
      url: `/forms/${encodeURIComponent(samplePdfFile)}/sections/TumorBiology/rollback?domain=oncology`,
      headers: { ...mutationHeaders, accept: "application/json" },
    });
    expect(rollbackErrRes.statusCode).toBe(502);
    expect(rollbackErrRes.json()).toEqual({ ok: false, error: "Gateway down" });
    rollbackSpy.mockRestore();

    await app.close();
  });
});
