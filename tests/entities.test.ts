import { describe, expect, it } from "vitest";
import type { HeliusApi } from "../src/helius/api.js";
import { HeliusError } from "../src/helius/client.js";
import type { TransferRecord } from "../src/helius/types.js";
import {
  classifyDeposit,
  describeEntity,
  distinctSenders,
  heliusIdentities,
  identifyEntities,
  knownEntity,
  sweepPattern,
} from "../src/labels/entities.js";
import { OKX_SNAPSHOT, OKX_SOLANA } from "../src/labels/okx-solana.js";
import { labelOf } from "../src/util/programs.js";
import { wallet } from "./wallets.js";

const OKX_WALLET = "CBEADkb8TZAXHjVE3zwad4L995GZE7rJcacJ7asebkVG";
const DEPOSIT = wallet(10);
const HOT = wallet(11);
const USER = wallet(12);
const PDA = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

let sig = 0;
function transfer(from: string | null, to: string | null, amount = 1): TransferRecord {
  sig++;
  return {
    signature: `sig${sig}`,
    slot: sig,
    blockTime: 1_700_000_000 + sig,
    type: "transfer",
    fromUserAccount: from,
    toUserAccount: to,
    mint: "SOL",
    amount: String(amount),
    decimals: 0,
    uiAmount: amount,
  };
}

describe("built-in exchange wallets", () => {
  it("labels OKX proof-of-reserves addresses and nothing else", () => {
    expect(OKX_SNAPSHOT.addresses).toBe(OKX_SOLANA.split("\n").filter(Boolean).length);
    expect(knownEntity(OKX_WALLET)).toMatchObject({ name: "OKX", kind: "exchange", confidence: "established" });
    expect(knownEntity(DEPOSIT)).toBeUndefined();
    expect(labelOf(OKX_WALLET)).toBe("OKX wallet (proof of reserves)");
  });
});

describe("deposit sweep heuristic", () => {
  it("finds the single target an address sweeps to", () => {
    const rows = [transfer(USER, DEPOSIT), transfer(DEPOSIT, HOT), transfer(DEPOSIT, HOT), transfer(DEPOSIT, HOT)];
    expect(sweepPattern(DEPOSIT, rows)).toMatchObject({ target: HOT, sweeps: 3, outgoing: 3, share: 1 });
  });

  it("ignores wallets that pay many recipients or sweep into a program account", () => {
    expect(sweepPattern(DEPOSIT, [transfer(DEPOSIT, HOT), transfer(DEPOSIT, USER)])).toBeNull();
    expect(sweepPattern(DEPOSIT, [transfer(DEPOSIT, PDA), transfer(DEPOSIT, PDA)])).toBeNull();
    expect(sweepPattern(DEPOSIT, [transfer(USER, DEPOSIT)])).toBeNull();
  });

  it("names the exchange when the sweep target is a known exchange wallet", () => {
    const pattern = sweepPattern(DEPOSIT, [transfer(DEPOSIT, OKX_WALLET), transfer(DEPOSIT, OKX_WALLET)])!;
    const verdict = classifyDeposit(pattern, { entity: knownEntity(OKX_WALLET), senders: null, sampled: 0 });
    expect(verdict?.deposit).toMatchObject({ name: "OKX", kind: "exchange_deposit", confidence: "high" });
    expect(verdict?.hotWallet).toBeNull();
  });

  it("needs repeated sweeps into heavy fan-in before calling an unknown target a hot wallet", () => {
    const twice = sweepPattern(DEPOSIT, [transfer(DEPOSIT, HOT), transfer(DEPOSIT, HOT)])!;
    const once = sweepPattern(DEPOSIT, [transfer(DEPOSIT, HOT)])!;
    const verdict = classifyDeposit(twice, { senders: 80, sampled: 100 })!;
    expect(verdict.hotWallet).toMatchObject({ kind: "hot_wallet", confidence: "low" });
    expect(describeEntity(verdict.deposit)).toBe("likely deposit or collection address (unidentified exchange or service)");
    expect(classifyDeposit(twice, { senders: 3, sampled: 100 })).toBeNull();
    expect(classifyDeposit(once, { senders: 80, sampled: 100 })).toBeNull();
  });

  it("counts distinct senders into an address", () => {
    const rows = [transfer(USER, HOT), transfer(USER, HOT), transfer(DEPOSIT, HOT), transfer(HOT, USER)];
    expect(distinctSenders(HOT, rows)).toBe(2);
  });
});

describe("Helius identity", () => {
  it("stops asking after the key is refused and reports why", async () => {
    let calls = 0;
    const api = {
      client: {
        restPost: async () => {
          calls++;
          throw new HeliusError("Helius HTTP 403: Forbidden", 403, "/v1/wallet/batch-identity");
        },
      },
    } as unknown as HeliusApi;
    const first = await heliusIdentities(api, [USER]);
    const second = await heliusIdentities(api, [USER]);
    expect(first.note).toMatch(/HTTP 403/);
    expect(second.note).toBe(first.note);
    expect(calls).toBe(1);
  });

  it("combines built-in labels with deposit detection", async () => {
    const api = {
      client: { restPost: async () => [] },
      getTransfersByAddress: async ({ address }: { address: string }) => ({
        data: address === DEPOSIT ? [transfer(DEPOSIT, OKX_WALLET), transfer(DEPOSIT, OKX_WALLET)] : [],
        paginationToken: null,
      }),
    } as unknown as HeliusApi;
    const { entities } = await identifyEntities(api, [OKX_WALLET, DEPOSIT, USER], { deposits: true });
    expect(entities.get(OKX_WALLET)?.kind).toBe("exchange");
    expect(entities.get(DEPOSIT)).toMatchObject({ name: "OKX", kind: "exchange_deposit" });
    expect(entities.has(USER)).toBe(false);
  });
});
