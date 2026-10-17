const url = process.env.MCP_URL ?? "http://127.0.0.1:8791/";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "coin-scout-validate", version: "1" },
};

let id = 0;
let passed = 0;
const failures: string[] = [];

async function rpc(method: string, params: Record<string, unknown>, name?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "Mcp-Method": method,
  };
  if (name) headers["Mcp-Name"] = name;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: META } }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  const line = text.startsWith("event:")
    ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)
    : text;
  return JSON.parse(line);
}

async function call(name: string, args: Record<string, unknown>) {
  const start = performance.now();
  let response: any;
  try {
    response = await rpc("tools/call", { name, arguments: args }, name);
  } catch (error) {
    return {
      ms: performance.now() - start,
      isError: true,
      raw: "",
      data: null,
      protocolError: `transport: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const ms = performance.now() - start;
  const raw = response.result?.content?.[0]?.text ?? "";
  return {
    ms,
    isError: Boolean(response.error) || Boolean(response.result?.isError),
    raw,
    data: (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })(),
    protocolError: response.error?.message,
  };
}

function check(label: string, condition: unknown, detail = "") {
  if (condition) {
    passed++;
    return true;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

async function tool(
  label: string,
  name: string,
  args: Record<string, unknown>,
  assertion: (data: any) => string | true,
) {
  const result = await call(name, args);
  if (result.isError) {
    const detail = result.protocolError ?? result.raw.slice(0, 300);
    failures.push(`${label}: ${detail}`);
    console.log(`FAIL ${label.padEnd(38)} ${result.ms.toFixed(0)}ms\n     ${detail}`);
    return null;
  }
  const verdict = assertion(result.data);
  if (verdict !== true) {
    failures.push(`${label}: ${verdict}`);
    console.log(`FAIL ${label.padEnd(38)} ${result.ms.toFixed(0)}ms  ${verdict}`);
    return result.data;
  }
  passed++;
  console.log(
    `ok   ${label.padEnd(38)} ${result.ms.toFixed(0).padStart(6)}ms ${String(result.raw.length).padStart(7)}B`,
  );
  return result.data;
}

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

console.log("=== discovery ===");
const listed = await rpc("tools/list", {});
check("tools/list returns 26 tools", listed.result?.tools?.length === 26, `got ${listed.result?.tools?.length}`);
check("tools/list is cacheable", listed.result?.ttlMs > 0);
const prompts = await rpc("prompts/list", {});
check("prompts/list returns 3", prompts.result?.prompts?.length === 3, `got ${prompts.result?.prompts?.length}`);
const promptGet = await rpc("prompts/get", { name: "screen_token", arguments: { mint: BONK } }, "screen_token");
check("prompts/get renders", promptGet.result?.messages?.[0]?.content?.text?.includes(BONK));
console.log(`     ${passed} discovery checks passed`);

console.log("\n=== live target selection ===");
const seed = await tool("get_transfers (venue feed)", "get_transfers", { address: PUMP_AMM, limit: 60 }, (d) =>
  d?.transfers?.length > 0 ? true : "no transfers returned",
);
const mints: string[] = [
  ...new Set((seed?.transfers ?? []).map((t: any) => t.mint).filter((m: string) => m !== "SOL")),
];
const wallets: string[] = [
  ...new Set(
    (seed?.transfers ?? [])
      .flatMap((t: any) => [t.from, t.to])
      .filter((a: string) => a && a !== PUMP_AMM),
  ),
];
const targetMint = mints.find((m) => m !== BONK && m !== USDC) ?? BONK;
const targetWallet = wallets[0];
const targetSig = seed?.transfers?.[0]?.sig;
console.log(`     mint=${targetMint}\n     wallet=${targetWallet}\n     sig=${targetSig?.slice(0, 20)}...`);

console.log("\n=== data tools ===");
await tool("chain_status", "chain_status", {}, (d) =>
  d?.slot > 300_000_000 && d?.epoch > 0 ? true : "implausible slot/epoch",
);

await tool("get_balances (3 wallets)", "get_balances", { addresses: wallets.slice(0, 3) }, (d) =>
  d?.wallets?.length === Math.min(3, wallets.length) ? true : "wallet count mismatch",
);

await tool("get_account (mint + wallet)", "get_account", { addresses: [targetMint, targetWallet] }, (d) => {
  const mint = d?.accounts?.[0];
  if (!mint?.exists) return "mint account missing";
  if (!mint.owner?.startsWith("Token")) return `unexpected mint owner ${mint.owner}`;
  return mint.data?.parsed?.type === "mint" ? true : "mint not jsonParsed";
});

const sigs = (seed?.transfers ?? []).slice(0, 8).map((t: any) => t.sig);
await tool("get_transactions (8 sigs)", "get_transactions", { signatures: sigs }, (d) =>
  d?.transactions?.length > 0 && d.transactions[0].signature ? true : "no parsed transactions",
);

await tool("get_transaction_raw", "get_transaction_raw", { signature: targetSig }, (d) =>
  d?.found && d?.transaction?.meta ? true : "raw transaction missing meta",
);

await tool(
  "get_transaction_history (signatures)",
  "get_transaction_history",
  { address: targetWallet, limit: 25 },
  (d) => (d?.count > 0 ? true : "no history rows"),
);

await tool(
  "get_transaction_history (full)",
  "get_transaction_history",
  { address: targetWallet, limit: 3, full: true },
  (d) => (Array.isArray(d?.data) ? true : "full mode returned no array"),
);

await tool(
  "get_transfers (filtered: out + mint)",
  "get_transfers",
  { address: PUMP_AMM, mint: targetMint, direction: "out", limit: 20 },
  (d) => {
    const rows = d?.transfers ?? [];
    if (rows.length === 0) return true;
    const wrongMint = rows.find((t: any) => t.mint !== targetMint);
    if (wrongMint) return `mint filter leaked ${wrongMint.mint}`;
    const wrongDir = rows.find((t: any) => t.from !== PUMP_AMM);
    return wrongDir ? `direction filter leaked from=${wrongDir.from}` : true;
  },
);

await tool("get_swaps", "get_swaps", { address: targetWallet, limit: 30 }, (d) => {
  if (!d?.summary) return "no swap summary";
  if (d.searchExhausted && !d.nextBeforeSignature) return "exhausted scan without a resume cursor";
  return true;
});

await tool("get_token_holders", "get_token_holders", { mint: targetMint, limit: 25 }, (d) =>
  d?.accounts?.length > 0 && d.accounts[0].owner ? true : "no holder rows",
);

await tool("get_assets byId", "get_assets", { mode: "byId", value: targetMint }, (d) =>
  d?.id === targetMint ? true : "asset id mismatch",
);
await tool("get_assets byOwner", "get_assets", { mode: "byOwner", value: targetWallet, limit: 20 }, (d) =>
  Array.isArray(d?.items) ? true : "no items array",
);
await tool("get_assets byAuthority", "get_assets", { mode: "byAuthority", value: targetWallet, limit: 5 }, (d) =>
  Array.isArray(d?.items) ? true : "no items array",
);
await tool("get_assets byCreator", "get_assets", { mode: "byCreator", value: targetWallet, limit: 5 }, (d) =>
  Array.isArray(d?.items) ? true : "no items array",
);
await tool("search_assets (fungible)", "search_assets", { ownerAddress: targetWallet, tokenType: "fungible", limit: 10 }, (d) =>
  Array.isArray(d?.items) ? true : "no items array",
);
await tool("get_asset_activity", "get_asset_activity", { assetId: targetMint, limit: 10 }, (d) =>
  Array.isArray(d?.items) || d?.supported === false
    ? true
    : "neither a signature array nor an unsupported-asset explanation",
);

await tool("solana_rpc positional", "solana_rpc", { method: "getVersion", params: [] }, (d) =>
  d?.result?.["solana-core"] ? true : "no version",
);
await tool("solana_rpc DAS object params", "solana_rpc", { method: "getAsset", params: { id: BONK } }, (d) =>
  d?.result?.id === BONK ? true : "DAS object params failed",
);

console.log("\n=== analysis tools ===");
await tool("analyze_token (live pump mint)", "analyze_token", { mint: targetMint }, (d) => {
  if (!d?.authorities) return "no authorities block";
  if (typeof d.riskScore !== "number") return "no risk score";
  if (d.distribution?.measured === true && d.distribution.top1Pct === null) return "measured but null top1";
  return true;
});

await tool("analyze_token (USDC unmeasurable)", "analyze_token", { mint: USDC }, (d) =>
  d?.distribution?.measured === false && d?.distribution?.top1Pct === null
    ? true
    : "USDC concentration should report unmeasured",
);

await tool("analyze_wallet", "analyze_wallet", { address: targetWallet, transferSample: 300 }, (d) => {
  if (!d?.activity) return "no activity block";
  if (d.activity.sampledTransfers === 0) return "sampled zero transfers";
  if (!d.portfolio) return "no portfolio block";
  return true;
});

await tool("trace_funds out (3 hops)", "trace_funds", {
  address: targetWallet,
  direction: "out",
  hops: 3,
  perNodeTransfers: 40,
  branchFactor: 5,
}, (d) => (d?.nodeCount >= 0 && Array.isArray(d?.edges) ? true : "no graph"));

await tool("trace_funds in (2 hops)", "trace_funds", {
  address: targetWallet,
  direction: "in",
  hops: 2,
  perNodeTransfers: 40,
  branchFactor: 5,
}, (d) => {
  if (!Array.isArray(d?.edges)) return "no edges";
  const wrongSink = d.edges.find((e: any) => e.hop === 1 && e.to !== targetWallet);
  return wrongSink ? `hop-1 inbound edge does not terminate at root: ${wrongSink.to}` : true;
});

await tool("find_counterparties", "find_counterparties", { address: targetWallet, transferSample: 300 }, (d) =>
  d?.counterparties?.length > 0 ? true : "no counterparties",
);

await tool("compare_wallets (3)", "compare_wallets", { addresses: wallets.slice(0, 3) }, (d) =>
  d?.pairs?.length === 3 ? true : `expected 3 pairs, got ${d?.pairs?.length}`,
);

await tool("investigate_transaction", "investigate_transaction", { signature: targetSig }, (d) =>
  d?.found && Array.isArray(d?.balanceDeltas) ? true : "no investigation payload",
);

console.log("\n=== negative cases ===");
for (const [label, name, args] of [
  ["bad address", "analyze_wallet", { address: "notanaddress" }],
  ["bad signature", "get_transaction_raw", { signature: "abc" }],
  ["bad mint", "analyze_token", { mint: "0OIl" }],
  ["nonexistent but valid sig", "get_transaction_raw", { signature: "5".repeat(87) }],
] as const) {
  const result = await call(name, args as Record<string, unknown>);
  const rejected = result.isError || result.data?.found === false;
  check(`${label} handled cleanly`, rejected, result.raw.slice(0, 120));
  console.log(`${rejected ? "ok  " : "FAIL"} ${label}`);
}

const blocked = await call("solana_rpc", { method: "sendTransaction", params: ["x"] });
check("sendTransaction blocked", blocked.raw.includes("blocked"), blocked.raw.slice(0, 120));
console.log(`${blocked.raw.includes("blocked") ? "ok  " : "FAIL"} write method blocked`);

console.log("\n=== concurrent load (12 parallel tool calls) ===");
const loadStart = performance.now();
const timedCall = async (name: string, args: Record<string, unknown>) => {
  const start = performance.now();
  const result = await call(name, args);
  return { ...result, name, elapsed: performance.now() - start };
};
const loadResults = await Promise.all([
  timedCall("analyze_wallet", { address: wallets[0], transferSample: 200 }),
  timedCall("analyze_wallet", { address: wallets[1], transferSample: 200 }),
  timedCall("analyze_token", { mint: targetMint }),
  timedCall("analyze_token", { mint: BONK }),
  timedCall("get_swaps", { address: wallets[0], limit: 40 }),
  timedCall("get_transfers", { address: wallets[1], limit: 100 }),
  timedCall("find_counterparties", { address: wallets[0], transferSample: 200 }),
  timedCall("get_balances", { addresses: wallets.slice(0, 5) }),
  timedCall("get_token_holders", { mint: targetMint, limit: 50 }),
  timedCall("chain_status", {}),
  timedCall("get_account", { addresses: wallets.slice(0, 10) }),
  timedCall("get_transactions", { signatures: sigs.slice(0, 5) }),
]);
const loadMs = performance.now() - loadStart;
const loadFails = loadResults.filter((r) => r.isError);
check("no failures under concurrent load", loadFails.length === 0, `${loadFails.length} failed`);
console.log(
  `${loadFails.length === 0 ? "ok  " : "FAIL"} 12 parallel calls in ${loadMs.toFixed(0)}ms, ${loadFails.length} failures`,
);
for (const r of loadResults) {
  console.log(`     ${(r as any).name.padEnd(22)} ${(r as any).elapsed.toFixed(0).padStart(7)}ms ${r.isError ? "ERROR " + (r.protocolError ?? r.raw.slice(0, 160)) : "ok"}`);
}

const metrics = await call("server_metrics", {});
console.log("\nmetrics:", JSON.stringify(metrics.data, null, 2));

console.log(`\n${"=".repeat(60)}`);
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failures.length}`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
