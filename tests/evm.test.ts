import { describe, expect, it } from "vitest";
import { priceKey } from "../src/analysis/prices.js";
import {
  EvmProviderError,
  evmChain,
  evmSource,
  fromBlockscout,
  fromEtherscan,
  isEvmAddress,
  parseEtherscan,
  priceKeyFor,
} from "../src/evm/trace.js";

const SELF = "0x00000000000000000000000000000000000000aa";
const PEER = "0x00000000000000000000000000000000000000bb";
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("EVM chains", () => {
  it("resolves bridge chain names, ids and aliases", () => {
    expect(evmChain("Base")?.chainId).toBe(8453);
    expect(evmChain("BNB Chain")?.llama).toBe("bsc");
    expect(evmChain("arb")?.name).toBe("Arbitrum");
    expect(evmChain(1)?.name).toBe("Ethereum");
    expect(evmChain("Solana")).toBeUndefined();
    expect(evmChain("wormhole-chain-99")).toBeUndefined();
  });

  it("checks addresses and price keys", () => {
    expect(isEvmAddress(PEER)).toBe(true);
    expect(isEvmAddress("0x123")).toBe(false);
    expect(isEvmAddress("CBEADkb8TZAXHjVE3zwad4L995GZE7rJcacJ7asebkVG")).toBe(false);
    const eth = evmChain("Ethereum")!;
    expect(priceKeyFor(eth, TOKEN)).toBe(`ethereum:${TOKEN}`);
    expect(priceKeyFor(evmChain("Base")!, null)).toBe("coingecko:ethereum");
    expect(priceKey(`ethereum:${TOKEN}`)).toBe(`ethereum:${TOKEN}`);
    expect(priceKey("SOL")).toBe("solana:So11111111111111111111111111111111111111112");
  });

  it("asks for an Etherscan key on chains Blockscout cannot serve keyless", () => {
    expect(() => evmSource(evmChain("Base")!, null)).toThrow(/ETHERSCAN_API_KEY/);
    expect(evmSource(evmChain("Ethereum")!, null).name).toBe("blockscout");
    expect(evmSource(evmChain("Base")!, "key").name).toBe("etherscan");
  });
});

describe("Etherscan parsing", () => {
  it("passes empty history and surfaces plan errors", () => {
    expect(parseEtherscan({ status: "0", message: "No transactions found", result: [] })).toEqual([]);
    expect(() =>
      parseEtherscan({ status: "0", message: "NOTOK", result: "Free API access is not supported for this chain" }),
    ).toThrow(EvmProviderError);
  });

  it("keeps outgoing successful transfers and scales amounts exactly", () => {
    const transfers = fromEtherscan(
      SELF,
      [
        { hash: "0x1", timeStamp: "100", from: SELF.toUpperCase().replace("0X", "0x"), to: PEER, value: "1234567", tokenDecimal: "6", tokenSymbol: "USDC", contractAddress: TOKEN.toUpperCase().replace("0X", "0x") },
        { hash: "0x2", timeStamp: "101", from: PEER, to: SELF, value: "5", tokenDecimal: "0", tokenSymbol: "IN", contractAddress: TOKEN },
      ],
      [
        { hash: "0x3", timeStamp: "102", from: SELF, to: PEER, value: "1500000000000000000", isError: "0" },
        { hash: "0x4", timeStamp: "103", from: SELF, to: PEER, value: "1", isError: "1" },
        { hash: "0x5", timeStamp: "104", from: SELF, to: PEER, value: "0", isError: "0" },
      ],
      "ETH",
    );
    expect(transfers).toEqual([
      { hash: "0x1", ts: 100, from: SELF, to: PEER, token: TOKEN, symbol: "USDC", amount: 1.234567 },
      { hash: "0x3", ts: 102, from: SELF, to: PEER, token: null, symbol: "ETH", amount: 1.5 },
    ]);
  });
});

describe("Blockscout parsing", () => {
  it("drops scam tokens, labels contracts and tagged addresses, treats EIP-7702 wallets as wallets", () => {
    const labels = new Map<string, string>();
    const transfers = fromBlockscout(
      SELF,
      [
        {
          transaction_hash: "0xa",
          timestamp: "2026-10-30T08:51:11.000000Z",
          from: { hash: SELF },
          to: { hash: PEER, is_contract: true, proxy_type: "eip7702", metadata: null },
          token: { address_hash: TOKEN, symbol: "USDC", reputation: "ok" },
          total: { decimals: "6", value: "2500000" },
        },
        {
          transaction_hash: "0xb",
          timestamp: "2026-10-30T08:51:12.000000Z",
          from: { hash: SELF },
          to: { hash: "0x00000000000000000000000000000000000000cc", is_contract: true, name: "Router" },
          token: { address_hash: TOKEN, symbol: "FAKE", reputation: "scam" },
          total: { decimals: "0", value: "9" },
        },
      ],
      [
        {
          hash: "0xc",
          timestamp: "2026-10-30T08:51:13.000000Z",
          from: { hash: SELF },
          to: { hash: "0x00000000000000000000000000000000000000dd", metadata: { tags: [{ name: "Binance 14", tagType: "name" }] } },
          value: "250000000000000000",
          status: "ok",
        },
      ],
      "ETH",
      labels,
    );
    expect(transfers.map((t) => [t.hash, t.amount, t.symbol])).toEqual([
      ["0xa", 2.5, "USDC"],
      ["0xc", 0.25, "ETH"],
    ]);
    expect(transfers[0].ts).toBe(Date.parse("2026-10-30T08:51:11Z") / 1000);
    expect(labels.get(PEER)).toBeUndefined();
    expect(labels.get("0x00000000000000000000000000000000000000cc")).toBe("contract: Router");
    expect(labels.get("0x00000000000000000000000000000000000000dd")).toBe("Binance 14");
  });
});

describe("PriceBook", () => {
  it("treats negative prices, such as debt tokens, as unknown", async () => {
    const { PriceBook } = await import("../src/analysis/prices.js");
    const book = new PriceBook(new Map([["ethereum:0xdebt@300", -1], ["ethereum:0xusdc@300", 1]]));
    expect(book.usd("ethereum:0xdebt", 300, 10)).toBeNull();
    expect(book.usd("ethereum:0xusdc", 300, 10)).toBe(10);
  });
});
