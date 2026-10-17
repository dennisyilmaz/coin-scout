import { describe, expect, it } from "vitest";
import {
  CandidateSet,
  collectSeedSignals,
  hourCosine,
  slotOverlap,
} from "../src/analysis/cluster.js";
import type { RawTransaction } from "../src/helius/api.js";
import type { SignatureInfo } from "../src/helius/types.js";

const SEED = "Seed111111111111111111111111111111111111111";
const PAYER = "Payer11111111111111111111111111111111111111";
const SINK = "Sink111111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";

function tx(
  sig: string,
  keys: Array<[string, boolean]>,
  inner: Array<{ owner: string; destination: string }> = [],
): RawTransaction {
  return {
    slot: 1,
    blockTime: 1,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: [
        {
          index: 0,
          instructions: inner.map((c) => ({
            program: "spl-token",
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            parsed: { type: "closeAccount", info: { account: "Acc", ...c } },
          })),
        },
      ],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: keys.map(([pubkey, signer]) => ({ pubkey, signer, writable: true })),
        instructions: [],
        recentBlockhash: "x",
      },
    },
  };
}

function sigs(entries: Array<[string, number]>): SignatureInfo[] {
  return entries.map(([signature, slot]) => ({
    signature,
    slot,
    blockTime: slot,
    err: null,
    memo: null,
  }));
}

describe("collectSeedSignals", () => {
  it("finds an external fee payer, a co-signer and rent flows in both directions", () => {
    const candidates = new CandidateSet(new Set([SEED]));
    const result = collectSeedSignals(
      SEED,
      [
        tx(
          "s1",
          [
            [PAYER, true],
            [SEED, true],
            [OTHER, true],
          ],
          [{ owner: SEED, destination: SINK }],
        ),
        tx("s2", [[SEED, true]], [{ owner: OTHER, destination: SEED }]),
      ],
      candidates,
    );
    expect(result.payers).toEqual([PAYER]);
    expect(result.rentDestinations).toEqual([SINK]);
    expect([...candidates.map.get(PAYER)!.keys()]).toEqual(["pays_seed_fees"]);
    expect([...candidates.map.get(SINK)!.keys()]).toEqual(["receives_seed_rent"]);
    expect([...candidates.map.get(OTHER)!.keys()].sort()).toEqual([
      "co_signer",
      "sends_rent_to_seed",
    ]);
    expect(candidates.score(OTHER)).toBe(85);
  });

  it("ignores fee payers and signers of transactions the seed did not sign", () => {
    const candidates = new CandidateSet(new Set([SEED]));
    const result = collectSeedSignals(
      SEED,
      [
        tx("dust", [
          [PAYER, true],
          [OTHER, true],
          [SEED, false],
        ]),
      ],
      candidates,
    );
    expect(result.payers).toEqual([]);
    expect(candidates.map.size).toBe(0);
  });

  it("never treats programs or the seed itself as candidates", () => {
    const candidates = new CandidateSet(new Set([SEED]));
    candidates.add(SEED, "co_signer", "x");
    candidates.add("11111111111111111111111111111111", "co_signer", "x");
    candidates.add("wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb", "co_signer", "x");
    expect(candidates.map.size).toBe(0);
  });
});

describe("slotOverlap", () => {
  it("counts only separate transactions that share a slot", () => {
    const seed = sigs([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);
    const other = sigs([
      ["x", 10],
      ["b", 20],
      ["y", 30],
      ["z", 40],
    ]);
    const result = slotOverlap(seed, other);
    expect(result.sharedSlots).toEqual([10, 30]);
    expect(result.expected).toBeGreaterThan(0);
  });
});

describe("hourCosine", () => {
  it("needs enough activity on both sides", () => {
    expect(hourCosine([1, 2], [1, 2])).toBeNull();
  });

  it("scores identical hour patterns as 1", () => {
    const times = Array.from({ length: 30 }, (_, i) => 1_760_000_000 + (i % 3) * 3_600);
    expect(hourCosine(times, times)).toBe(1);
  });
});
