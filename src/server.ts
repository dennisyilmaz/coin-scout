import { McpServer, preloadSchemas } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "./config.js";
import { HeliusClient } from "./helius/client.js";
import { HeliusApi } from "./helius/api.js";
import { registerDataTools } from "./tools/data.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerPrompts } from "./tools/prompts.js";
import { registerCaseTools } from "./tools/cases.js";
import { initCases } from "./cases/store.js";

const INSTRUCTIONS = `coin-scout is a read-only Solana data server backed by Helius. It never signs or submits transactions.

Routing guide:
- Wallet question -> analyze_wallet, then find_counterparties for detail.
- "Where did the money go / come from" -> trace_funds (direction out / in).
- Token safety, rug risk, holder concentration -> analyze_token.
- "Are these the same person" -> compare_wallets. "Who else does this wallet control" -> find_cluster.
- Funds left Solana or arrived from another chain -> follow_bridge. trace_funds resolves bridge crossings it meets.
- Profit, cost basis, "did this wallet profit from the rug" -> wallet_pnl (pass mint for one token).
- One signature to understand -> investigate_transaction, or get_transactions for a plain parse.
- Movement of value with filters (counterparty, mint, direction, time) -> get_transfers. Prefer it over paging signatures.
- Anything not covered -> solana_rpc.

Case files persist investigations across sessions. Call case_read with an address first to see whether an earlier case already covers it. Pass case=<name> to trace_funds, find_cluster or follow_bridge to save results; record findings with case_update (label confidence: established, high, medium, low, or supplied for claims you were told but have not verified); case_export writes a Markdown report and SVG fund-flow diagrams. Case labels show up in every tool's label field.

Timestamps are unix seconds; amounts are decimal-adjusted UI amounts unless the field name says raw.
Current USD values come from Helius pricing; usdAtTime values come from DefiLlama historical prices. Both only cover traded tokens; treat a missing price as unknown, not zero.
Analysis tools sample recent history — when a result reports truncation, its counts are lower bounds.`;

export interface Runtime {
  client: HeliusClient;
  api: HeliusApi;
  config: Config;
}

export function createRuntime(config: Config = loadConfig()): Runtime {
  const client = new HeliusClient(config);
  initCases(config.casesDir);
  return { client, api: new HeliusApi(client), config };
}

export function buildMcpServer(runtime: Runtime): McpServer {
  const server = new McpServer(
    { name: "coin-scout", version: "0.1.0", title: "Coin Scout — Solana intelligence" },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: INSTRUCTIONS,
      cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "public" } },
    },
  );

  const ctx = { server, api: runtime.api, config: runtime.config };
  registerDataTools(ctx);
  registerAnalysisTools(ctx);
  registerCaseTools(ctx);
  registerPrompts(ctx);
  return server;
}

export async function warmSchemas(): Promise<void> {
  await preloadSchemas();
}
