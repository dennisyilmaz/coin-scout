import type { HeliusApi } from "../helius/api.js";
import { iso, round } from "../util/format.js";
import { aggregateCounterparties, fetchTransfers } from "./transfers.js";

export async function compareWallets(
  api: HeliusApi,
  addresses: string[],
  sampleSize: number,
  maxPages: number,
) {
  const profiles = await Promise.all(
    addresses.map(async (address) => {
      const page = await fetchTransfers(
        api,
        { address, sortOrder: "desc" },
        sampleSize,
        maxPages,
      );
      const counterparties = aggregateCounterparties(page.transfers, address);
      const funders = counterparties
        .filter((c) => c.inCount > 0)
        .sort((a, b) => a.firstTs - b.firstTs)
        .slice(0, 5)
        .map((c) => c.address);

      return {
        address,
        sampled: page.transfers.length,
        truncated: page.truncated,
        counterparties: new Set(counterparties.map((c) => c.address)),
        funders: new Set(funders),
        mints: new Set(page.transfers.map((t) => t.mint)),
        firstTs: page.transfers.length
          ? Math.min(...page.transfers.map((t) => t.blockTime))
          : null,
        lastTs: page.transfers.length
          ? Math.max(...page.transfers.map((t) => t.blockTime))
          : null,
      };
    }),
  );

  const pairs = [];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const a = profiles[i];
      const b = profiles[j];
      const sharedCounterparties = intersect(a.counterparties, b.counterparties);
      const sharedFunders = intersect(a.funders, b.funders);
      const sharedMints = intersect(a.mints, b.mints);
      const directLink = a.counterparties.has(b.address) || b.counterparties.has(a.address);

      const jaccard = round(
        sharedCounterparties.length /
          Math.max(1, a.counterparties.size + b.counterparties.size - sharedCounterparties.length),
        4,
      );

      const signals: string[] = [];
      if (directLink) signals.push("direct_transfer_between_wallets");
      if (sharedFunders.length > 0) signals.push(`shared_funder:${sharedFunders.join(",")}`);
      if (jaccard >= 0.3) signals.push(`high_counterparty_overlap:${jaccard}`);
      else if (sharedCounterparties.length >= 3) {
        signals.push(`shared_counterparties:${sharedCounterparties.length}`);
      }

      pairs.push({
        a: a.address,
        b: b.address,
        directLink,
        counterpartyJaccard: jaccard,
        sharedCounterparties: sharedCounterparties.slice(0, 25),
        sharedCounterpartyCount: sharedCounterparties.length,
        sharedFunders,
        sharedMintCount: sharedMints.length,
        signals,
        linkStrength: strength(directLink, sharedFunders.length, jaccard, sharedCounterparties.length),
      });
    }
  }

  return {
    wallets: profiles.map((p) => ({
      address: p.address,
      sampledTransfers: p.sampled,
      sampleTruncated: p.truncated,
      uniqueCounterparties: p.counterparties.size,
      uniqueMints: p.mints.size,
      firstAt: iso(p.firstTs),
      lastAt: iso(p.lastTs),
    })),
    pairs: pairs.sort((x, y) => y.linkStrength - x.linkStrength),
  };
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].filter((value) => large.has(value));
}

function strength(
  directLink: boolean,
  sharedFunders: number,
  jaccard: number,
  sharedCounterparties: number,
): number {
  let score = 0;
  if (directLink) score += 40;
  score += Math.min(30, sharedFunders * 15);
  score += Math.min(20, jaccard * 100);
  score += Math.min(10, sharedCounterparties);
  return Math.min(100, Math.round(score));
}
