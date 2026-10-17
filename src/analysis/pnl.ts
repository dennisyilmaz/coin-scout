import type { HeliusApi } from "../helius/api.js";
import { iso, round } from "../util/format.js";
import { PriceBook, SOL_ALIASES, USDC, USDT, historicalPrices } from "./prices.js";
import { fetchSwaps, type NormalizedSwap } from "./swaps.js";
import { amountOf, fetchTransfers } from "./transfers.js";

const QUOTE_MINTS = new Set([...SOL_ALIASES, USDC, USDT]);

interface Position {
  mint: string;
  buys: number;
  sells: number;
  boughtAmount: number;
  soldAmount: number;
  costUsd: number;
  proceedsUsd: number;
  realizedUsd: number;
  held: number;
  heldCostUsd: number;
  unmatchedSold: number;
  unmatchedProceedsUsd: number;
  firstBuyTs: number | null;
  lastSellTs: number | null;
}

export function computePnl(swaps: NormalizedSwap[], book: PriceBook) {
  const positions = new Map<string, Position>();
  let priced = 0;
  let unpriced = 0;

  const ordered = swaps.filter((s) => !s.failed).sort((a, b) => a.timestamp - b.timestamp);

  for (const swap of ordered) {
    const value = swapValueUsd(swap, book);
    if (value === null) {
      unpriced++;
      continue;
    }
    priced++;

    const boughtLegs = swap.bought.filter((leg) => !QUOTE_MINTS.has(leg.mint));
    const soldLegs = swap.sold.filter((leg) => !QUOTE_MINTS.has(leg.mint));

    for (const leg of boughtLegs) {
      const cost = legValue(leg, boughtLegs.length, value, swap.timestamp, book);
      const p = position(positions, leg.mint);
      p.buys++;
      p.boughtAmount += leg.amount;
      p.costUsd += cost;
      p.held += leg.amount;
      p.heldCostUsd += cost;
      p.firstBuyTs ??= swap.timestamp;
    }

    for (const leg of soldLegs) {
      const proceeds = legValue(leg, soldLegs.length, value, swap.timestamp, book);
      const p = position(positions, leg.mint);
      p.sells++;
      p.soldAmount += leg.amount;
      p.proceedsUsd += proceeds;
      p.lastSellTs = swap.timestamp;

      const matched = Math.min(leg.amount, p.held);
      if (matched > 0) {
        const basis = (p.heldCostUsd / p.held) * matched;
        p.realizedUsd += proceeds * (matched / leg.amount) - basis;
        p.held -= matched;
        p.heldCostUsd -= basis;
      }
      p.unmatchedSold += leg.amount - matched;
      p.unmatchedProceedsUsd += proceeds * ((leg.amount - matched) / leg.amount);
    }
  }

  return { positions: [...positions.values()], pricedSwaps: priced, unpricedSwaps: unpriced };
}

function legValue(
  leg: { mint: string; amount: number },
  legCount: number,
  swapValue: number,
  ts: number,
  book: PriceBook,
): number {
  if (legCount === 1) return swapValue;
  return book.usd(leg.mint, ts, leg.amount) ?? swapValue / legCount;
}

function swapValueUsd(swap: NormalizedSwap, book: PriceBook): number | null {
  const sideValue = (legs: NormalizedSwap["sold"]) => {
    if (legs.length === 0) return null;
    let total = 0;
    for (const leg of legs) {
      const usd = book.usd(leg.mint, swap.timestamp, leg.amount);
      if (usd === null) return null;
      total += usd;
    }
    return total;
  };
  const allQuote = (legs: NormalizedSwap["sold"]) =>
    legs.length > 0 && legs.every((leg) => QUOTE_MINTS.has(leg.mint));

  if (allQuote(swap.sold)) return sideValue(swap.sold);
  if (allQuote(swap.bought)) return sideValue(swap.bought);
  return sideValue(swap.sold) ?? sideValue(swap.bought);
}

function position(map: Map<string, Position>, mint: string): Position {
  let p = map.get(mint);
  if (!p) {
    p = {
      mint,
      buys: 0,
      sells: 0,
      boughtAmount: 0,
      soldAmount: 0,
      costUsd: 0,
      proceedsUsd: 0,
      realizedUsd: 0,
      held: 0,
      heldCostUsd: 0,
      unmatchedSold: 0,
      unmatchedProceedsUsd: 0,
      firstBuyTs: null,
      lastSellTs: null,
    };
    map.set(mint, p);
  }
  return p;
}

