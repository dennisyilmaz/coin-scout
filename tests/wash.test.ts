import { describe, expect, it } from "vitest";
import type { TransferRecord } from "../src/helius/types.js";
import { poolTrades, profileFunder, scoreWash, type PoolTrade } from "../src/analysis/wash.js";
import { wallet } from "./wallets.js";

const POOL = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const OTHER_POOL = "7Ag95vBBM8tKdhH8kf4NwX8T9aGsZAoMMv1c6SULjbqs";
const ROUTER_PDA = "5hpfC9VBxVcoW9opCnM2PqR6YWRLBzrBpabJTZnwwNiw";

let n = 0;
function row(from: string, to: string, amount: number, slot = ++n): TransferRecord {
  return {
    signature: `s${++n}`,
    slot,
    blockTime: 1_700_000_000 + slot,
    type: "transfer",
    fromUserAccount: from,
    toUserAccount: to,
    mint: "MINT",
    amount: String(amount),
    decimals: 0,
    uiAmount: amount,
    instructionIdx: 0,
  };
}

function trade(trader: string, side: "buy" | "sell", amount: number, slot: number, ts = slot): PoolTrade {
  return { signature: `${trader}-${side}-${slot}`, slot, ts, trader, side, amount, pool: POOL };
}

describe("poolTrades", () => {
  it("reads transfers out of a pool as buys and into a pool as sells", () => {
    const buyer = wallet(1);
    const { trades, routed } = poolTrades(new Set([POOL]), [row(POOL, buyer, 10), row(buyer, POOL, 4)]);
    expect(trades.map((t) => [t.trader, t.side, t.amount])).toEqual([
      [buyer, "buy", 10],
      [buyer, "sell", 4],
    ]);
    expect(routed.transfers).toBe(0);
  });

  it("drops pool-to-pool hops and counts program counterparties as routed volume", () => {
    const pools = new Set([POOL, OTHER_POOL]);
    const { trades, routed } = poolTrades(pools, [row(POOL, OTHER_POOL, 5), row(POOL, ROUTER_PDA, 7)]);
    expect(trades).toHaveLength(0);
    expect(routed).toEqual({ transfers: 1, amount: 7 });
  });

  it("counts a transfer seen from two pool histories once", () => {
    const buyer = wallet(2);
    const t = row(POOL, buyer, 3);
    expect(poolTrades(new Set([POOL]), [t, { ...t }]).trades).toHaveLength(1);
  });
});

describe("profileFunder", () => {
  const funder = wallet(300);
  const users = Array.from({ length: 50 }, (_, i) => wallet(400 + i));

  it("treats wide one-way payouts as an exchange or service", () => {
    const out = users.map((u) => row(funder, u, 1));
    const inbound = Array.from({ length: 30 }, (_, i) => row(wallet(600 + i), funder, 5));
    expect(profileFunder(funder, out, inbound)).toMatchObject({ recipients: 50, recirculated: 0, service: true });
  });

  it("keeps a bot-farm controller that gets SOL back from the wallets it funds", () => {
    const out = users.map((u) => row(funder, u, 1));
    const inbound = users.slice(0, 15).map((u) => row(u, funder, 1));
    expect(profileFunder(funder, out, inbound)).toMatchObject({ recipients: 50, recirculated: 15, service: false });
  });

  it("keeps a small funder", () => {
    expect(profileFunder(funder, users.slice(0, 5).map((u) => row(funder, u, 1)), []).service).toBe(false);
  });
});

describe("scoreWash", () => {
  it("scores bots trading with themselves as likely wash trading", () => {
    const bots = [wallet(3), wallet(4), wallet(5)];
    const trades: PoolTrade[] = [];
    let slot = 100;
    for (const bot of bots) {
      for (let i = 0; i < 4; i++) {
        trades.push(trade(bot, "buy", 1000, slot), trade(bot, "sell", 1000, slot));
        slot += 10;
      }
    }
    trades.push(trade(wallet(6), "buy", 50, slot));
    const funders = new Map(bots.map((b) => [b, wallet(7)]));
    const report = scoreWash(trades, funders);
    expect(report.washScore).toBeGreaterThanOrEqual(60);
    expect(report.verdict).toBe("likely wash trading");
    expect(report.metrics.sameSlotShare).toBeGreaterThan(0.95);
    expect(report.funderGroups[0]).toMatchObject({ funder: wallet(7), traders: bots });
    expect(report.suspiciousTraders.map((s) => s.trader)).toEqual(expect.arrayContaining(bots));
    expect(report.suspiciousTraders.find((s) => s.trader === wallet(6))).toBeUndefined();
  });

  it("separates buy+sell inside one transaction from buy+sell across a slot", () => {
    const bot = wallet(9);
    const atomic = [trade(bot, "buy", 100, 5), { ...trade(bot, "sell", 100, 5), signature: `${bot}-buy-5` }];
    const split = [trade(bot, "buy", 100, 6), trade(bot, "sell", 100, 6)];
    expect(scoreWash(atomic).metrics).toMatchObject({ sameSlotShare: 1, sameTransactionShare: 1 });
    expect(scoreWash(split).metrics).toMatchObject({ sameSlotShare: 1, sameTransactionShare: 0 });
  });

  it("calls overwhelming same-slot volume from commonly funded wallets likely wash trading", () => {
    const funder = wallet(90);
    const bots = Array.from({ length: 8 }, (_, i) => wallet(100 + i));
    const trades = bots.flatMap((bot, i) => [
      trade(bot, "buy", 300, 500 + i),
      trade(bot, "buy", 200, 500 + i),
      trade(bot, "sell", 500, 500 + i),
    ]);
    trades.push(...Array.from({ length: 6 }, (_, i) => trade(wallet(200 + i), "buy", 120, 900 + i)));
    const report = scoreWash(trades, new Map(bots.slice(0, 5).map((b) => [b, funder])));
    expect(report.verdict).toBe("likely wash trading");
    expect(report.flags.some((f) => f.startsWith("quick_round_trips"))).toBe(false);
  });

  it("finds round trips that straddle slots", () => {
    const bot = wallet(8);
    const trades = [trade(bot, "buy", 500, 10, 1000), trade(bot, "sell", 480, 20, 1100)];
    const report = scoreWash(trades);
    expect(report.metrics.roundTripShare).toBe(1);
    expect(report.metrics.sameSlotShare).toBe(0);
  });

  it("leaves organic one-way flow alone", () => {
    const trades = Array.from({ length: 40 }, (_, i) =>
      trade(wallet(20 + i), i % 3 === 0 ? "sell" : "buy", 100 + i * 7, 1000 + i * 50, 1000 + i * 600),
    );
    const report = scoreWash(trades);
    expect(report.washScore).toBeLessThan(30);
    expect(report.flags).toEqual([]);
    expect(report.suspiciousTraders).toEqual([]);
  });

  it("handles an empty sample", () => {
    expect(scoreWash([])).toMatchObject({ washScore: 0, traders: 0, volume: 0 });
  });
});
