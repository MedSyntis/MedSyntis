/**
 * OpenTelemetry Observability Integration for MedSyntis Web BFF (`web/src/infrastructure/observability/otel.ts`).
 *
 * Relies directly on official OpenTelemetry Node.js v3 / Fastify 5 bricks:
 * - `@opentelemetry/api` (`context`, `metrics`, `propagation`, `trace`, `SpanKind`, `SpanStatusCode`)
 * - `@opentelemetry/sdk-node` (`startNodeSdk` — reads standard `OTEL_*` environment variables natively)
 * - `@opentelemetry/sdk-trace` (`SpanProcessor`, `InMemorySpanExporter`, `SimpleSpanProcessor`)
 * - `@opentelemetry/sdk-metrics` (`InMemoryMetricReader`, `AggregationTemporality`)
 * - `@fastify/otel` (`FastifyOtelInstrumentation`)
 * - `@opentelemetry/instrumentation-http` & `@opentelemetry/instrumentation-undici`
 *
 * Safe Default: `OTEL_SDK_DISABLED=true` -> strict No-Op tracing and metrics, zero network export.
 */

import crypto from "node:crypto";
import net from "node:net";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import {
  type Attributes,
  type Context,
  context,
  metrics,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { startNodeSdk } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type Span as SdkSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import type { FastifyPluginCallback } from "fastify";

export interface WebOtelConfig {
  sdkDisabled: boolean;
  serviceName: string;
  resourceAttributes: string;
  tracesExporter: string;
  metricsExporter: string;
  logsExporter: string;
  exporterOtlpEndpoint: string;
  exporterOtlpTracesEndpoint: string;
  exporterOtlpMetricsEndpoint: string;
  exporterOtlpProtocol: string;
  exporterOtlpHeaders: string;
  metricExportInterval: number;
  tracesSampler: string;
  tracesSamplerArg: number;
  propagators: string;
}

const PSEUDONYMIZED_PATIENT_ID_RE = /^(?:pat|patient)_[0-9a-f]{16}$/;
const PSEUDONYMIZED_DOC_ID_RE = /^(?:doc_[0-9a-f]{16}(?:\.pdf)?|[0-9a-f]{16,64})$/;
const MAX_ATTR_LEN = 256;

const FORBIDDEN_ATTR_KEYS = new Set([
  "first_name",
  "last_name",
  "patient_name",
  "full_name",
  "patient_label",
  "date_birth",
  "birth_date",
  "dob",
  "nir",
  "ins",
  "email",
  "phone",
  "address",
  "prompt",
  "system_prompt",
  "question",
  "query",
  "url.query",
  "http.target",
  "completion",
  "response",
  "thinking",
  "reasoning",
  "markdown",
  "content",
  "original_filename",
  "raw_text",
  "clinical_text",
  "summary_text",
]);

const PATIENT_ID_KEYS = new Set([
  "patient_id",
  "target_patient_id",
  "resolved_patient_id",
  "medsyntis.patient_id",
]);

const DOCUMENT_ID_KEYS = new Set(["filename", "file", "document", "medsyntis.doc_id"]);

const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa"];

export function isLocalTelemetryHost(urlOrHost: string): boolean {
  const raw = (urlOrHost || "").trim();
  if (!raw) return false;
  let host = "";
  try {
    host = raw.includes("://") ? new URL(raw).hostname : (raw.split(":")[0] ?? "");
  } catch {
    return false;
  }
  const clean = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!clean) return false;
  if (clean === "localhost" || LOCAL_HOST_SUFFIXES.some((s) => clean.endsWith(s))) {
    return true;
  }
  const ipVer = net.isIP(clean);
  if (ipVer === 4) {
    return (
      clean.startsWith("127.") ||
      clean.startsWith("10.") ||
      clean.startsWith("192.168.") ||
      clean.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)
    );
  }
  if (ipVer === 6) {
    return (
      clean === "::1" ||
      clean.startsWith("fc") ||
      clean.startsWith("fd") ||
      clean.startsWith("fe80:")
    );
  }
  return !clean.includes(".");
}

function hashOpaqueIdentifier(value: string): string {
  const digest = crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
  return `sha256:${digest}`;
}

