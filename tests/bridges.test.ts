import { describe, expect, it } from "vitest";
import {
  bridgesIn,
  normalizeDebridge,
  normalizeMayan,
  normalizeWormhole,
} from "../src/analysis/bridges.js";
import type { EnhancedTransaction } from "../src/helius/types.js";

const SIG =
  "Sig1111111111111111111111111111111111111111111111111111111111111111111111111111111111111";

describe("bridgesIn", () => {
  it("finds bridge programs in outer and inner instructions", () => {
    const tx = {
      instructions: [
        { programId: "ComputeBudget111111111111111111111111111111", data: "", accounts: [] },
        {
          programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
          data: "",
          accounts: [],
          innerInstructions: [
            { programId: "src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4", data: "", accounts: [] },
          ],
        },
      ],
    } as unknown as EnhancedTransaction;
    expect(bridgesIn(tx)).toEqual(["debridge"]);
  });

  it("ignores Wormhole core-only transactions unless tokens move", () => {
    const core = {
      instructions: [
        { programId: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth", data: "", accounts: [] },
      ],
    } as unknown as EnhancedTransaction;
    expect(bridgesIn(core)).toEqual([]);
    expect(
      bridgesIn({
        ...core,
        tokenTransfers: [{ mint: "m", tokenAmount: 1 }],
      } as EnhancedTransaction),
    ).toEqual(["wormhole"]);
  });
});

describe("normalizers", () => {
  it("reads an outbound Wormhole Portal transfer that is not redeemed yet", () => {
    const hop = normalizeWormhole(
      {
        emitterChain: 1,
        content: {
          standarizedProperties: {
            fromChain: 1,
            toChain: 2,
            toAddress: "0x1111111111111111111111111111111111111111",
          },
        },
        sourceChain: {
          chainId: 1,
          from: "Sender1111111111111111111111111111111111111",
          status: "confirmed",
          transaction: { txHash: SIG },
        },
        data: { symbol: "ALEPH", tokenAmount: "1602.82268506", usdAmount: "26.25394707" },
      },
      SIG,
    );
    expect(hop).toMatchObject({
      direction: "out",
      fromChain: "Solana",
      toChain: "Ethereum",
      toAddress: "0x1111111111111111111111111111111111111111",
      sent: { token: "ALEPH", amount: 1602.82268506 },
      usd: 26.25,
      destinationTx: null,
      status: "source confirmed, not redeemed",
    });
  });

  it("reads a fulfilled deBridge order including the pre-swap token", () => {
    const hop = normalizeDebridge(
      {
        orderId: { stringValue: "0xorder" },
        makerSrc: { stringValue: "Maker11111111111111111111111111111111111111" },
        receiverDst: { stringValue: "0x2222222222222222222222222222222222222222" },
        state: "Fulfilled",
        giveOfferWithMetadata: {
          chainId: { stringValue: "7565164" },
          finalAmount: { stringValue: "27905761" },
          decimals: 6,
          symbol: "USDC",
        },
        takeOfferWithMetadata: {
          chainId: { stringValue: "8453" },
          finalAmount: { stringValue: "5000000000000000000" },
          decimals: 18,
          symbol: "WETH",
        },
        createdSrcEventMetadata: { transactionHash: "SrcTx" },
        fulfilledDstEventMetadata: { transactionHash: "0xdest" },
        preswapData: {
          inAmount: { stringValue: "28009893" },
          tokenInMetadata: { decimals: 6, symbol: "CASH" },
        },
      },
      "SrcTx",
    );
    expect(hop).toMatchObject({
      direction: "out",
      fromChain: "Solana",
      toChain: "Base",
      sent: { token: "CASH", amount: 28.009893 },
      received: { token: "WETH", amount: 5 },
      destinationTx: "0xdest",
      explorer: "https://app.debridge.finance/order?orderId=0xorder",
    });
  });

  it("reads an inbound Mayan swap and keeps unknown chains as raw ids", () => {
    const hop = normalizeMayan(
      {
        sourceChain: "999",
        destChain: "1",
        trader: "0x3333",
        destAddress: "Dest11111111111111111111111111111111111111",
        status: "ORDER_SETTLED",
        fromTokenSymbol: "ETH",
        fromAmount: "0.5",
        toTokenSymbol: "SOL",
        toAmount: "10",
        sourceTxHash: "0xsrc",
        fulfillTxHash: "DstTx",
      },
      "DstTx",
    );
    expect(hop).toMatchObject({
      direction: "in",
      fromChain: "wormhole-chain-999",
      toChain: "Solana",
      destinationTx: "DstTx",
      received: { token: "SOL", amount: 10 },
    });
  });
});
