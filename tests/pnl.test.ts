import { afterEach, describe, expect, it, vi } from "vitest";
import { computePnl } from "../src/analysis/pnl.js";
import { PriceBook, bucketOf, historicalPrices, priceKey, WSOL } from "../src/analysis/prices.js";
import type { NormalizedSwap } from "../src/analysis/swaps.js";

const MEME = "MemeMint1111111111111111111111111111111111";

function book(entries: Array<[string, number, number]>): PriceBook {
  return new PriceBook(
    new Map(entries.map(([mint, ts, price]) => [`${priceKey(mint)}@${bucketOf(ts)}`, price])),
  );
}

function swap(
  ts: number,
  sold: NormalizedSwap["sold"],
  bought: NormalizedSwap["bought"],
): NormalizedSwap {
  return {
    signature: `sig${ts}`,
    timestamp: ts,
    time: null,
    slot: ts,
    source: "JUPITER",
    feePayer: "w",
    feeSol: 0,
    failed: false,
    sold,
    bought,
    description: "",
  };
}

describe("priceKey", () => {
  it("maps every SOL spelling to the wSOL price", () => {
    expect(priceKey("SOL")).toBe(`solana:${WSOL}`);
    expect(priceKey("So11111111111111111111111111111111111111111")).toBe(`solana:${WSOL}`);
    expect(priceKey(MEME)).toBe(`solana:${MEME}`);
  });
});

describe("computePnl", () => {
  const prices = book([
    ["SOL", 1_000, 100],
    ["SOL", 2_000, 200],
    ["SOL", 3_000, 150],
  ]);

  it("values a buy and a sell at the SOL price of each moment, average cost", () => {
    const result = computePnl(
      [
        swap(2_000, [{ mint: "SOL", amount: 2 }], [{ mint: MEME, amount: 2_000 }]),
        swap(1_000, [{ mint: "SOL", amount: 1 }], [{ mint: MEME, amount: 1_000 }]),
        swap(3_000, [{ mint: MEME, amount: 1_500 }], [{ mint: "SOL", amount: 4 }]),
      ],
      prices,
    );
    const p = result.positions.find((x) => x.mint === MEME)!;
    expect(p.costUsd).toBe(500);
    expect(p.proceedsUsd).toBe(600);
    expect(p.realizedUsd).toBeCloseTo(600 - (500 / 3_000) * 1_500, 6);
    expect(p.held).toBe(1_500);
    expect(p.unmatchedSold).toBe(0);
    expect(result.pricedSwaps).toBe(3);
  });

  it("keeps sales of never-bought tokens out of realized PnL but reports their proceeds", () => {
    const result = computePnl(
      [swap(3_000, [{ mint: MEME, amount: 1_000 }], [{ mint: "SOL", amount: 10 }])],
      prices,
    );
    const p = result.positions[0];
    expect(p.realizedUsd).toBe(0);
    expect(p.unmatchedSold).toBe(1_000);
    expect(p.unmatchedProceedsUsd).toBe(1_500);
  });

  it("counts swaps with no priceable side as unpriced", () => {
    const result = computePnl(
      [swap(9_999_999, [{ mint: MEME, amount: 1 }], [{ mint: "OtherMint", amount: 1 }])],
      prices,
    );
    expect(result.unpricedSwaps).toBe(1);
    expect(result.positions).toHaveLength(0);
  });
});

describe("historicalPrices", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("matches returned points to the nearest requested bucket and skips far ones", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            coins: {
              [`solana:${WSOL}`]: { prices: [{ timestamp: 1_760_000_308, price: 219.9 }] },
              "solana:FarMint": { prices: [{ timestamp: 1_760_090_000, price: 5 }] },
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await historicalPrices([
      { mint: "SOL", ts: 1_760_000_000 },
      { mint: "FarMint", ts: 1_760_000_000 },
    ]);
    expect(result.at("SOL", 1_760_000_000)).toBe(219.9);
    expect(result.at("FarMint", 1_760_000_000)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await historicalPrices([{ mint: "SOL", ts: 1_760_000_000 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
