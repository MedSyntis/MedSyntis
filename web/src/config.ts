import type { ClinicalDomain, Language, ThemeMode } from "./domain/types.js";
import { isLocalTelemetryHost, type WebOtelConfig } from "./infrastructure/observability/otel.js";
import {
  EnvConfigSchema,
  resolveClinicalDomain,
  resolveLanguage,
  resolveThemeMode,
} from "./infrastructure/validation/schemas.js";

export type AuthMode = "local" | "oauth_proxy";

export interface WebAppConfig {
  port: number;
  host: string;
  apiUrl: string;
  apiToken: string;
  proxySecret: string;
  authMode: AuthMode;
  devMode: boolean;
  adminUsers: string[];
  defaultDomain: ClinicalDomain;
  allowedDomains: ClinicalDomain[];
  defaultLanguage: Language;
  defaultTheme: ThemeMode;
  useFakeApiFallback: boolean;
  otel?: WebOtelConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebAppConfig {
  const parsed = EnvConfigSchema.parse(env);

  const defaultDomain = resolveClinicalDomain(parsed.APP_DOMAIN, "oncology");
  const allowedRaw = (parsed.APP_ALLOWED_DOMAINS || "oncology,sma")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d): d is ClinicalDomain => d === "oncology" || d === "sma");

  const devMode = parsed.APP_DEV_MODE !== "false" && parsed.NODE_ENV !== "production";
  const authMode: AuthMode =
    (parsed.APP_AUTH_MODE || "local").toLowerCase() === "oauth_proxy" ? "oauth_proxy" : "local";

  const adminUsers = (parsed.APP_ADMIN_USERS || "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);

  // Fake fallback is disabled by default so the Web UI is 100% connected to the real FastAPI backend.
  // It is only enabled when explicitly requested via WEB_FAKE_API_FALLBACK=true or APP_USE_FAKE_ONLY=true (e.g. automated tests).
  const useFakeApiFallback =
    parsed.WEB_FAKE_API_FALLBACK === "true" || parsed.APP_USE_FAKE_ONLY === "true";

  const rawPort = Number(parsed.PORT_WEB ?? parsed.PORT ?? 3000);
  const port = Number.isNaN(rawPort) ? 3000 : rawPort;

  const rawMetricInterval = Number(parsed.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000);
  const rawSamplerArg = Number(parsed.OTEL_TRACES_SAMPLER_ARG ?? 1.0);
  const otel: WebOtelConfig = {
    sdkDisabled: parsed.OTEL_SDK_DISABLED?.toLowerCase() !== "false",
    serviceName: parsed.OTEL_SERVICE_NAME || "medsyntis-web",
    resourceAttributes: parsed.OTEL_RESOURCE_ATTRIBUTES || "",
    tracesExporter: (parsed.OTEL_TRACES_EXPORTER || "none").toLowerCase(),
    metricsExporter: (parsed.OTEL_METRICS_EXPORTER || "none").toLowerCase(),
    logsExporter: (parsed.OTEL_LOGS_EXPORTER || "none").toLowerCase(),
    exporterOtlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT || "",
    exporterOtlpTracesEndpoint: parsed.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "",
    exporterOtlpMetricsEndpoint: parsed.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || "",
    exporterOtlpLogsEndpoint: parsed.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || "",
    exporterOtlpProtocol: (parsed.OTEL_EXPORTER_OTLP_PROTOCOL || "http/protobuf").toLowerCase(),
    exporterOtlpHeaders: parsed.OTEL_EXPORTER_OTLP_HEADERS || "",
    metricExportInterval: Number.isNaN(rawMetricInterval) ? 60_000 : rawMetricInterval,
    tracesSampler: (parsed.OTEL_TRACES_SAMPLER || "parentbased_traceidratio").toLowerCase(),
    tracesSamplerArg: Number.isNaN(rawSamplerArg)
      ? 1.0
      : Math.min(1.0, Math.max(0.0, rawSamplerArg)),
    propagators: (parsed.OTEL_PROPAGATORS || "tracecontext,baggage").toLowerCase(),
  };

  const allowRemote = parsed.APP_ALLOW_REMOTE_LLM?.toLowerCase() === "true";
  const usesOtlp =
    otel.tracesExporter.split(",").some((e) => e.trim() === "otlp") ||
    otel.metricsExporter.split(",").some((e) => e.trim() === "otlp") ||
    otel.logsExporter.split(",").some((e) => e.trim() === "otlp");
  if (!allowRemote && !otel.sdkDisabled && usesOtlp) {
    const candidateEndpoints = [
      ["OTEL_EXPORTER_OTLP_ENDPOINT", otel.exporterOtlpEndpoint],
      ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", otel.exporterOtlpTracesEndpoint],
      ["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", otel.exporterOtlpMetricsEndpoint],
      ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", otel.exporterOtlpLogsEndpoint ?? ""],
    ] as const;
    for (const [envKey, endpoint] of candidateEndpoints) {
      if (endpoint && !isLocalTelemetryHost(endpoint)) {
        throw new Error(
          `Remote OTLP endpoint forbidden while APP_ALLOW_REMOTE_LLM=false: ${envKey}=${endpoint}`,
        );
      }
    }
  }

  return {
    port,
    host: parsed.HOST_WEB || "127.0.0.1",
    apiUrl: (parsed.APP_API_URL || parsed.APP_QUEUE_API_URL || "http://127.0.0.1:8000").replace(
      /\/$/,
      "",
    ),
    apiToken: parsed.APP_API_TOKEN || "",
    proxySecret: parsed.APP_PROXY_SECRET || "",
    authMode,
    devMode,
    adminUsers,
    defaultDomain,
    allowedDomains: allowedRaw.length > 0 ? allowedRaw : ["oncology", "sma"],
    defaultLanguage: resolveLanguage(parsed.APP_LANGUAGE, "fr"),
    defaultTheme: resolveThemeMode(parsed.APP_THEME, "auto"),
    useFakeApiFallback,
    otel,
  };
}
