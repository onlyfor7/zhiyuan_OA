import { serve } from "@hono/node-server";

import { buildApp } from "./app";
import { closeDb } from "./db/client";
import { env } from "./env";

const app = buildApp();

const server = serve(
  { fetch: app.fetch, port: env.PORT },
  (info) => {
    console.log(`[lexflow] server listening on http://localhost:${info.port}`);
  },
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[lexflow] received ${signal}, shutting down`);
  server.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
