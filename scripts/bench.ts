import { loadConfig } from "../src/config.js";
import { HeliusClient } from "../src/helius/client.js";
import { HeliusApi } from "../src/helius/api.js";

const config = loadConfig();
const api = new HeliusApi(new HeliusClient(config));
const client = api.client;

const seed = await api.getSignaturesForAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", {
  limit: 50,
});
const signatures = seed.map((s) => s.signature);
console.log(`benchmarking ${signatures.length} getTransaction calls\n`);

async function run(label: string, batch: boolean) {
  const before = client.metrics().httpRequests;
  const start = performance.now();
  await Promise.all(
    signatures.map((signature) =>
      client.rpc(
        "getTransaction",
        [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }],
        { batch, ttlMs: 0 },
      ),
    ),
  );
  const ms = performance.now() - start;
  const requests = client.metrics().httpRequests - before;
  console.log(
    `${label.padEnd(22)} ${ms.toFixed(0).padStart(6)}ms   ${String(requests).padStart(3)} HTTP requests   ${(ms / signatures.length).toFixed(1)}ms/call`,
  );
  return ms;
}

const batched = await run("batching ON", true);
await new Promise((resolve) => setTimeout(resolve, 3_000));
const unbatched = await run("batching OFF", false);
await new Promise((resolve) => setTimeout(resolve, 3_000));

const cacheStart = performance.now();
await Promise.all(
  signatures.map((signature) =>
    client.rpc("getTransaction", [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], {
      ttlMs: 60_000,
    }),
  ),
);
await Promise.all(
  signatures.map((signature) =>
    client.rpc("getTransaction", [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], {
      ttlMs: 60_000,
    }),
  ),
);
const cacheMs = performance.now() - cacheStart;

console.log(`\nbatching speedup: ${(unbatched / batched).toFixed(1)}x`);
console.log(`cold+warm cache pass: ${cacheMs.toFixed(0)}ms`);
console.log("metrics:", JSON.stringify(client.metrics()));
await client.close();