export function sanitizeWebOtelAttributes(
  raw: Record<string, unknown> | Attributes | undefined,
): Attributes {
  if (!raw) return {};
  const cleaned: Attributes = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!key || val === undefined || val === null) continue;
    const lowerKey = key.trim().toLowerCase();
    const leafKey = lowerKey.split(".").at(-1) ?? lowerKey;
    if (FORBIDDEN_ATTR_KEYS.has(lowerKey) || FORBIDDEN_ATTR_KEYS.has(leafKey)) {
      continue;
    }
    if (lowerKey === "url.path" || lowerKey === "url.full") {
      const stripped = String(val).split("?")[0] ?? "/";
      cleaned[key] = stripped.slice(0, MAX_ATTR_LEN);
      continue;
    }
    if (PATIENT_ID_KEYS.has(lowerKey) || PATIENT_ID_KEYS.has(leafKey)) {
      const s = String(val).trim();
      cleaned[key] = PSEUDONYMIZED_PATIENT_ID_RE.test(s) ? s : "[REDACTED]";
      continue;
    }
    if (DOCUMENT_ID_KEYS.has(lowerKey) || DOCUMENT_ID_KEYS.has(leafKey)) {
      const s = String(val).trim();
      if (!s) continue;
      cleaned[key] = PSEUDONYMIZED_DOC_ID_RE.test(s) ? s : hashOpaqueIdentifier(s);
      continue;
    }
    if (typeof val === "boolean" || typeof val === "number") {
      cleaned[key] = val;
    } else if (typeof val === "string") {
      cleaned[key] = val.slice(0, MAX_ATTR_LEN);
    } else {
      cleaned[key] = String(val).slice(0, MAX_ATTR_LEN);
    }
  }
  return cleaned;
}

export class SanitizingSpanProcessor implements SpanProcessor {
  onStart(span: SdkSpan, _parentContext: Context): void {
    this.scrubSpan(span as unknown as { attributes?: Record<string, unknown> });
  }

  onEnd(span: ReadableSpan): void {
    this.scrubSpan(span as unknown as { attributes?: Record<string, unknown> });
  }

