import { describe, expect, it } from "vitest";
import type { HeliusApi } from "../src/helius/api.js";
import { HeliusError } from "../src/helius/client.js";
import { continuationSignature, fetchSwaps, normalizeSwap } from "../src/analysis/swaps.js";
import type { EnhancedTransaction } from "../src/helius/types.js";

const RESUME_SIG =
  "2RKnD6pq4iQLhnXNQk1GeJzVLYZKPXWzHYQ8oBFWDLKp9fVQqRr3tYtLcXwNzMhBvUdSgKqFxJmTnAyPcEuWrZ4b";

function notFound(body: string) {
  return new HeliusError(`Helius HTTP 404: ${body}`, 404, "/v0/addresses/x/transactions", body);
}

describe("continuationSignature", () => {
  it("extracts the resume cursor from a Helius 404 continuation body", () => {
    const body = JSON.stringify({
      error: `Failed to find events within the search period. To continue search, query the API again with the \`before-signature\` parameter set to ${RESUME_SIG}.`,
    });
    expect(continuationSignature(notFound(body))).toBe(RESUME_SIG);
  });

  it("ignores non-404 errors and unrelated 404 bodies", () => {
    expect(continuationSignature(new HeliusError("boom", 500, "x"))).toBeNull();
    expect(continuationSignature(notFound('{"error":"not found"}'))).toBeNull();
    expect(continuationSignature(new Error("plain"))).toBeNull();
    expect(continuationSignature(null)).toBeNull();
  });

  it("does not mistake a short token for a signature", () => {
    const body = '{"error":"query the API again with the `before-signature` parameter set to abc"}';
    expect(continuationSignature(notFound(body))).toBeNull();
  });
});

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function sig(n: number): string {
  const marker = B58[n % B58.length];
  return (marker + "aB3xYzKmNpQrStUvWx").repeat(6).slice(0, 88);
}

function stubApi(handler: (before: string | undefined) => EnhancedTransaction[]) {
  const calls: Array<string | undefined> = [];
  const api = {
    getEnhancedHistory: async ({ before }: { before?: string }) => {
      calls.push(before);
      if (calls.length > 50) throw new Error("runaway loop: fetchSwaps did not terminate");
      return handler(before);
    },
  } as unknown as HeliusApi;
  return { api, calls };
}

function continuationError(next: string) {
  const body = JSON.stringify({
    error: `Failed to find events within the search period. To continue search, query the API again with the \`before-signature\` parameter set to ${next}.`,
  });
  return new HeliusError(`Helius HTTP 404: ${body}`, 404, "history", body);
}

describe("fetchSwaps termination", () => {
  it("stops after a bounded number of empty-window hops and returns a resume cursor", async () => {
    let hop = 0;
    const { api, calls } = stubApi(() => {
      throw continuationError(sig(++hop));
    });

    const result = await fetchSwaps(api, "wallet", 30, 20);

    expect(result.searchExhausted).toBe(true);
    expect(result.resumeSignature).toBe(sig(hop));
    expect(result.swaps).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("stops immediately when the cursor stops advancing", async () => {
    const stuck = sig(7);
    const { api, calls } = stubApi(() => {
      throw continuationError(stuck);
    });

    const result = await fetchSwaps(api, "wallet", 30, 20, undefined, stuck);

    expect(result.searchExhausted).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("resumes past an empty window and keeps collecting", async () => {
    const tx = (signature: string): EnhancedTransaction => ({
      signature,
      slot: 1,
      timestamp: 1,
      type: "SWAP",
      source: "JUPITER",
      fee: 0,
      feePayer: "payer",
      description: "",
    });

    let seenGap = false;
    const { api } = stubApi((before) => {
      if (!seenGap) {
        seenGap = true;
        throw continuationError(sig(1));
      }
      return before === sig(1) ? [tx(sig(2))] : [];
    });

    const result = await fetchSwaps(api, "wallet", 30, 20);

    expect(result.searchExhausted).toBe(false);
    expect(result.swaps).toHaveLength(1);
    expect(result.lastSignature).toBe(sig(2));
  });

  it("propagates errors that are not continuation hints", async () => {
    const { api } = stubApi(() => {
      throw new HeliusError("Helius HTTP 500", 500, "history");
    });
    await expect(fetchSwaps(api, "wallet", 30, 20)).rejects.toThrow("Helius HTTP 500");
  });

  it("honours the page cap on a wallet that never runs dry", async () => {
    let page = 0;
    const { api, calls } = stubApi(() => [
      {
        signature: sig(++page),
        slot: 1,
        timestamp: 1,
        type: "SWAP",
        source: "JUPITER",
        fee: 0,
        feePayer: "payer",
        description: "",
      },
    ]);

    const result = await fetchSwaps(api, "wallet", 500, 4);

    expect(calls.length).toBe(4);
    expect(result.swaps).toHaveLength(4);
  });
});

describe("normalizeSwap", () => {
  const base: EnhancedTransaction = {
    signature: "sig",
    slot: 1,
    timestamp: 1_700_000_000,
    type: "SWAP",
    source: "JUPITER",
    fee: 5_000,
    feePayer: "payer",
    description: "swapped",
  };

  it("reads sold and bought legs from a swap event with raw amounts", () => {
    const swap = normalizeSwap({
      ...base,
      events: {
        swap: {
          nativeInput: { account: "payer", amount: "1500000000" },
          tokenOutputs: [
            {
              mint: "MINT",
              tokenAmount: 0,
              rawTokenAmount: { tokenAmount: "2500000", decimals: 6 },
            },
          ],
        },
      },
    });

    expect(swap.sold).toEqual([{ mint: "SOL", amount: 1.5 }]);
    expect(swap.bought).toEqual([{ mint: "MINT", amount: 2.5 }]);
    expect(swap.feeSol).toBeCloseTo(0.000005, 9);
  });

  it("merges repeated legs of the same mint", () => {
    const swap = normalizeSwap({
      ...base,
      events: {
        swap: {
          tokenInputs: [
            { mint: "A", tokenAmount: 1 },
            { mint: "A", tokenAmount: 2.5 },
          ],
        },
      },
    });
    expect(swap.sold).toEqual([{ mint: "A", amount: 3.5 }]);
  });

  it("falls back to token transfers from the wallet's perspective", () => {
    const swap = normalizeSwap(
      {
        ...base,
        tokenTransfers: [
          { fromUserAccount: "me", toUserAccount: "pool", mint: "A", tokenAmount: 10 },
          { fromUserAccount: "pool", toUserAccount: "me", mint: "B", tokenAmount: 4 },
        ],
      },
      "me",
    );
    expect(swap.sold).toEqual([{ mint: "A", amount: 10 }]);
    expect(swap.bought).toEqual([{ mint: "B", amount: 4 }]);
  });
});
