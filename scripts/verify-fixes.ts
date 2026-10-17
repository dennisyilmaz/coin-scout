import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "verify-fixes", version: "1" },
};

const child = spawn("node", ["build/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map<number, (value: any) => void>();
let id = 0;

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim().startsWith("{")) return;
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});

function call(name: string, args: Record<string, unknown>) {
  const requestId = ++id;
  const start = performance.now();
  const promise = new Promise<any>((resolve) =>
    pending.set(requestId, (m) => resolve({ ...m, elapsed: performance.now() - start })),
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

const SPARSE_WALLET = "F3ydU67WuVP6yWAb9S8jJWeDP9zivsLG9SQ5U8Lo2YPT";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

let failures = 0;
function report(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${detail}`);
}

const swaps = await Promise.race([
  call("get_swaps", { address: SPARSE_WALLET, limit: 30, includeTrades: false }),
  new Promise<any>((resolve) => setTimeout(() => resolve({ timedOut: true }), 90_000)),
]);

if (swaps.timedOut) {
  report("get_swaps (previously hung)", false, "still hanging after 90s");
} else {
  const data = swaps.result?.isError ? null : JSON.parse(swaps.result.content[0].text);
  report(
    "get_swaps (previously hung)",
    Boolean(data) && !swaps.result?.isError,
    data
      ? `${swaps.elapsed.toFixed(0)}ms swaps=${data.summary?.totalSwaps} exhausted=${data.searchExhausted} resume=${data.nextBeforeSignature ? "yes" : "none"}`
      : `error: ${(swaps.result?.content?.[0]?.text ?? swaps.error?.message ?? "").slice(0, 200)}`,
  );
}

const activity = await call("get_asset_activity", { assetId: BONK, limit: 5 });
const activityData = JSON.parse(activity.result.content[0].text);
report(
  "get_asset_activity (fungible)",
  !activity.result.isError && (activityData.supported === false || Array.isArray(activityData.items)),
  `${activity.elapsed.toFixed(0)}ms supported=${activityData.supported ?? "yes"}`,
);

const metrics = await call("server_metrics", {});
console.log("\n" + metrics.result.content[0].text);
console.log(`\n${failures === 0 ? "ALL FIXES VERIFIED" : `${failures} FAILURES`}`);
child.kill();
process.exit(failures === 0 ? 0 : 1);
