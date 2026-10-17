import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "stdio-load", version: "1" },
};

const child = spawn("node", ["build/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map<number, { resolve: (v: any) => void; start: number; label: string }>();
let id = 0;

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim().startsWith("{")) return;
  const message = JSON.parse(line);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  entry.resolve({ ...message, elapsed: performance.now() - entry.start, label: entry.label });
});

function call(name: string, args: Record<string, unknown>) {
  const requestId = ++id;
  const promise = new Promise<any>((resolve) =>
    pending.set(requestId, { resolve, start: performance.now(), label: name }),
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: args, _meta: META },
    })}\n`,
  );
  return promise;
}

const WALLETS = [
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
];
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

console.log("firing 12 concurrent tools/call over stdio...\n");
const start = performance.now();

const results = await Promise.race([
  Promise.all([
    call("chain_status", {}),
    call("analyze_wallet", { address: WALLETS[0], transferSample: 200 }),
    call("analyze_wallet", { address: WALLETS[1], transferSample: 200 }),
    call("analyze_token", { mint: BONK }),
    call("get_transfers", { address: WALLETS[0], limit: 100 }),
    call("get_transfers", { address: WALLETS[1], limit: 100 }),
    call("find_counterparties", { address: WALLETS[2], transferSample: 200 }),
    call("get_balances", { addresses: WALLETS }),
    call("get_token_holders", { mint: BONK, limit: 50 }),
    call("get_account", { addresses: WALLETS }),
    call("compare_wallets", { addresses: WALLETS }),
    call("trace_funds", { address: WALLETS[0], hops: 2, perNodeTransfers: 40 }),
  ]),
  new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT after 120s")), 120_000)),
]).catch((error) => error as Error);

if (results instanceof Error) {
  console.log(`FAIL ${results.message}`);
  console.log(`still pending: ${[...pending.values()].map((p) => p.label).join(", ")}`);
  child.kill();
  process.exit(1);
}

const total = performance.now() - start;
let failed = 0;
for (const r of results as any[]) {
  const bad = r.error || r.result?.isError;
  if (bad) failed++;
  console.log(
    `${bad ? "FAIL" : "ok  "} ${r.label.padEnd(22)} ${r.elapsed.toFixed(0).padStart(7)}ms${
      bad ? `  ${(r.error?.message ?? r.result?.content?.[0]?.text ?? "").slice(0, 140)}` : ""
    }`,
  );
}
console.log(`\n12 concurrent calls in ${total.toFixed(0)}ms, ${failed} failures`);

const metrics = await call("server_metrics", {});
console.log("metrics:", metrics.result.content[0].text);
child.kill();
process.exit(failed === 0 ? 0 : 1);
