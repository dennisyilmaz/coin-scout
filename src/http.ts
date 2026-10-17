import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler, localhostHostValidation } from "@modelcontextprotocol/node";
import { buildMcpServer, createRuntime, warmSchemas } from "./server.js";

const runtime = createRuntime();
const port = Number(process.env.PORT ?? 8787);

await warmSchemas();

const handler = createMcpHandler(() => buildMcpServer(runtime), {
  legacy: "stateless",
  onerror: (error) => console.error("[mcp]", error.message),
});

const nodeHandler = toNodeHandler(handler, {
  onerror: (error) => console.error("[http]", error.message),
});
const guardHost = localhostHostValidation();

const http = createHttpServer((req, res) => {
  if (!guardHost(req, res)) return;
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, network: runtime.config.network, ...runtime.client.metrics() }),
    );
    return;
  }
  void nodeHandler(req, res);
});

http.listen(port, "127.0.0.1", () => {
  console.error(`coin-scout MCP on http://127.0.0.1:${port} (${runtime.config.network})`);
});

const shutdown = async (): Promise<void> => {
  http.close();
  await handler.close().catch(() => {});
  await runtime.client.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
