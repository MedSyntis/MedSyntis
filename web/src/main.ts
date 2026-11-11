import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type WebAppConfig } from "./config.js";
import { HttpMedsyntisApiAdapter } from "./infrastructure/api/http-medsyntis-api.adapter.js";
import { InMemoryMedsyntisApiFake } from "./infrastructure/api/in-memory-medsyntis-api.fake.js";
import {
  configureWebObservability,
  shutdownWebObservability,
} from "./infrastructure/observability/otel.js";
import { buildServer } from "./ui/server.js";

export function validateStartupConfig(config: WebAppConfig): void {
  if (!config.devMode) {
    if (!config.apiToken) {
      throw new Error(
        "APP_API_TOKEN is mandatory when running outside development mode (APP_DEV_MODE=false).",
      );
    }
    if (!config.proxySecret) {
      throw new Error(
        "APP_PROXY_SECRET is mandatory when running outside development mode (APP_DEV_MODE=false).",
      );
    }
  }
}

async function main() {
  const config = loadConfig(process.env);
  validateStartupConfig(config);
  configureWebObservability(config.otel);

  const fakeFallback = config.useFakeApiFallback ? new InMemoryMedsyntisApiFake() : undefined;
  const api =
    process.env.APP_USE_FAKE_ONLY === "true" && fakeFallback
      ? fakeFallback
      : new HttpMedsyntisApiAdapter({
          baseUrl: config.apiUrl,
          apiToken: config.apiToken,
          proxySecret: config.proxySecret,
          fallbackPort: fakeFallback,
        });

  const app = await buildServer({ config, api });
  const gracefulShutdown = async () => {
    try {
      await app.close();
    } finally {
      await shutdownWebObservability();
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void gracefulShutdown());
  process.once("SIGINT", () => void gracefulShutdown());

  await app.listen({ port: config.port, host: config.host });
  process.stdout.write(
    `[MedSyntis Web] Server listening on http://${config.host}:${config.port} (API: ${config.apiUrl})\n`,
  );
}

const entryArg = process.argv[1];
const isEntrypoint =
  typeof entryArg === "string" && path.resolve(entryArg) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`Fatal startup error: ${String(err)}\n`);
    process.exit(1);
  });
}
