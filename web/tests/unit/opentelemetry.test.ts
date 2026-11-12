import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { HttpMedsyntisApiAdapter } from "../../src/infrastructure/api/http-medsyntis-api.adapter.js";
import { InMemoryMedsyntisApiFake } from "../../src/infrastructure/api/in-memory-medsyntis-api.fake.js";
import {
  collectWebMetricsForTests,
  configureWebObservability,
  emitWebOtelLog,
  getActiveWebLogTraceMixin,
  getActiveWebTraceId,
  getFastifyOtelPlugin,
  getRecordedWebSpansForTests,
  injectWebTraceHeaders,
  isLocalTelemetryHost,
  isWebObservabilityEnabled,
  recordWebHttpServerMetric,
  recordWebUpstreamMetric,
  resetWebObservabilityForTests,
  SanitizingSpanProcessor,
  sanitizeWebOtelAttributes,
  withWebSpan,
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

  it("validates local/private OTLP hosts, scrubs URL queries, and records error spans, metrics, and logs", async () => {
    expect(isLocalTelemetryHost("")).toBe(false);
    expect(isLocalTelemetryHost("http://localhost:4318")).toBe(true);
    expect(isLocalTelemetryHost("http://grafana:4318")).toBe(true);
    expect(isLocalTelemetryHost("http://collector.internal:4318")).toBe(true);
    expect(isLocalTelemetryHost("http://127.0.0.1:4318")).toBe(true);
    expect(isLocalTelemetryHost("http://10.1.2.3:4318")).toBe(true);
    expect(isLocalTelemetryHost("http://172.20.0.5:4318")).toBe(true);
    expect(isLocalTelemetryHost("http://192.168.1.10:4318")).toBe(true);
    expect(isLocalTelemetryHost("http://[::1]:4318")).toBe(true);
    expect(isLocalTelemetryHost("http://[fd00::1]:4318")).toBe(true);
    expect(isLocalTelemetryHost("https://8.8.8.8:4318")).toBe(false);
    expect(isLocalTelemetryHost("https://[2606:4700:4700::1111]:4318")).toBe(false);
    expect(isLocalTelemetryHost("https://cloud.langfuse.com")).toBe(false);

    expect(() =>
      loadConfig({
        APP_ALLOW_REMOTE_LLM: "false",
        OTEL_SDK_DISABLED: "false",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example.com/v1/logs",
      }),
    ).toThrow(/OTLP/i);

    const urlCleaned = sanitizeWebOtelAttributes({
      "url.full": "http://localhost:3000/worklist?q=DUPONT",
      "url.query": "q=DUPONT",
      active: true,
      nested: { secret: 1 },
    });
    expect(urlCleaned["url.full"]).toBe("http://localhost:3000/worklist");
    expect(urlCleaned["url.query"]).toBeUndefined();
    expect(urlCleaned.active).toBe(true);

    const config = loadConfig({
      APP_DEV_MODE: "true",
      OTEL_SDK_DISABLED: "false",
      OTEL_SERVICE_NAME: "medsyntis-web",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=test",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4318/v1/metrics",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
      OTEL_EXPORTER_OTLP_HEADERS: "X-Scope-OrgID=medsyntis",
    });
    configureWebObservability(config.otel, { captureInMemory: true });
    expect(isWebObservabilityEnabled()).toBe(true);

    let activeMixin: Record<string, string> = {};
    await expect(
      withWebSpan("test.failing_span", { attributes: { first_name: "Jean" } }, async () => {
        activeMixin = getActiveWebLogTraceMixin();
        emitWebOtelLog({
          severity: "ERROR",
          message: "Upstream timeout simulated",
          attributes: { first_name: "Jean", "medsyntis.domain": "oncology" },
        });
        recordWebUpstreamMetric({
          operation: "listPatients",
          domain: "oncology",
          status: "error",
          durationMs: 55,
          errorType: "TimeoutError",
        });
        throw new Error("simulated failure");
      }),
    ).rejects.toThrow("simulated failure");

    expect(activeMixin.trace_id).toHaveLength(32);
    expect(activeMixin.span_id).toHaveLength(16);

    const metrics = await collectWebMetricsForTests();
    expect(metrics.counters["medsyntis.web.upstream.errors"]).toBe(1);
  });

  it("covers production OTLP SDK wiring (non-in-memory), disabled helpers, and SanitizingSpanProcessor methods", async () => {
    // 1. Disabled-mode helpers safely return empty/no-op values
    expect(isWebObservabilityEnabled()).toBe(false);
    expect(getFastifyOtelPlugin()).toBeNull();
    expect(getActiveWebTraceId()).toBeUndefined();
    expect(getActiveWebLogTraceMixin()).toEqual({});
    const carrier: Record<string, string> = {};
    injectWebTraceHeaders(carrier);
    expect(carrier).toEqual({});
    emitWebOtelLog({ severity: "INFO", message: "noop" });
    recordWebHttpServerMetric({
      method: "GET",
      route: "/worklist",
      statusCode: 200,
      domain: "oncology",
      durationMs: 12,
    });
    recordWebUpstreamMetric({
      operation: "noop",
      domain: "oncology",
      status: "ok",
      durationMs: 5,
    });
    expect(await collectWebMetricsForTests()).toEqual({ counters: {}, histograms: {} });
    const passthrough = await withWebSpan("noop.span", {}, async () => "ok");
    expect(passthrough).toBe("ok");

    // 2. SanitizingSpanProcessor direct lifecycle & scrubbing
    const proc = new SanitizingSpanProcessor();
    const fakeSpan = {
      attributes: {
        first_name: "Jean",
        "medsyntis.domain": "oncology",
      } as Record<string, unknown>,
    };
    proc.onStart(fakeSpan as never, {} as never);
    expect(fakeSpan.attributes.first_name).toBeUndefined();
    expect(fakeSpan.attributes["medsyntis.domain"]).toBe("oncology");
    proc.onEnd({} as never);
    await proc.forceFlush();
    await proc.shutdown();

    // 3. Production startNodeSdk path WITHOUT captureInMemory (tracesExporter: "none")
    const noneCfg = loadConfig({
      APP_DEV_MODE: "true",
      OTEL_SDK_DISABLED: "false",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    });
    configureWebObservability(noneCfg.otel);
    // Idempotent second call while activeSdk is running
    configureWebObservability(noneCfg.otel);
    expect(isWebObservabilityEnabled()).toBe(true);
    expect(getFastifyOtelPlugin()).not.toBeNull();
    await resetWebObservabilityForTests();

    // 4. Production startNodeSdk path WITHOUT captureInMemory (tracesExporter: "otlp")
    const otlpCfg = loadConfig({
      APP_DEV_MODE: "true",
      OTEL_SDK_DISABLED: "false",
      OTEL_SERVICE_NAME: "medsyntis-web",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    });
    configureWebObservability(otlpCfg.otel);
    expect(isWebObservabilityEnabled()).toBe(true);

    let capturedTid: string | undefined;
    await expect(
      withWebSpan("test.non_error_throw", {}, async () => {
        capturedTid = getActiveWebTraceId();
        emitWebOtelLog({ severity: "WARN", message: "warn test" });
        throw "raw-string-rejection";
      }),
    ).rejects.toBe("raw-string-rejection");
    expect(capturedTid).toHaveLength(32);
  });
});
