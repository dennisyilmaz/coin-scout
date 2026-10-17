const url = process.env.MCP_URL ?? "http://127.0.0.1:8791/";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "coin-scout-e2e", version: "1" },
};

let id = 0;

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
  });
  const text = await response.text();
  const line = text.startsWith("event:")
    ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)
    : text;
  return JSON.parse(line);
}

async function callTool(name: string, args: Record<string, unknown>) {
  const start = performance.now();
  const response = await rpc("tools/call", { name, arguments: args }, name);
  const ms = (performance.now() - start).toFixed(0);

  if (response.error) {
    console.log(`FAIL ${name} (${ms}ms): ${response.error.message}`);
    return null;
  }
  const raw = response.result?.content?.[0]?.text ?? "";
  if (response.result?.isError) {
    console.log(`FAIL ${name} (${ms}ms): ${raw.slice(0, 300)}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`FAIL ${name} (${ms}ms): non-JSON payload ${raw.slice(0, 200)}`);
    return null;
  }
  console.log(`ok   ${name} (${ms}ms, ${raw.length}B)`);
  return parsed as Record<string, any>;
}

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const RAYDIUM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

const status = await callTool("chain_status", {});
console.log(`     slot=${status?.slot} epoch=${status?.epoch} feeMedium=${status?.priorityFeeMicroLamports?.medium}`);

const token = await callTool("analyze_token", { mint: BONK, holders: 5 });
console.log(
  `     ${token?.metadata?.symbol} risk=${token?.riskScore} top1=${token?.distribution?.top1Pct}% holders=${token?.supply?.holderAccounts} flags=${token?.riskFlags?.length}`,
);
console.log(`     flags: ${(token?.riskFlags ?? []).join(" | ")}`);

const transfers = await callTool("get_transfers", { address: RAYDIUM_AUTHORITY, limit: 20 });
console.log(`     ${transfers?.count} transfers, truncated=${transfers?.truncated}`);

const probeAddress = transfers?.transfers?.find((t: any) => t.from && t.from !== RAYDIUM_AUTHORITY)?.from;

const wallet = await callTool("analyze_wallet", {
  address: probeAddress ?? RAYDIUM_AUTHORITY,
  transferSample: 200,
});
console.log(
  `     ${wallet?.address?.slice(0, 8)} sol=${wallet?.portfolio?.solBalance} usd=${wallet?.portfolio?.totalValueUsd} cps=${wallet?.activity?.uniqueCounterparties} flags=${wallet?.riskFlags?.length}`,
);

const trace = await callTool("trace_funds", {
  address: RAYDIUM_AUTHORITY,
  direction: "out",
  hops: 2,
  perNodeTransfers: 30,
  branchFactor: 4,
});
console.log(
  `     nodes=${trace?.nodeCount} edges=${trace?.edgeCount} cycles=${trace?.cycles?.length} terminals=${trace?.terminals?.length}`,
);

const sig = transfers?.transfers?.[0]?.sig;
if (sig) {
  const investigation = await callTool("investigate_transaction", {
    signature: sig,
    screenMints: true,
  });
  console.log(
    `     ${investigation?.type}/${investigation?.source} deltas=${investigation?.balanceDeltas?.length} mints=${investigation?.mintsInvolved?.length}`,
  );
}

const swaps = await callTool("get_swaps", { address: RAYDIUM_AUTHORITY, limit: 20, includeTrades: false });
console.log(`     swaps=${swaps?.summary?.totalSwaps} venues=${JSON.stringify(swaps?.summary?.venues?.slice(0, 3))}`);

const holders = await callTool("get_token_holders", { mint: BONK, limit: 5 });
console.log(`     accounts=${holders?.returned} more=${holders?.moreAvailable}`);

const compare = await callTool("compare_wallets", {
  addresses: [RAYDIUM_AUTHORITY, probeAddress ?? BONK],
  transferSample: 100,
});
console.log(`     pairs=${compare?.pairs?.length} strength=${compare?.pairs?.[0]?.linkStrength}`);

await callTool("get_account", { addresses: [BONK, RAYDIUM_AUTHORITY] });
await callTool("search_assets", { creatorAddress: RAYDIUM_AUTHORITY, limit: 5 });
await callTool("solana_rpc", { method: "getVersion", params: [] });

const blocked = await rpc(
  "tools/call",
  { name: "solana_rpc", arguments: { method: "sendTransaction", params: [] } },
  "solana_rpc",
);
const blockedText = blocked.result?.content?.[0]?.text ?? "";
console.log(blockedText.includes("blocked") ? "ok   sendTransaction rejected" : `FAIL block: ${blockedText}`);

const bad = await callTool("analyze_wallet", { address: "not-a-real-address" });
console.log(bad === null ? "ok   invalid address rejected" : "FAIL invalid address accepted");

const metrics = await callTool("server_metrics", {});
console.log("\nmetrics:", JSON.stringify(metrics, null, 2));