export async function walletPnl(
  api: HeliusApi,
  address: string,
  options: { swapLimit: number; maxPages: number; mint?: string; top: number },
) {
  const fetched = await fetchSwaps(api, address, options.swapLimit, options.maxPages);
  const swaps = options.mint
    ? fetched.swaps.filter((s) => [...s.sold, ...s.bought].some((leg) => leg.mint === options.mint))
    : fetched.swaps;

  const book = await historicalPrices(
    swaps.flatMap((s) =>
      [...s.sold, ...s.bought].map((leg) => ({ mint: leg.mint, ts: s.timestamp })),
    ),
  );
  const result = computePnl(swaps, book);
  const received = options.mint
    ? await receivedWithoutSwap(api, address, options.mint, swaps)
    : null;

  const mints = result.positions.map((p) => p.mint).slice(0, 100);
  const assets = mints.length
    ? await api
        .getAssetBatch(mints)
        .catch(() => [] as Awaited<ReturnType<HeliusApi["getAssetBatch"]>>)
    : [];
  const meta = new Map(
    assets.filter(Boolean).map((a) => [
      a!.id,
      {
        symbol: a!.content?.metadata?.symbol ?? a!.token_info?.symbol ?? null,
        price: a!.token_info?.price_info?.price_per_token ?? null,
      },
    ]),
  );

  const rows = result.positions.map((p) => {
    const info = meta.get(p.mint);
    const price = info?.price ?? null;
    const unrealized = price !== null && p.held > 0 ? p.held * price - p.heldCostUsd : null;
    return {
      mint: p.mint,
      symbol: info?.symbol ?? null,
      buys: p.buys,
      sells: p.sells,
      boughtAmount: round(p.boughtAmount, 6),
      soldAmount: round(p.soldAmount, 6),
      costUsd: round(p.costUsd, 2),
      proceedsUsd: round(p.proceedsUsd, 2),
      realizedPnlUsd: round(p.realizedUsd, 2),
      openAmountFromSwaps: round(p.held, 6),
      openCostUsd: round(p.heldCostUsd, 2),
      currentPriceUsd: price,
      unrealizedPnlUsd: unrealized === null ? null : round(unrealized, 2),
      unmatchedSoldAmount: round(p.unmatchedSold, 6),
      unmatchedProceedsUsd: round(p.unmatchedProceedsUsd, 2),
      realizedPnlIfUnboughtFreeUsd: round(p.realizedUsd + p.unmatchedProceedsUsd, 2),
      firstBuyAt: iso(p.firstBuyTs),
      lastSellAt: iso(p.lastSellTs),
    };
  });

  const realized = rows.reduce((acc, r) => acc + r.realizedPnlUsd, 0);
  const unrealized = rows.reduce((acc, r) => acc + (r.unrealizedPnlUsd ?? 0), 0);
  const closed = rows.filter((r) => r.sells > 0 && r.soldAmount > r.unmatchedSoldAmount);

  return {
    address,
    mint: options.mint ?? null,
    swapsAnalyzed: swaps.length,
    pricedSwaps: result.pricedSwaps,
    unpricedSwaps: result.unpricedSwaps,
    sampleTruncated: fetched.truncated,
    totals: {
      realizedPnlUsd: round(realized, 2),
      unrealizedPnlUsd: round(unrealized, 2),
      costUsd: round(
        rows.reduce((acc, r) => acc + r.costUsd, 0),
        2,
      ),
      proceedsUsd: round(
        rows.reduce((acc, r) => acc + r.proceedsUsd, 0),
        2,
      ),
      unmatchedProceedsUsd: round(
        rows.reduce((acc, r) => acc + r.unmatchedProceedsUsd, 0),
        2,
      ),
      realizedPnlIfUnboughtFreeUsd: round(
        rows.reduce((acc, r) => acc + r.realizedPnlIfUnboughtFreeUsd, 0),
        2,
      ),
      tokensTraded: rows.length,
      winners: closed.filter((r) => r.realizedPnlUsd > 0).length,
      losers: closed.filter((r) => r.realizedPnlUsd < 0).length,
    },
    positions: rows
      .sort((a, b) => Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd))
      .slice(0, options.top),
    receivedWithoutSwap: received,
    priceErrors: book.errors,
  };
}

async function receivedWithoutSwap(
  api: HeliusApi,
  address: string,
  mint: string,
  swaps: NormalizedSwap[],
) {
  const swapSigs = new Set(swaps.map((s) => s.signature));
  const page = await fetchTransfers(
    api,
    { address, mint, direction: "in", sortOrder: "asc" },
    300,
    3,
  );
  const free = page.transfers.filter(
    (t) => !swapSigs.has(t.signature) && t.toUserAccount === address,
  );
  const senders = new Map<string, { amount: number; transfers: number; firstSig: string }>();
  for (const t of free) {
    const key = t.fromUserAccount ?? (t.type === "mint" ? "minted" : "unknown");
    const entry = senders.get(key) ?? { amount: 0, transfers: 0, firstSig: t.signature };
    entry.amount += amountOf(t);
    entry.transfers++;
    senders.set(key, entry);
  }
  return {
    amount: round(
      free.reduce((acc, t) => acc + amountOf(t), 0),
      6,
    ),
    transfers: free.length,
    firstAt: iso(free[0]?.blockTime),
    sampleTruncated: page.truncated,
    senders: [...senders.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, 10)
      .map(([from, e]) => ({
        from,
        amount: round(e.amount, 6),
        transfers: e.transfers,
        firstSig: e.firstSig,
      })),
  };
}
