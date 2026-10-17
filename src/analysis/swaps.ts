import type { HeliusApi } from "../helius/api.js";
import { HeliusError } from "../helius/client.js";
import type { EnhancedTransaction, SwapEvent, SwapTokenLeg } from "../helius/types.js";
import { NATIVE_SOL } from "../config.js";
import { LAMPORTS_PER_SOL, iso, num, round } from "../util/format.js";

export interface NormalizedSwap {
  signature: string;
  timestamp: number;
  time: string | null;
  slot: number;
  source: string;
  feePayer: string;
  feeSol: number;
  failed: boolean;
  sold: Array<{ mint: string; amount: number }>;
  bought: Array<{ mint: string; amount: number }>;
  description: string;
}

const MAX_EMPTY_WINDOW_HOPS = 2;
const HISTORY_TIMEOUT_MS = 20_000;

export interface SwapFetch {
  swaps: NormalizedSwap[];
  truncated: boolean;
  lastSignature: string | null;
  resumeSignature: string | null;
  searchExhausted: boolean;
}

export async function fetchSwaps(
  api: HeliusApi,
  address: string,
  limit: number,
  maxPages: number,
  source?: string,
  startBefore?: string,
): Promise<SwapFetch> {
  const collected: EnhancedTransaction[] = [];
  let before: string | undefined = startBefore;
  let pages = 0;
  let emptyWindowHops = 0;
  let resumeSignature: string | null = null;
  let searchExhausted = false;

  while (collected.length < limit && pages < maxPages) {
    let batch: EnhancedTransaction[];
    try {
      batch = await api.getEnhancedHistory({
        address,
        limit: Math.min(100, limit - collected.length),
        type: "SWAP",
        source,
        before,
        timeoutMs: HISTORY_TIMEOUT_MS,
      });
    } catch (error) {
      const resume = continuationSignature(error);
      if (!resume) throw error;

      resumeSignature = resume;
      if (resume === before || ++emptyWindowHops > MAX_EMPTY_WINDOW_HOPS) {
        searchExhausted = true;
        break;
      }
      before = resume;
      pages++;
      continue;
    }

    pages++;
    if (batch.length === 0) break;
    collected.push(...batch);
    emptyWindowHops = 0;
    resumeSignature = null;
    before = batch[batch.length - 1]?.signature;
    if (!before) break;
  }

  return {
    swaps: collected.slice(0, limit).map((tx) => normalizeSwap(tx, address)),
    truncated: collected.length >= limit,
    lastSignature: collected[collected.length - 1]?.signature ?? null,
    resumeSignature,
    searchExhausted,
  };
}

export function continuationSignature(error: unknown): string | null {
  if (!(error instanceof HeliusError) || Number(error.code) !== 404) return null;
  const body = typeof error.data === "string" ? error.data : error.message;
  return /before-signature`? parameter set to ([1-9A-HJ-NP-Za-km-z]{64,90})/.exec(body)?.[1] ?? null;
}

export function normalizeSwap(tx: EnhancedTransaction, perspective?: string): NormalizedSwap {
  const event = tx.events?.swap;
  const sold: Array<{ mint: string; amount: number }> = [];
  const bought: Array<{ mint: string; amount: number }> = [];

  if (event) {
    collectLegs(event, sold, bought);
  } else if (perspective) {
    for (const transfer of tx.tokenTransfers ?? []) {
      if (transfer.fromUserAccount === perspective) {
        sold.push({ mint: transfer.mint, amount: num(transfer.tokenAmount) });
      } else if (transfer.toUserAccount === perspective) {
        bought.push({ mint: transfer.mint, amount: num(transfer.tokenAmount) });
      }
    }
  }

  return {
    signature: tx.signature,
    timestamp: tx.timestamp,
    time: iso(tx.timestamp),
    slot: tx.slot,
    source: tx.source,
    feePayer: tx.feePayer,
    feeSol: round(tx.fee / LAMPORTS_PER_SOL, 9),
    failed: Boolean(tx.transactionError),
    sold: mergeLegs(sold),
    bought: mergeLegs(bought),
    description: tx.description,
  };
}

function collectLegs(
  event: SwapEvent,
  sold: Array<{ mint: string; amount: number }>,
  bought: Array<{ mint: string; amount: number }>,
): void {
  if (event.nativeInput) {
    sold.push({ mint: NATIVE_SOL, amount: round(num(event.nativeInput.amount) / LAMPORTS_PER_SOL, 9) });
  }
  if (event.nativeOutput) {
    bought.push({
      mint: NATIVE_SOL,
      amount: round(num(event.nativeOutput.amount) / LAMPORTS_PER_SOL, 9),
    });
  }
  for (const leg of event.tokenInputs ?? []) sold.push(legAmount(leg));
  for (const leg of event.tokenOutputs ?? []) bought.push(legAmount(leg));
}

function legAmount(leg: SwapTokenLeg): { mint: string; amount: number } {
  if (leg.rawTokenAmount) {
    const raw = num(leg.rawTokenAmount.tokenAmount);
    return { mint: leg.mint, amount: round(raw / 10 ** leg.rawTokenAmount.decimals, 9) };
  }
  return { mint: leg.mint, amount: num(leg.tokenAmount) };
}

function mergeLegs(
  legs: Array<{ mint: string; amount: number }>,
): Array<{ mint: string; amount: number }> {
  const map = new Map<string, number>();
  for (const leg of legs) map.set(leg.mint, (map.get(leg.mint) ?? 0) + leg.amount);
  return [...map.entries()].map(([mint, amount]) => ({ mint, amount: round(amount, 9) }));
}

export function summarizeSwaps(swaps: NormalizedSwap[]) {
  const byMint = new Map<string, { boughtAmount: number; soldAmount: number; trades: number }>();
  const bySource = new Map<string, number>();

  for (const swap of swaps) {
    bySource.set(swap.source, (bySource.get(swap.source) ?? 0) + 1);
    for (const leg of swap.bought) {
      const entry = byMint.get(leg.mint) ?? { boughtAmount: 0, soldAmount: 0, trades: 0 };
      entry.boughtAmount = round(entry.boughtAmount + leg.amount, 9);
      entry.trades++;
      byMint.set(leg.mint, entry);
    }
    for (const leg of swap.sold) {
      const entry = byMint.get(leg.mint) ?? { boughtAmount: 0, soldAmount: 0, trades: 0 };
      entry.soldAmount = round(entry.soldAmount + leg.amount, 9);
      entry.trades++;
      byMint.set(leg.mint, entry);
    }
  }

  return {
    totalSwaps: swaps.length,
    failedSwaps: swaps.filter((s) => s.failed).length,
    totalFeeSol: round(
      swaps.reduce((acc, s) => acc + s.feeSol, 0),
      9,
    ),
    venues: [...bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count })),
    perMint: [...byMint.entries()]
      .map(([mint, stats]) => ({
        mint,
        ...stats,
        netAmount: round(stats.boughtAmount - stats.soldAmount, 9),
      }))
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 25),
  };
}
