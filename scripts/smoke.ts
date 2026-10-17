import { loadConfig } from "../src/config.js";
import { HeliusClient } from "../src/helius/client.js";
import { HeliusApi } from "../src/helius/api.js";

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  const start = performance.now();
  try {
    const value = await fn();
    console.log(`ok   ${label} (${(performance.now() - start).toFixed(0)}ms)`);
    return value;
  } catch (error) {
    console.log(`FAIL ${label} (${(performance.now() - start).toFixed(0)}ms): ${error}`);
    return null;
  }
}

const config = loadConfig();
const client = new HeliusClient(config);
const api = new HeliusApi(client);

const slot = await timed("getSlot", () => api.getSlot());

await timed("batch x5 (getSlot/getEpochInfo/getBalance/getTokenSupply/getBlockTime)", () =>
  Promise.all([
    client.rpc("getSlot", [{ commitment: "confirmed" }]),
    api.getEpochInfo(),
    api.getBalance(JUP),
    api.getTokenSupply(BONK),
    slot ? api.getBlockTime(slot - 32) : Promise.resolve(null),
  ]),
);

await timed("getTransfersByAddress", async () => {
  const res = await api.getTransfersByAddress({ address: JUP, limit: 5 });
  console.log(`     -> ${res.data?.length ?? 0} transfers, cursor=${res.paginationToken}`);
  return res;
});

await timed("getTransactionsForAddress", async () => {
  const res = await api.getTransactionsForAddress({ address: JUP, limit: 5 });
  console.log(`     -> ${res.data?.length ?? 0} rows`);
  return res;
});

const sigs = await timed("getSignaturesForAddress", () =>
  api.getSignaturesForAddress(BONK, { limit: 3 }),
);

if (sigs?.length) {
  await timed("parseTransactions (enhanced)", async () => {
    const res = await api.parseTransactions(sigs.map((s) => s.signature));
    console.log(`     -> ${res.length} parsed, type=${res[0]?.type}, source=${res[0]?.source}`);
    return res;
  });
}

await timed("getEnhancedHistory", async () => {
  const res = await api.getEnhancedHistory({ address: JUP, limit: 3 });
  console.log(`     -> ${res.length} txs`);
  return res;
});

await timed("getAsset (DAS fungible)", async () => {
  const asset = await api.getAsset(BONK);
  console.log(
    `     -> ${asset.content?.metadata?.symbol} supply=${asset.token_info?.supply} price=${asset.token_info?.price_info?.price_per_token}`,
  );
  return asset;
});

await timed("getAssetsByOwner", async () => {
  const page = await api.getAssetsByOwner({ ownerAddress: JUP, limit: 5 });
  console.log(`     -> total=${page.total} items=${page.items.length} sol=${page.nativeBalance?.lamports}`);
  return page;
});

await timed("getTokenLargestAccounts", async () => {
  const res = await api.getTokenLargestAccounts(BONK);
  console.log(`     -> ${res.value.length} holders, top=${res.value[0]?.uiAmountString}`);
  return res;
});

await timed("getDasTokenAccounts", async () => {
  const res = await api.getDasTokenAccounts({ mint: BONK, limit: 5 });
  console.log(`     -> ${res.items?.length ?? 0} accounts of ${res.total}`);
  return res;
});

await timed("getPriorityFeeEstimate", async () => {
  const res = await api.getPriorityFeeEstimate({
    accountKeys: [BONK],
    options: { includeAllPriorityFeeLevels: true },
  });
  console.log(`     -> medium=${res.priorityFeeLevels?.medium}`);
  return res;
});

console.log("\nmetrics:", JSON.stringify(client.metrics(), null, 2));
await client.close();
