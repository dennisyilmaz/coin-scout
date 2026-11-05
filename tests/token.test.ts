import { describe, expect, it } from "vitest";
import { analyzeToken } from "../src/analysis/token.js";
import type { HeliusApi } from "../src/helius/api.js";
import { isReadOnlyMethod } from "../src/tools/data.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const POOL_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const WALLET = "74xPaYPYThVds82iumn97qoxS3fb1jXycKD3LQqkVXmv";
const CURVE_ACCOUNT = "7Ag95vBBM8tKdhH8kf4NwX8T9aGsZAoMMv1c6SULjbqs";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SYSTEM = "11111111111111111111111111111111";

const HOLDINGS = [
  { address: "TokenAccountPool1111111111111111111111111111", owner: POOL_AUTHORITY, program: SYSTEM, amount: 600 },
  { address: "TokenAccountWallet11111111111111111111111111", owner: WALLET, program: SYSTEM, amount: 300 },
  { address: "TokenAccountCurve111111111111111111111111111", owner: CURVE_ACCOUNT, program: PUMP, amount: 100 },
];

const ui = (amount: number) => ({ amount: String(amount), decimals: 0, uiAmount: amount, uiAmountString: String(amount) });

const api = {
  getAsset: async () => ({
    id: MINT,
    interface: "FungibleToken",
    mutable: false,
    token_info: { mint_authority: null, freeze_authority: null, price_info: { price_per_token: 1, currency: "USDC" } },
  }),
  getTokenSupply: async () => ({ context: { slot: 1 }, value: ui(1000) }),
  getTokenLargestAccounts: async () => ({
    context: { slot: 1 },
    value: HOLDINGS.map((h) => ({ address: h.address, ...ui(h.amount) })),
  }),
  getDasTokenAccounts: async () => ({ total: 3, limit: 1000, token_accounts: HOLDINGS.map(() => ({})) }),
  getMultipleAccounts: async (addresses: string[]) => ({
    context: { slot: 1 },
    value: addresses.map((address) => {
      const byAccount = HOLDINGS.find((h) => h.address === address);
      if (byAccount) return { owner: "Tokenkeg", data: { parsed: { info: { owner: byAccount.owner } } } };
      const byOwner = HOLDINGS.find((h) => h.owner === address);
      return byOwner ? { owner: byOwner.program, data: null } : null;
    }),
  }),
} as unknown as HeliusApi;

describe("analyzeToken holder classification", () => {
  it("separates pools and PDAs from wallets without mislabelling wallets as the System Program", async () => {
    const report = await analyzeToken(api, MINT, 20);
    const [pool, wallet, curve] = report.topHolders;

    expect(pool.isProgramOwned).toBe(true);
    expect(wallet.isProgramOwned).toBe(false);
    expect(wallet.ownerLabel).toBeNull();
    expect(curve.isProgramOwned).toBe(true);
    expect(curve.ownerLabel).toBe("Pump.fun");

    expect(report.distribution.programControlledPct).toBe(70);
    expect(report.riskFlags.find((f) => f.startsWith("extreme_concentration"))).toContain("program-controlled");
    expect(report.riskFlags.find((f) => f.startsWith("program_controlled_holders"))).toContain("2 of the top holders");
  });
});

describe("solana_rpc method allowlist", () => {
  it("forwards read-only methods", () => {
    for (const method of ["getBalance", "getAsset", "searchAssets", "isBlockhashValid", "minimumLedgerSlot", "simulateTransaction"]) {
      expect(isReadOnlyMethod(method), method).toBe(true);
    }
  });

  it("rejects anything that could submit or sign", () => {
    for (const method of ["sendTransaction", "requestAirdrop", "sendBundle", "signTransaction", "get", "getBalance; drop", ""]) {
      expect(isReadOnlyMethod(method), method).toBe(false);
    }
  });
});
