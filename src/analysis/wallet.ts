import type { HeliusApi } from "../helius/api.js";
import type { DasAsset, DasPage } from "../helius/types.js";
import { LAMPORTS_PER_SOL, ago, iso, pct, round, topN } from "../util/format.js";
import { labelOf } from "../util/programs.js";
import { aggregateCounterparties, fetchTransfers, slimTransfer } from "./transfers.js";

export interface WalletProfileOptions {
  transferSample: number;
  maxPages: number;
  holdingsShown: number;
  counterpartiesShown: number;
}

export async function profileWallet(
  api: HeliusApi,
  address: string,
  options: WalletProfileOptions,
) {
  const [portfolio, recent, oldest] = await Promise.all([
    fetchPortfolio(api, address),
    fetchTransfers(
      api,
      { address, sortOrder: "desc" },
      options.transferSample,
      options.maxPages,
    ),
    api.getTransfersByAddress({ address, limit: 1, sortOrder: "asc" }),
  ]);

  const solLamports = portfolio.page?.nativeBalance?.lamports ?? 0;
  const solUsd = portfolio.page?.nativeBalance?.total_price ?? null;

  const fungible: HoldingRow[] = [];
  let nftCount = 0;
  let compressedCount = 0;
  let frozenCount = 0;

  for (const asset of portfolio.page?.items ?? []) {
    if (asset.compression?.compressed) compressedCount++;
    if (asset.ownership?.frozen) frozenCount++;

    const info = asset.token_info;
    if (info?.balance !== undefined && info.balance > 0) {
      const decimals = info.decimals ?? 0;
      const amount = info.balance / 10 ** decimals;
      fungible.push({
        mint: asset.id,
        symbol: asset.content?.metadata?.symbol ?? info.symbol ?? null,
        amount: round(amount, 6),
        priceUsd: info.price_info?.price_per_token ?? null,
        valueUsd: info.price_info?.price_per_token
          ? round(amount * info.price_info.price_per_token, 2)
          : null,
        frozen: asset.ownership?.frozen ?? false,
      });
    } else if (asset.interface !== "FungibleToken" && asset.interface !== "FungibleAsset") {
      nftCount++;
    }
  }

  const tokenUsd = fungible.reduce((acc, row) => acc + (row.valueUsd ?? 0), 0);
  const totalUsd = round(tokenUsd + (solUsd ?? 0), 2);

  const transfers = recent.transfers;
  const counterparties = aggregateCounterparties(transfers, address);
  const firstSeen = oldest.data?.[0]?.blockTime ?? null;
  const lastSeen = transfers[0]?.blockTime ?? null;

  const inbound = transfers.filter((t) => t.toUserAccount === address);
  const outbound = transfers.filter((t) => t.fromUserAccount === address);
  const uniqueSenders = new Set(inbound.map((t) => t.fromUserAccount).filter(Boolean)).size;
  const uniqueReceivers = new Set(outbound.map((t) => t.toUserAccount).filter(Boolean)).size;
  const uniqueMints = new Set(transfers.map((t) => t.mint)).size;

  const funders = topN(
    counterparties.filter((c) => c.inCount > 0),
    5,
    (c) => -c.firstTs,
  ).map((c) => ({ address: c.address, firstTs: c.firstTs, firstAt: iso(c.firstTs) }));

  const flags = walletFlags({
    ageSeconds: firstSeen ? Math.floor(Date.now() / 1000) - firstSeen : null,
    transferCount: transfers.length,
    uniqueSenders,
    uniqueReceivers,
    counterparties: counterparties.length,
    frozenCount,
    solLamports,
    totalUsd,
    sampleTruncated: recent.truncated,
  });

  return {
    address,
    label: labelOf(address) ?? null,
    portfolio: {
      error: portfolio.error,
      assetsScanned: portfolio.page?.items?.length ?? 0,
      assetsTotal: portfolio.page?.total ?? null,
      solBalance: round(solLamports / LAMPORTS_PER_SOL, 9),
      solValueUsd: solUsd,
      tokenValueUsd: round(tokenUsd, 2),
      totalValueUsd: totalUsd,
      fungibleTokens: fungible.length,
      nftCount,
      compressedNftCount: compressedCount,
      frozenAssets: frozenCount,
      topHoldings: topN(fungible, options.holdingsShown, (h) => h.valueUsd ?? 0),
    },
    activity: {
      firstTransferAt: iso(firstSeen),
      lastTransferAt: iso(lastSeen),
      walletAge: firstSeen ? ago(firstSeen) : null,
      lastActive: lastSeen ? ago(lastSeen) : null,
      sampledTransfers: transfers.length,
      sampleTruncated: recent.truncated,
      inboundCount: inbound.length,
      outboundCount: outbound.length,
      uniqueSenders,
      uniqueReceivers,
      uniqueMints,
      uniqueCounterparties: counterparties.length,
    },
    topCounterparties: topN(
      counterparties,
      options.counterpartiesShown,
      (c) => c.inCount + c.outCount,
    ).map((c) => ({
      address: c.address,
      label: labelOf(c.address) ?? null,
      inCount: c.inCount,
      outCount: c.outCount,
      sharePct: pct(c.inCount + c.outCount, transfers.length),
      firstAt: iso(c.firstTs),
      lastAt: iso(c.lastTs),
    })),
    earliestFunders: funders,
    riskFlags: flags,
    recentTransfers: transfers.slice(0, 10).map(slimTransfer),
  };
}

