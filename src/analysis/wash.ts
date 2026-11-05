import type { HeliusApi } from "../helius/api.js";
import type { TransferRecord } from "../helius/types.js";
import { knownEntity } from "../labels/entities.js";
import { isOffCurve } from "../util/curve.js";
import { iso, round } from "../util/format.js";
import { getJson } from "../util/http.js";
import { DEX_PROGRAMS, POOL_AUTHORITIES, PROGRAM_LABELS, labelOf } from "../util/programs.js";
import { analyzeToken } from "./token.js";
import { SOL_ALIASES } from "./prices.js";
import { amountOf, fetchTransfers } from "./transfers.js";

const ROUND_TRIP_SECONDS = 300;
const ROUND_TRIP_TOLERANCE = 0.1;
const SELF_CANCEL_RATIO = 0.1;
const FUNDER_LOOKUPS = 12;
const SUSPECTS_SHOWN = 15;
const MIN_FLAG_SHARE = 0.01;
const SERVICE_RECIPIENTS = 40;
const RECIRCULATION_SHARE = 0.1;

export interface PoolTrade {
  signature: string;
  slot: number;
  ts: number;
  trader: string;
  side: "buy" | "sell";
  amount: number;
  pool: string;
}

export function poolTrades(pools: Set<string>, transfers: TransferRecord[]) {
  const trades: PoolTrade[] = [];
  const routed = { transfers: 0, amount: 0 };
  const seen = new Set<string>();
  for (const t of transfers) {
    const key = `${t.signature}:${t.instructionIdx}:${t.innerInstructionIdx}:${t.fromUserAccount}:${t.toUserAccount}:${t.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = t.fromUserAccount;
    const to = t.toUserAccount;
    const fromPool = from !== null && pools.has(from);
    const toPool = to !== null && pools.has(to);
    if (fromPool === toPool) continue;
    const trader = fromPool ? to : from;
    if (!trader) continue;
    const amount = amountOf(t);
    if (isOffCurve(trader)) {
      routed.transfers++;
      routed.amount += amount;
      continue;
    }
    trades.push({
      signature: t.signature,
      slot: t.slot,
      ts: t.blockTime,
      trader,
      side: fromPool ? "buy" : "sell",
      amount,
      pool: (fromPool ? from : to)!,
    });
  }
  return { trades, routed: { transfers: routed.transfers, amount: round(routed.amount, 6) } };
}

interface TraderStats {
  trader: string;
  buys: number;
  sells: number;
  bought: number;
  sold: number;
  sameSlot: number;
  sameSlotVolume: number;
  sameTxVolume: number;
  roundTrips: number;
  roundTripVolume: number;
  sampleSig: string;
}

function within(a: number, b: number): boolean {
  return Math.abs(a - b) <= ROUND_TRIP_TOLERANCE * Math.max(a, b);
}

export function traderStats(trades: PoolTrade[]): TraderStats[] {
  const byTrader = new Map<string, PoolTrade[]>();
  for (const trade of trades) {
    const list = byTrader.get(trade.trader) ?? [];
    list.push(trade);
    byTrader.set(trade.trader, list);
  }

  return [...byTrader.entries()].map(([trader, list]) => {
    list.sort((a, b) => a.ts - b.ts || a.slot - b.slot);
    const stats: TraderStats = {
      trader,
      buys: 0,
      sells: 0,
      bought: 0,
      sold: 0,
      sameSlot: 0,
      sameSlotVolume: 0,
      sameTxVolume: 0,
      roundTrips: 0,
      roundTripVolume: 0,
      sampleSig: list[0].signature,
    };
    const slots = new Map<number, PoolTrade[]>();
    for (const trade of list) {
      if (trade.side === "buy") {
        stats.buys++;
        stats.bought += trade.amount;
      } else {
        stats.sells++;
        stats.sold += trade.amount;
      }
      const inSlot = slots.get(trade.slot) ?? [];
      inSlot.push(trade);
      slots.set(trade.slot, inSlot);
    }
    const bothSides = (group: PoolTrade[]) => group.some((t) => t.side === "buy") && group.some((t) => t.side === "sell");
    for (const inSlot of slots.values()) {
      if (!bothSides(inSlot)) continue;
      stats.sameSlot++;
      stats.sameSlotVolume += inSlot.reduce((acc, t) => acc + t.amount, 0);
      stats.sampleSig = inSlot[0].signature;
      const bySig = new Map<string, PoolTrade[]>();
      for (const t of inSlot) bySig.set(t.signature, [...(bySig.get(t.signature) ?? []), t]);
      for (const inTx of bySig.values()) {
        if (bothSides(inTx)) stats.sameTxVolume += inTx.reduce((acc, t) => acc + t.amount, 0);
      }
    }
    for (let i = 0; i + 1 < list.length; i++) {
      const [a, b] = [list[i], list[i + 1]];
      if (a.side !== b.side && a.slot !== b.slot && b.ts - a.ts <= ROUND_TRIP_SECONDS && within(a.amount, b.amount)) {
        stats.roundTrips++;
        stats.roundTripVolume += a.amount + b.amount;
        if (stats.sameSlot === 0) stats.sampleSig = a.signature;
        i++;
      }
    }
    return stats;
  });
}

function selfCancelling(s: TraderStats): boolean {
  const gross = s.bought + s.sold;
  return s.buys >= 2 && s.sells >= 2 && gross > 0 && Math.abs(s.bought - s.sold) / gross <= SELF_CANCEL_RATIO;
}

export function scoreWash(trades: PoolTrade[], funders: Map<string, string> = new Map()) {
  const stats = traderStats(trades).sort((a, b) => b.bought + b.sold - (a.bought + a.sold));
  const volume = stats.reduce((acc, s) => acc + s.bought + s.sold, 0);
  const share = (part: number) => (volume > 0 ? round(part / volume, 4) : 0);

  const groups = new Map<string, string[]>();
  for (const [trader, funder] of funders) {
    const list = groups.get(funder) ?? [];
    list.push(trader);
    groups.set(funder, list);
  }
  const funderGroups = [...groups.entries()]
    .filter(([, traders]) => traders.length >= 2)
    .map(([funder, traders]) => ({
      funder,
      traders,
      volume: stats.filter((s) => traders.includes(s.trader)).reduce((acc, s) => acc + s.bought + s.sold, 0),
    }))
    .sort((a, b) => b.volume - a.volume);
  const grouped = new Set(funderGroups.flatMap((g) => g.traders));

  const metrics = {
    selfCancellingShare: share(stats.filter(selfCancelling).reduce((acc, s) => acc + s.bought + s.sold, 0)),
    sameSlotShare: share(stats.reduce((acc, s) => acc + s.sameSlotVolume, 0)),
    sameTransactionShare: share(stats.reduce((acc, s) => acc + s.sameTxVolume, 0)),
    roundTripShare: share(stats.reduce((acc, s) => acc + s.roundTripVolume, 0)),
    top5Share: share(stats.slice(0, 5).reduce((acc, s) => acc + s.bought + s.sold, 0)),
    funderGroupShare: share(funderGroups.reduce((acc, g) => acc + g.volume, 0)),
  };

  const flags: string[] = [];
  let score = 0;
  const pctOf = (x: number) => `${round(x * 100, 1)}%`;
  const add = (signal: number, points: number, flag: string) => {
    if (signal < MIN_FLAG_SHARE) return;
    score += points;
    flags.push(flag);
  };
  add(
    metrics.sameSlotShare,
    Math.min(45, metrics.sameSlotShare * 90),
    `same_slot_round_trips: ${pctOf(metrics.sameSlotShare)} of volume is a wallet buying and selling in the same slot (${pctOf(metrics.sameTransactionShare)} inside a single transaction); sandwich and arbitrage bots leave the same mark`,
  );
  add(
    metrics.selfCancellingShare,
    Math.min(35, metrics.selfCancellingShare * 70),
    `self_cancelling_volume: ${pctOf(metrics.selfCancellingShare)} of volume comes from wallets whose buys and sells net to within ${SELF_CANCEL_RATIO * 100}%`,
  );
  add(
    metrics.roundTripShare,
    Math.min(20, metrics.roundTripShare * 50),
    `quick_round_trips: ${pctOf(metrics.roundTripShare)} of volume is a buy and an opposite trade of about the same size in a later slot within ${ROUND_TRIP_SECONDS / 60} minutes`,
  );
  add(
    metrics.funderGroupShare,
    Math.min(20, metrics.funderGroupShare * 50),
    `shared_funders: ${pctOf(metrics.funderGroupShare)} of volume comes from ${grouped.size} traders funded by ${funderGroups.length} common wallet${funderGroups.length === 1 ? "" : "s"}`,
  );
  add(
    metrics.top5Share > 0.5 ? metrics.top5Share : 0,
    Math.min(10, (metrics.top5Share - 0.5) * 40),
    `volume_concentration: the top 5 traders account for ${pctOf(metrics.top5Share)} of volume`,
  );
  const washScore = Math.min(100, Math.round(score));

  const suspects = stats
    .map((s) => {
      const reasons: string[] = [];
      if (selfCancelling(s)) reasons.push("buys and sells net to near zero");
      if (s.sameSlot) reasons.push(`${s.sameSlot} same-slot buy+sell`);
      if (s.roundTrips) reasons.push(`${s.roundTrips} quick round trips`);
      if (grouped.has(s.trader)) reasons.push(`shares funder ${funders.get(s.trader)}`);
      return { s, reasons };
    })
    .filter((x) => x.reasons.length > 0)
    .slice(0, SUSPECTS_SHOWN)
    .map(({ s, reasons }) => ({
      trader: s.trader,
      buys: s.buys,
      sells: s.sells,
      bought: round(s.bought, 6),
      sold: round(s.sold, 6),
      volumeShare: share(s.bought + s.sold),
      reasons,
      sampleSig: s.sampleSig,
    }));

  return {
    washScore,
    verdict: washScore >= 60 ? "likely wash trading" : washScore >= 30 ? "possible wash trading" : "no strong wash-trading signal",
    flags,
    metrics,
    traders: stats.length,
    volume: round(volume, 6),
    suspiciousTraders: suspects,
    funderGroups: funderGroups.slice(0, 10).map((g) => ({ ...g, volume: round(g.volume, 6), volumeShare: share(g.volume) })),
    ranked: stats,
  };
}

export function sharedFunders(funders: Map<string, string>): string[] {
  const counts = new Map<string, number>();
  for (const funder of funders.values()) counts.set(funder, (counts.get(funder) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([funder]) => funder);
}

export interface FunderProfile {
  recipients: number;
  senders: number;
  recirculated: number;
  service: boolean;
}

export function profileFunder(funder: string, outgoing: TransferRecord[], incoming: TransferRecord[]): FunderProfile {
  const recipients = new Set(outgoing.map((t) => t.toUserAccount).filter((a): a is string => Boolean(a) && a !== funder));
  const senders = new Set(incoming.map((t) => t.fromUserAccount).filter((a): a is string => Boolean(a) && a !== funder));
  const recirculated = [...recipients].filter((a) => senders.has(a)).length;
  return {
    recipients: recipients.size,
    senders: senders.size,
    recirculated,
    service: recipients.size >= SERVICE_RECIPIENTS && recirculated / recipients.size < RECIRCULATION_SHARE,
  };
}

async function profileFunders(api: HeliusApi, funders: Map<string, string>): Promise<Map<string, FunderProfile>> {
  const profiles = new Map<string, FunderProfile>();
  const page = (address: string, direction: "in" | "out") =>
    api
      .getTransfersByAddress({ address, direction, sortOrder: "desc", limit: 100 })
      .then((p) => p.data ?? [])
      .catch(() => [] as TransferRecord[]);
  await Promise.all(
    sharedFunders(funders).map(async (funder) => {
      const [outgoing, incoming] = await Promise.all([page(funder, "out"), page(funder, "in")]);
      profiles.set(funder, profileFunder(funder, outgoing, incoming));
    }),
  );
  return profiles;
}

async function firstFunders(api: HeliusApi, traders: string[]): Promise<Map<string, string>> {
  const funders = new Map<string, string>();
  await Promise.all(
    traders.map(async (trader) => {
      const page = await api
        .getTransfersByAddress({ address: trader, direction: "in", sortOrder: "asc", limit: 10 })
        .catch(() => null);
      const first = (page?.data ?? []).find((t) => SOL_ALIASES.has(t.mint) && t.fromUserAccount);
      const funder = first?.fromUserAccount;
      if (funder && !knownEntity(funder) && !isOffCurve(funder)) funders.set(trader, funder);
    }),
  );
  return funders;
}

interface DexPair {
  dexId: string;
  labels?: string[];
  pairAddress: string;
  volume?: { h24?: number };
}

export interface PoolOwner {
  owner: string;
  label: string | null;
  source: "supplied" | "dexscreener" | "top_holder";
  pair?: string;
  volume24hUsd?: number | null;
}

export function ownerCandidates(pair: DexPair): string[] {
  if (pair.dexId !== "raydium") return [pair.pairAddress];
  const labels = pair.labels ?? [];
  if (labels.includes("CLMM")) return [pair.pairAddress];
  const authority = labels.includes("CPMM")
    ? "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL"
    : "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  return [pair.pairAddress, authority];
}

async function holdsMint(api: HeliusApi, owner: string, mint: string): Promise<boolean> {
  const res = await api.getTokenAccountsByOwner(owner, { mint }).catch(() => null);
  return (res?.value ?? []).some((a) => Number(a.account.data.parsed?.info?.tokenAmount.amount ?? 0) > 0);
}

export async function discoverPools(
  api: HeliusApi,
  mint: string,
  topHolders: Array<{ owner: string | null; ownerProgram: string | null; ownerLabel: string | null; isBurn: boolean; isProgramOwned: boolean }>,
  max: number,
): Promise<{ pools: PoolOwner[]; notes: string[] }> {
  const pools: PoolOwner[] = [];
  const notes: string[] = [];
  const has = (owner: string) => pools.some((p) => p.owner === owner);

  const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, { ttlMs: 60_000 })
    .then((rows) => (Array.isArray(rows) ? rows : []))
    .catch((error: unknown) => {
      notes.push(`DexScreener pair lookup failed (${error instanceof Error ? error.message : error}); using on-chain top holders only`);
      return [] as DexPair[];
    });
  pairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));
  for (const pair of pairs.slice(0, max * 3)) {
    if (pools.length >= max) break;
    for (const owner of ownerCandidates(pair)) {
      if (has(owner)) break;
      if (!(await holdsMint(api, owner, mint))) continue;
      pools.push({
        owner,
        label: POOL_AUTHORITIES[owner] ?? `${pair.dexId}${pair.labels?.length ? ` ${pair.labels.join("/")}` : ""} pool`,
        source: "dexscreener",
        pair: pair.pairAddress,
        volume24hUsd: pair.volume?.h24 ?? null,
      });
      break;
    }
  }

  for (const holder of topHolders) {
    if (pools.length >= max) break;
    const owner = holder.owner;
    if (!owner || holder.isBurn || !holder.isProgramOwned || has(owner)) continue;
    if (!POOL_AUTHORITIES[owner] && !(holder.ownerProgram && DEX_PROGRAMS.has(holder.ownerProgram))) continue;
    pools.push({ owner, label: POOL_AUTHORITIES[owner] ?? holder.ownerLabel, source: "top_holder" });
  }
  return { pools, notes };
}

export async function detectWashTrading(
  api: HeliusApi,
  mint: string,
  options: { maxTransfers: number; maxPools: number; sinceTs?: number; pools?: string[] },
) {
  const token = await analyzeToken(api, mint, 20);
  const discovered = options.pools?.length
    ? {
        pools: options.pools.slice(0, options.maxPools).map((owner): PoolOwner => ({ owner, label: labelOf(owner) ?? null, source: "supplied" })),
        notes: [],
      }
    : await discoverPools(api, mint, token.topHolders, options.maxPools);
  const pools = discovered.pools;
  const base = {
    mint,
    symbol: token.metadata.symbol,
    priceUsd: token.supply.priceUsd as number | null,
    pools,
  };
  if (pools.length === 0) {
    return {
      ...base,
      washScore: null,
      verdict: "no pool found",
      notes: [
        ...discovered.notes,
        "No DEX pool or bonding curve holding this token was found on DexScreener or among the top holders. Pass pools with the vault owner addresses to read trades from.",
      ],
    };
  }

  const perPool = Math.max(100, Math.floor(options.maxTransfers / pools.length));
  const pages = await Promise.all(
    pools.map((p) =>
      fetchTransfers(
        api,
        {
          address: p.owner,
          mint,
          sortOrder: "desc",
          filters: options.sinceTs ? { blockTime: { gte: options.sinceTs } } : undefined,
        },
        perPool,
        Math.ceil(perPool / 100),
      ),
    ),
  );
  const transfers = pages.flatMap((p) => p.transfers);
  const programs = await api
    .getMultipleAccounts(pools.map((p) => p.owner))
    .then((res) => res.value.map((a) => a?.owner ?? null))
    .catch(() => pools.map(() => null));
  const poolRows = pools.map((pool, i) => {
    const times = pages[i].transfers.map((t) => t.blockTime);
    const program = programs[i];
    return {
      ...pool,
      label: POOL_AUTHORITIES[pool.owner] ?? (program && DEX_PROGRAMS.has(program) ? `${PROGRAM_LABELS[program]} pool` : pool.label),
      transfersRead: pages[i].transfers.length,
      truncated: pages[i].truncated,
      from: times.length ? iso(Math.min(...times)) : null,
      to: times.length ? iso(Math.max(...times)) : null,
    };
  });
  const { trades, routed } = poolTrades(new Set(pools.map((p) => p.owner)), transfers);
  const first = scoreWash(trades);
  const funders = await firstFunders(api, first.ranked.slice(0, FUNDER_LOOKUPS).map((s) => s.trader));
  const profiles = await profileFunders(api, funders);
  const services = [...profiles.entries()].filter(([, p]) => p.service).map(([funder]) => funder);
  for (const [trader, funder] of funders) if (services.includes(funder)) funders.delete(trader);
  const { ranked, ...report } = scoreWash(trades, funders);
  const timestamps = trades.map((t) => t.ts);

  return {
    ...base,
    pools: poolRows,
    ...report,
    funderGroups: report.funderGroups.map((g) => ({ ...g, funderProfile: profiles.get(g.funder) ?? null })),
    volumeUsdApprox: base.priceUsd ? round(report.volume * base.priceUsd, 2) : null,
    routedVolume: {
      ...routed,
      note: "transfers between a pool and another program account (aggregator routes, other pools); not attributed to a trader",
    },
    sample: {
      transfers: transfers.length,
      trades: trades.length,
      truncated: pages.some((p) => p.truncated),
      from: timestamps.length ? iso(Math.min(...timestamps)) : null,
      to: timestamps.length ? iso(Math.max(...timestamps)) : null,
    },
    notes: [
      ...discovered.notes,
      "Trades are read from token transfers in and out of the pools: a transfer out of a pool is a buy, into a pool a sell. Liquidity adds and removals count as trades.",
      `Funders were looked up for the top ${Math.min(FUNDER_LOOKUPS, ranked.length)} traders by volume. Exchange wallets, and funders that pay ${SERVICE_RECIPIENTS}+ distinct wallets without getting SOL back from them (exchange or service pattern), are not counted as shared funders${services.length ? ` (skipped: ${services.join(", ")})` : ""}.`,
    ],
  };
}
