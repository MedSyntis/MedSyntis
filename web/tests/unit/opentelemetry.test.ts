import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { HttpMedsyntisApiAdapter } from "../../src/infrastructure/api/http-medsyntis-api.adapter.js";
import { InMemoryMedsyntisApiFake } from "../../src/infrastructure/api/in-memory-medsyntis-api.fake.js";
import {
  collectWebMetricsForTests,
  configureWebObservability,
  getRecordedWebSpansForTests,
  resetWebObservabilityForTests,
  sanitizeWebOtelAttributes,
} from "../../src/infrastructure/observability/otel.js";
import { buildServer } from "../../src/ui/server.js";

describe("OpenTelemetry Web BFF Observability (MedSyntis#14)", () => {
  beforeEach(async () => {
    await resetWebObservabilityForTests();
  });

  afterEach(async () => {
    await resetWebObservabilityForTests();
  });

  it("defaults to OTEL_SDK_DISABLED=true with zero recorded spans or network exports", async () => {
    const config = loadConfig({
      APP_DEV_MODE: "true",
      APP_AUTH_MODE: "local",
    });
    expect(config.otel).toBeDefined();
    expect(config.otel?.sdkDisabled).toBe(true);
    expect(config.otel?.tracesExporter).toBe("none");
    expect(config.otel?.metricsExporter).toBe("none");

    configureWebObservability(config.otel);
    const server = await buildServer({ config, api: new InMemoryMedsyntisApiFake() });
    try {
      const res = await server.inject({ method: "GET", url: "/worklist" });
      expect(res.statusCode).toBe(200);
      expect(await getRecordedWebSpansForTests()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("blocks non-local OTLP endpoints when APP_ALLOW_REMOTE_LLM is false", () => {
    expect(() =>
      loadConfig({
        APP_ALLOW_REMOTE_LLM: "false",
        OTEL_SDK_DISABLED: "false",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
      }),
    ).toThrow(/OTLP/i);

    const allowed = loadConfig({
      APP_ALLOW_REMOTE_LLM: "false",
      OTEL_SDK_DISABLED: "false",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://grafana:4318",
    });
    expect(allowed.otel?.sdkDisabled).toBe(false);
    expect(allowed.otel?.exporterOtlpEndpoint).toBe("http://grafana:4318");
  });

  it("strips PHI attributes while preserving pseudonymized IDs and technical metadata", () => {
    const cleaned = sanitizeWebOtelAttributes({
      "medsyntis.domain": "oncology",
      "medsyntis.patient_id": "pat_0123456789abcdef",
      "medsyntis.doc_id": "doc_fedcba9876543210.pdf",
      patient_id: "DUPONT_JEAN_1958",
      filename: "DUPONT_Jean_RCP.pdf",
      first_name: "Jean",
      prompt: "Sensitive clinical text",
      "http.route": "/dossier/:patientId",
    });

    expect(cleaned["medsyntis.domain"]).toBe("oncology");
    expect(cleaned["medsyntis.patient_id"]).toBe("pat_0123456789abcdef");
    expect(cleaned["medsyntis.doc_id"]).toBe("doc_fedcba9876543210.pdf");
    expect(cleaned.patient_id).toBe("[REDACTED]");
    expect(String(cleaned.filename)).toMatch(/^sha256:/);
    expect(cleaned.first_name).toBeUndefined();
    expect(cleaned.prompt).toBeUndefined();
    expect(cleaned["http.route"]).toBe("/dossier/:patientId");
  });

  it("propagates W3C traceparent from incoming Fastify request to upstream FastAPI calls and records metrics", async () => {
    const config = loadConfig({
      APP_DEV_MODE: "true",
      APP_AUTH_MODE: "local",
      APP_API_TOKEN: "test-secret",
      OTEL_SDK_DISABLED: "false",
      OTEL_SERVICE_NAME: "medsyntis-web",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
    });
    configureWebObservability(config.otel, { captureInMemory: true });

    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const httpAdapter = new HttpMedsyntisApiAdapter({
      baseUrl: "http://127.0.0.1:8000",
      apiToken: "test-secret",
      fetchImpl: fetchMock,
      fallbackPort: new InMemoryMedsyntisApiFake(),
    });

    const server = await buildServer({ config, api: httpAdapter });
    try {
      const incomingTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const incomingTraceparent = `00-${incomingTraceId}-00f067aa0ba902b7-01`;

      const res = await server.inject({
        method: "GET",
        url: "/worklist?q=DUPONT&domain=oncology",
        headers: {
          traceparent: incomingTraceparent,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-trace-id"]).toBe(incomingTraceId);
      expect(capturedHeaders.traceparent).toBeDefined();
      expect(capturedHeaders.traceparent).toContain(`00-${incomingTraceId}-`);

      const spans = await getRecordedWebSpansForTests();
      expect(spans.some((s) => s.traceId === incomingTraceId && s.name.includes("GET"))).toBe(true);
      expect(
        spans.some(
          (s) => s.traceId === incomingTraceId && s.name === "medsyntis.bff.upstream_request",
        ),
      ).toBe(true);
      for (const s of spans) {
        expect(JSON.stringify(s.attributes)).not.toContain("DUPONT");
      }

      const metrics = await collectWebMetricsForTests();
      expect(metrics.counters["medsyntis.web.http.server.requests"]).toBeGreaterThanOrEqual(1);
      expect(metrics.histograms["medsyntis.web.http.server.duration_ms"]?.length).toBeGreaterThan(
        0,
      );
      expect(metrics.histograms["medsyntis.web.upstream.duration_ms"]?.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