async function fetchPortfolio(
  api: HeliusApi,
  address: string,
): Promise<{ page: DasPage<DasAsset> | null; error: string | null }> {
  for (const limit of [200, 50]) {
    try {
      return { page: await api.getAssetsByOwner({ ownerAddress: address, limit }), error: null };
    } catch (error) {
      if (limit === 50) {
        return {
          page: null,
          error: `portfolio unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }
  return { page: null, error: "portfolio unavailable" };
}

interface HoldingRow {
  mint: string;
  symbol: string | null;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  frozen: boolean;
}

interface FlagInput {
  ageSeconds: number | null;
  transferCount: number;
  uniqueSenders: number;
  uniqueReceivers: number;
  counterparties: number;
  frozenCount: number;
  solLamports: number;
  totalUsd: number;
  sampleTruncated: boolean;
}

function walletFlags(input: FlagInput): string[] {
  const flags: string[] = [];

  if (input.ageSeconds !== null && input.ageSeconds < 86_400) {
    flags.push("fresh_wallet: first transfer less than 24h ago");
  }
  if (input.uniqueSenders === 1 && input.transferCount >= 10) {
    flags.push("single_funder: every inbound transfer in the sample came from one address");
  }
  if (input.uniqueReceivers >= 50 && input.uniqueReceivers > input.uniqueSenders * 10) {
    flags.push(
      `high_fanout: ${input.uniqueReceivers} distinct payout targets vs ${input.uniqueSenders} funders — distribution or airdrop pattern`,
    );
  }
  if (input.uniqueSenders >= 50 && input.uniqueSenders > input.uniqueReceivers * 10) {
    flags.push(
      `high_fanin: ${input.uniqueSenders} distinct senders vs ${input.uniqueReceivers} outputs — collection or sweeper pattern`,
    );
  }
  if (input.frozenCount > 0) {
    flags.push(`frozen_assets: ${input.frozenCount} held asset(s) are frozen by their authority`);
  }
  if (input.solLamports < 1_000_000 && input.totalUsd > 1_000) {
    flags.push("dust_sol: holds value but almost no SOL for fees — likely a custodial/derived account");
  }
  if (input.sampleTruncated) {
    flags.push("sample_truncated: activity stats cover only the most recent transfers");
  }
  return flags;
}
