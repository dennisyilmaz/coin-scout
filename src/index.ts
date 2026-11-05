#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildMcpServer, createRuntime, warmSchemas } from "./server.js";

const runtime = createRuntime();

await warmSchemas();
const connection = serveStdio(() => buildMcpServer(runtime), {
  onerror: (error) => console.error("[mcp]", error.message),
});

const shutdown = async (): Promise<void> => {
  await connection.close().catch(() => {});
  await runtime.client.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.error(
  `coin-scout ready on stdio (${runtime.config.network}, http2=${runtime.config.allowH2})`,
);
