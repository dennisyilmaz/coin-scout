#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildMcpServer, createRuntime, warmSchemas } from "./server.js";

const runtime = createRuntime();
const server = buildMcpServer(runtime);

const shutdown = async (): Promise<void> => {
  await runtime.client.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await warmSchemas();
await server.connect(new StdioServerTransport());
console.error(
  `coin-scout ready on stdio (${runtime.config.network}, http2=${runtime.config.allowH2})`,
);
