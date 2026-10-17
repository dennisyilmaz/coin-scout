import { z } from "zod";
import type { ToolContext } from "./common.js";

export function registerPrompts({ server }: ToolContext): void {
  server.registerPrompt(
    "investigate_address",
    {
      title: "Investigate an address",
      description: "Structured fraud/AML workflow for a suspicious Solana wallet",
      argsSchema: z.object({
        address: z.string().describe("Wallet address under investigation"),
        context: z.string().optional().describe("What is suspected and why"),
      }),
    },
    ({ address, context }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Investigate Solana address ${address}.`,
              context ? `Context: ${context}` : "",
              "",
              "Work in this order and cite signatures for every claim:",
              "1. analyze_wallet — establish age, portfolio, flow shape and risk flags.",
              "2. find_counterparties — identify the funder, the dominant sink and any address it cycles with.",
              "3. trace_funds direction=in hops=3 — where did the money originate?",
              "4. trace_funds direction=out hops=3 — where did it end up? Note terminal sinks and cycles.",
              "5. analyze_token on every mint that carries material value.",
              "6. compare_wallets against any address that looks like the same actor.",
              "",
              "Finish with: verdict, confidence, the specific evidence, and what is still unknown.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "screen_token",
    {
      title: "Screen a token for rug risk",
      description: "Pre-trade due diligence workflow for an SPL mint",
      argsSchema: z.object({
        mint: z.string().describe("Token mint address"),
      }),
    },
    ({ mint }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Screen SPL token ${mint} for rug-pull and manipulation risk.`,
              "",
              "1. analyze_token — authorities, concentration, holder count, FDV, risk score.",
              "2. get_token_holders — check whether the top holders are pools or individuals.",
              "3. get_assets mode=byCreator on the creator address — has this actor launched other mints?",
              "4. For the largest non-pool holders, analyze_wallet and compare_wallets to test for sybil clusters.",
              "5. get_swaps on the top holders — are they trading with each other (wash trading)?",
              "",
              "Report: go / caution / avoid, with the two or three facts that drove the call.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "trace_stolen_funds",
    {
      title: "Trace stolen funds",
      description: "Follow funds out of an exploited account toward cash-out points",
      argsSchema: z.object({
        address: z.string().describe("Victim or attacker address"),
        signature: z.string().optional().describe("The exploit transaction, if known"),
      }),
    },
    ({ address, signature }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              signature
                ? `Start from transaction ${signature} and trace funds moving through ${address}.`
                : `Trace funds moving out of ${address}.`,
              "",
              signature ? "1. investigate_transaction on the signature — establish what was taken." : "",
              "2. trace_funds direction=out hops=4 with minAmount set high enough to ignore dust.",
              "3. For each terminal sink: analyze_wallet, then get_swaps to see if it converted to SOL/USDC.",
              "4. compare_wallets across the hop-1 addresses to test whether they are one actor splitting funds.",
              "5. Report the flow as a hop-by-hop chain with amounts, timestamps and signatures.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );
}