  private scrubSpan(target: { attributes?: Record<string, unknown> }): void {
    if (!target.attributes) return;
    const sanitized = sanitizeWebOtelAttributes(target.attributes);
    for (const existingKey of Object.keys(target.attributes)) {
      if (!(existingKey in sanitized)) {
        delete target.attributes[existingKey];
      }
    }
    Object.assign(target.attributes, sanitized);
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

let activeSdk: { shutdown: () => Promise<void> } | null = null;
let activeFastifyOtel: FastifyOtelInstrumentation | null = null;
let testSpanExporter: InMemorySpanExporter | null = null;
let testMetricExporter: InMemoryMetricExporter | null = null;
let testMetricReader: PeriodicExportingMetricReader | null = null;
let enabledFlag = false;

export interface ConfigureWebObservabilityOptions {
  captureInMemory?: boolean;
}

export function configureWebObservability(
  otelConfig: WebOtelConfig | undefined,
  options?: ConfigureWebObservabilityOptions,
): void {
  if (!otelConfig || otelConfig.sdkDisabled) {
    enabledFlag = false;
    return;
  }
  if (activeSdk) {
    return;
  }

  activeFastifyOtel = new FastifyOtelInstrumentation({
    ignorePaths: "/health",
    instrumentHooks: false,
    requestHook: (span, req) => {
      const cleanPath = req.routeOptions?.url || (req.url.split("?")[0] ?? "/");
      span.updateName(`${req.method} ${cleanPath}`);
    },
  });

  const prevEnv: Record<string, string | undefined> = {};
  const envOverrides: Record<string, string> = {
    OTEL_SDK_DISABLED: "false",
    OTEL_LOG_LEVEL: "error",
    OTEL_SERVICE_NAME: otelConfig.serviceName || "medsyntis-web",
    OTEL_TRACES_EXPORTER: options?.captureInMemory ? "none" : otelConfig.tracesExporter || "none",
    OTEL_METRICS_EXPORTER: options?.captureInMemory ? "none" : otelConfig.metricsExporter || "none",
    OTEL_LOGS_EXPORTER: otelConfig.logsExporter || "none",
    OTEL_TRACES_SAMPLER: otelConfig.tracesSampler || "parentbased_traceidratio",
    OTEL_TRACES_SAMPLER_ARG: String(otelConfig.tracesSamplerArg ?? 1.0),
    OTEL_PROPAGATORS: otelConfig.propagators || "tracecontext,baggage",
  };
  if (otelConfig.resourceAttributes) {
    envOverrides.OTEL_RESOURCE_ATTRIBUTES = otelConfig.resourceAttributes;
  }
  if (otelConfig.exporterOtlpEndpoint) {
    envOverrides.OTEL_EXPORTER_OTLP_ENDPOINT = otelConfig.exporterOtlpEndpoint;
  }
  if (otelConfig.exporterOtlpTracesEndpoint) {
    envOverrides.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = otelConfig.exporterOtlpTracesEndpoint;
  }
  if (otelConfig.exporterOtlpMetricsEndpoint) {
    envOverrides.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = otelConfig.exporterOtlpMetricsEndpoint;
  }
  if (otelConfig.exporterOtlpProtocol) {
    envOverrides.OTEL_EXPORTER_OTLP_PROTOCOL = otelConfig.exporterOtlpProtocol;
  }
  if (otelConfig.exporterOtlpHeaders) {
    envOverrides.OTEL_EXPORTER_OTLP_HEADERS = otelConfig.exporterOtlpHeaders;
  }

  for (const [k, v] of Object.entries(envOverrides)) {
    prevEnv[k] = process.env[k];
    process.env[k] = v;
  }

  try {
    const tracesNone = (otelConfig.tracesExporter || "none").trim().toLowerCase() === "none";
    const customSpanProcessors: SpanProcessor[] | undefined = options?.captureInMemory
      ? (() => {
          testSpanExporter = new InMemorySpanExporter();
          return [
            new SanitizingSpanProcessor(),
            new SimpleSpanProcessor({ exporter: testSpanExporter }),
          ];
        })()
      : tracesNone
        ? [new SanitizingSpanProcessor()]
        : undefined;

    if (options?.captureInMemory) {
      testMetricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      testMetricReader = new PeriodicExportingMetricReader({
        exporter: testMetricExporter,
        exportIntervalMillis: 600_000,
      });
    }

    activeSdk = startNodeSdk({
      resourceAttributes: {
        "service.name": otelConfig.serviceName || "medsyntis-web",
        "service.version": "1.0.0",
      },
      ...(customSpanProcessors ? { spanProcessors: customSpanProcessors } : {}),
      ...(options?.captureInMemory && testMetricReader
        ? { metricReaders: [testMetricReader] }
        : {}),
      instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation(), activeFastifyOtel],
    });

    // When `startNodeSdk` builds OTLP/console span processors from env, prepend `SanitizingSpanProcessor`
    // so Zero-PHI scrubbing always executes before any BatchSpanProcessor/SimpleSpanProcessor export.
    if (!customSpanProcessors) {
      const provider = trace.getTracerProvider() as unknown as {
        getDelegate?: () => unknown;
      };
      const delegate = (provider.getDelegate?.() ?? provider) as {
        _activeSpanProcessor?: { _spanProcessors?: SpanProcessor[] };
      };
      delegate._activeSpanProcessor?._spanProcessors?.unshift(new SanitizingSpanProcessor());
    }
    enabledFlag = true;
  } finally {
    for (const [k, prevVal] of Object.entries(prevEnv)) {
      if (prevVal === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prevVal;
      }
    }
  }
}

export async function shutdownWebObservability(): Promise<void> {
  enabledFlag = false;
  if (activeSdk) {
    try {
      await activeSdk.shutdown();
    } catch {
      // Ignore shutdown errors
    }
    activeSdk = null;
  }
  activeFastifyOtel = null;
  testSpanExporter = null;
  testMetricExporter = null;
  testMetricReader = null;
  trace.disable();
  metrics.disable();
  propagation.disable();
  context.disable();
}

export async function resetWebObservabilityForTests(): Promise<void> {
  await shutdownWebObservability();
}

export function isWebObservabilityEnabled(): boolean {
  return enabledFlag;
}

export function getFastifyOtelPlugin(): FastifyPluginCallback | null {
  if (!enabledFlag || !activeFastifyOtel) return null;
  return activeFastifyOtel.plugin() as unknown as FastifyPluginCallback;
}

export function getActiveWebTraceId(): string | undefined {
  if (!enabledFlag) return undefined;
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return undefined;
  const sc = span.spanContext();
  return sc.traceId && sc.traceId !== "00000000000000000000000000000000" ? sc.traceId : undefined;
}

export function getActiveWebLogTraceMixin(): Record<string, string> {
  if (!enabledFlag) return {};
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return {};
  const sc = span.spanContext();
  if (!sc.traceId || sc.traceId === "00000000000000000000000000000000") return {};
  return {
    trace_id: sc.traceId,
    span_id: sc.spanId,
  };
}

export function injectWebTraceHeaders(headers: Record<string, string>): void {
  if (!enabledFlag) return;
  propagation.inject(context.active(), headers);
}

export async function withWebSpan<T>(
  name: string,
  options: { kind?: SpanKind; attributes?: Record<string, unknown> },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (!enabledFlag) {
    return fn(trace.wrapSpanContext({ traceId: "", spanId: "", traceFlags: 0 }));
  }
  const tracer = trace.getTracer("medsyntis-web", "1.0.0");
  return tracer.startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: sanitizeWebOtelAttributes(options.attributes),
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        const errName = err instanceof Error ? err.name : "Error";
        span.setAttribute("error.type", errName);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errName });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export function recordWebHttpServerMetric(params: {
  method: string;
  route: string;
  statusCode: number;
  domain: string;
  durationMs: number;
}): void {
  if (!enabledFlag) return;
  const meter = metrics.getMeter("medsyntis-web", "1.0.0");
  const attrs = sanitizeWebOtelAttributes({
    "http.request.method": params.method,
    "http.route": params.route,
    "http.response.status_code": params.statusCode,
    "medsyntis.domain": params.domain,
  });
  meter.createCounter("medsyntis.web.http.server.requests").add(1, attrs);
  meter
    .createHistogram("medsyntis.web.http.server.duration_ms", { unit: "ms" })
    .record(Math.max(0, params.durationMs), attrs);
}

