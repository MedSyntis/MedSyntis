import { describe, expect, it, vi } from "vitest";
import { getDomainUserPromptsForAgent } from "../../src/domain/agent-catalog.js";
import {
  buildPatientMetricSeriesFromForms,
  ONCOLOGY_METRIC_SPECS,
  SMA_METRIC_SPECS,
} from "../../src/domain/patient-dashboard.js";
import { computeLongitudinalDeltas } from "../../src/domain/triage.js";
import type { MdtFormDetail } from "../../src/domain/types.js";
import { HttpMedsyntisApiAdapter } from "../../src/infrastructure/api/http-medsyntis-api.adapter.js";
import { InMemoryMedsyntisApiFake } from "../../src/infrastructure/api/in-memory-medsyntis-api.fake.js";
import { buildServer } from "../../src/ui/server.js";

function makeForm(
  file: string,
  mdtDate: string,
  sections: Record<string, Record<string, unknown>>,
  manualEdits: MdtFormDetail["manualEdits"] = {},
): MdtFormDetail {
  return {
    file,
    patientId: "pat_1234567890abcdef",
    domain: "oncology",
    mdtDate,
    processingStatus: "COMPLETED",
    processingStep: null,
    processingProgressPct: 100,
    sections,
    manualEdits,
    executionTimes: {},
    metrics: {},
  };
}

describe("Wave 0 Remediation (#30 & #31)", () => {
  it("tracks ChemotherapyTreament series with manual edit provenance and SMA hfmse_score", () => {
    const oncoKeys = new Set(ONCOLOGY_METRIC_SPECS.map((s) => s.metricKey));
    expect(oncoKeys.has("ChemotherapyTreament.chemotherapy_name")).toBe(true);
    expect(oncoKeys.has("ChemotherapyTreament.chemotherapy_tolerance")).toBe(true);
    expect(oncoKeys.has("Chemotherapy.chemotherapy_name")).toBe(false);

    const smaKeys = new Set(SMA_METRIC_SPECS.map((s) => s.metricKey));
    expect(smaKeys.has("MotorFunctionStatus.hfmse_score")).toBe(true);
    expect(smaKeys.has("MotorFunctionStatus.sma_type")).toBe(true);

    const f1 = makeForm(
      "doc_1.pdf",
      "2026-01-10",
      {
        ChemotherapyTreament: {
          chemotherapy_list: [
            { chemotherapy_name: "FOLFIRINOX", chemotherapy_tolerance: "Moyenne" },
          ],
        },
      },
      {
        ChemotherapyTreament: {
          edited_by: "dr.dupont",
          edited_at: "2026-01-11T10:00:00Z",
        },
      },
    );
    const series = buildPatientMetricSeriesFromForms([f1], "oncology");
    const chemoName = series.find((s) => s.metricKey === "ChemotherapyTreament.chemotherapy_name");
    expect(chemoName?.points[0]?.displayValue).toBe("FOLFIRINOX");
    expect(chemoName?.points[0]?.isManual).toBe(true);
  });

  it("computes longitudinal deltas for Oncology tumor markers, target lesion size, and SMA HFMSE", () => {
    const prevOnco = makeForm("doc_old.pdf", "2025-10-01", {
      TumorBiology: { ca19_9: "120 U/mL", ace: 4.5, afp: 8 },
      CancerDescription: { target_lesion_size_mm: 24 },
    });
    const curOnco = makeForm("doc_new.pdf", "2026-02-01", {
      TumorBiology: { ca19_9: "310 U/mL", ace: 2.5, afp: 8 },
      CancerDescription: { target_lesion_size_mm: 32 },
    });

    const deltas = computeLongitudinalDeltas(curOnco, prevOnco, "fr");
    const byKey = new Map(deltas.map((d) => [d.key, d]));

    expect(byKey.get("ca19_9")?.direction).toBe("worse");
    expect(byKey.get("ca19_9")?.deltaText).toContain("+190");
    expect(byKey.get("ace")?.direction).toBe("better");
    expect(byKey.get("afp")?.direction).toBe("stable");
    expect(byKey.get("target_lesion_size_mm")?.direction).toBe("worse");

    const prevSma = makeForm("doc_sma_1.pdf", "2025-09-01", {
      MotorFunctionStatus: { hfmse_score: 39 },
    });
    const curSma = makeForm("doc_sma_2.pdf", "2026-03-01", {
      MotorFunctionStatus: { hfmse_score: 44 },
    });
    const smaDeltas = computeLongitudinalDeltas(curSma, prevSma, "fr");
    const hfmse = smaDeltas.find((d) => d.key === "hfmse_score");
    expect(hfmse?.direction).toBe("better");
    expect(hfmse?.deltaText).toContain("+5");
  });

  it("attributes Wave-2 factual sections to the administrative extractor and Wave-3 to clinical specialists", () => {
    const adminOnco = getDomainUserPromptsForAgent("administrative", "oncology", "fr");
    const adminSections = adminOnco.map((p) => p.section);
    expect(adminSections).toContain("PatientAdministrative");
    expect(adminSections).toContain("TumorLocation");
    expect(adminSections).toContain("TumorBiology");
    expect(adminSections).toContain("ChemotherapyTreament");

    const adminSma = getDomainUserPromptsForAgent("Administratives_agent", "sma", "fr");
    expect(adminSma.map((p) => p.section)).toContain("MotorFunctionStatus");

    const specialistOnco = getDomainUserPromptsForAgent(
      "digestive surgeon expert",
      "oncology",
      "fr",
    );
    expect(specialistOnco.map((p) => p.section)).toEqual([
      "ExpertAnswer",
      "CareOrientationProposal",
    ]);
  });

  it("preserves deferIncompleteFiles when POST /agenda/schedule is submitted without deferIncompleteFilesPresent", async () => {
    const fakeApi = new InMemoryMedsyntisApiFake();
    const app = await buildServer({
      api: fakeApi,
      config: {
        port: 0,
        host: "127.0.0.1",
        apiUrl: "http://127.0.0.1:8000",
        apiToken: "",
        proxySecret: "",
        authMode: "local",
        devMode: true,
        adminUsers: ["dr.martin"],
        defaultDomain: "oncology",
        allowedDomains: ["oncology", "sma"],
        defaultLanguage: "fr",
        defaultTheme: "light",
        useFakeApiFallback: false,
      },
    });

    try {
      await app.inject({
        method: "POST",
        url: "/agenda/options",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "deferIncompleteFilesPresent=true&deferIncompleteFiles=true",
      });
      expect((await fakeApi.getMdtAgenda("oncology")).deferIncompleteFiles).toBe(true);

      await app.inject({
        method: "POST",
        url: "/agenda/schedule",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "sortStrategy=urgency_first&sessionDate=2026-11-20",
      });
      expect((await fakeApi.getMdtAgenda("oncology")).deferIncompleteFiles).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("fetches plain inline PDFs without passing a dead variant=bbox query parameter", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4").buffer,
    });
    const adapter = new HttpMedsyntisApiAdapter({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const buf = await adapter.getFormPdfBuffer("doc_test.pdf", "oncology");
    expect(buf).toBeInstanceOf(Buffer);
    const calledUrl = String(mockFetch.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("/api/v1/patientmdtform/doc_test.pdf/pdf?inline=true");
    expect(calledUrl).not.toContain("variant=");
  });
});