export function recordWebUpstreamMetric(params: {
  operation: string;
  domain: string;
  status: "ok" | "error";
  durationMs: number;
  errorType?: string;
}): void {
  if (!enabledFlag) return;
  const meter = metrics.getMeter("medsyntis-web", "1.0.0");
  const attrs = sanitizeWebOtelAttributes({
    "medsyntis.operation": params.operation,
    "medsyntis.domain": params.domain,
    "medsyntis.status": params.status,
  });
  meter
    .createHistogram("medsyntis.web.upstream.duration_ms", { unit: "ms" })
    .record(Math.max(0, params.durationMs), attrs);
  if (params.status === "error") {
    meter.createCounter("medsyntis.web.upstream.errors").add(
      1,
      sanitizeWebOtelAttributes({
        ...attrs,
        "error.type": params.errorType ?? "UpstreamError",
      }),
    );
  }
}

export interface RecordedWebSpanSnapshot {
  name: string;
  traceId: string;
  spanId: string;
  attributes: Attributes;
}

export async function getRecordedWebSpansForTests(): Promise<RecordedWebSpanSnapshot[]> {
  if (!testSpanExporter) return [];
  const provider = trace.getTracerProvider() as unknown as {
    forceFlush?: () => Promise<void>;
    getDelegate?: () => { forceFlush?: () => Promise<void> };
  };
  const target = provider.getDelegate?.() ?? provider;
  await target.forceFlush?.();
  return testSpanExporter.getFinishedSpans().map((s) => ({
    name: s.name,
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    attributes: s.attributes,
  }));
}

export async function collectWebMetricsForTests(): Promise<{
  counters: Record<string, number>;
  histograms: Record<string, number[]>;
}> {
  const counters: Record<string, number> = {};
  const histograms: Record<string, number[]> = {};
  if (!testMetricReader || !testMetricExporter) {
    return { counters, histograms };
  }
  await testMetricReader.forceFlush();
  const batches = testMetricExporter.getMetrics();
  const latest = batches.at(-1);
  if (!latest) {
    return { counters, histograms };
  }
  for (const sm of latest.scopeMetrics) {
    for (const metric of sm.metrics) {
      const dps = metric.dataPoints as Array<{ value: unknown }>;
      if (typeof dps[0]?.value === "number") {
        counters[metric.descriptor.name] = dps.reduce(
          (acc, dp) => acc + (typeof dp.value === "number" ? dp.value : 0),
          0,
        );
      } else {
        histograms[metric.descriptor.name] = dps.map((dp) => {
          const histVal = dp.value as { sum?: number; count?: number };
          return typeof histVal?.sum === "number" ? histVal.sum : 0;
        });
      }
    }
  }
  return { counters, histograms };
}
