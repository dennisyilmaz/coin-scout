import { z } from "zod";
import { assertPubkey } from "../util/base58.js";
import { isOffCurve } from "../util/curve.js";
import { json } from "../util/format.js";
import { PROGRAM_LABELS, labelOf } from "../util/programs.js";
import { caseLabelOf } from "../cases/store.js";
import { describeEntity, identifyEntities } from "../labels/entities.js";
import { detectWashTrading } from "../analysis/wash.js";
import { EVM_CHAINS, evmChain, isEvmAddress, traceEvm } from "../evm/trace.js";
import { READ_ONLY, safe, type ToolContext } from "./common.js";

export function registerForensicsTools(ctx: ToolContext): void {
  const { server, api, config } = ctx;

  server.registerTool(
    "identify_addresses",
    {
      title: "Identify addresses",
      description:
        "Who is behind these Solana addresses: built-in exchange wallets (OKX proof-of-reserves addresses, ownership signature verified), Helius wallet identity when the API key has access, case labels, program labels, and a deposit-address check that flags addresses sweeping their funds to an exchange or a high fan-in hot wallet. Each label says its source and confidence.",
      inputSchema: z.object({
        addresses: z.array(z.string()).min(1).max(50),
        checkDeposits: z
          .boolean()
          .default(true)
          .describe("Read recent transfers to spot deposit addresses (about 2 Helius calls per unlabelled address, up to 8 addresses)"),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ addresses, checkDeposits }) => {
      addresses.forEach((a) => assertPubkey(a));
      const unique = [...new Set(addresses)];
      const { entities, notes } = await identifyEntities(api, unique, { deposits: checkDeposits });
      return json({
        addresses: unique.map((address) => {
          const entity = entities.get(address) ?? null;
          return {
            address,
            label: labelOf(address) ?? (entity ? describeEntity(entity) : null),
            program: PROGRAM_LABELS[address] ?? null,
            caseLabel: caseLabelOf(address) ?? null,
            entity,
            programDerived: isOffCurve(address),
          };
        }),
        notes,
      });
    }),
  );

  server.registerTool(
    "detect_wash_trading",
    {
      title: "Detect wash trading",
      description:
        "Read a token's recent trades straight from its highest-volume AMM pools or bonding curve (found through DexScreener and the top holders, each checked on-chain) and score them for wash trading: wallets whose buys and sells cancel out, same-slot buy+sell, quick round trips of the same size, volume concentration, and traders funded by a common wallet. Returns a 0-100 score, flags, the suspicious traders with a sample signature each, and funder groups.",
      inputSchema: z.object({
        mint: z.string().describe("Token mint address"),
        maxTransfers: z
          .number()
          .int()
          .min(100)
          .max(3000)
          .default(1000)
          .describe("Pool transfers to read across all pools (100 per Helius call)"),
        maxPools: z.number().int().min(1).max(5).default(3),
        pools: z
          .array(z.string())
          .max(5)
          .optional()
          .describe("Vault owner addresses to read trades from (the pool account, or the Raydium v4/CPMM authority). Found automatically when omitted"),
        sinceUnix: z.number().int().optional(),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ mint, maxTransfers, maxPools, pools, sinceUnix }) => {
      assertPubkey(mint, "mint");
      pools?.forEach((p) => assertPubkey(p, "pool"));
      return json(await detectWashTrading(api, mint, { maxTransfers, maxPools, pools, sinceTs: sinceUnix }));
    }),
  );

  server.registerTool(
    "trace_evm",
    {
      title: "Trace funds on an EVM chain",
      description: `Follow funds forward from an address on an EVM chain, usually the destination of a bridge crossing that trace_funds or follow_bridge found. Reads native and ERC-20 transfers, values them in USD at the time, expands the largest recipients and stops at contracts and labelled addresses. Chains: ${EVM_CHAINS.map((c) => c.name).join(", ")}. Ethereum works without a key through Blockscout; the rest need ETHERSCAN_API_KEY.`,
      inputSchema: z.object({
        chain: z.string().describe("Chain name or id, e.g. Ethereum, Base, Arbitrum, 8453"),
        address: z.string().describe("0x address"),
        hops: z.number().int().min(1).max(3).default(2),
        branchFactor: z.number().int().min(1).max(8).default(3),
        sinceUnix: z.number().int().optional(),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ chain: name, address, hops, branchFactor, sinceUnix }) => {
      const chain = evmChain(name);
      if (!chain) throw new Error(`Unknown EVM chain "${name}". Supported: ${EVM_CHAINS.map((c) => c.name).join(", ")}`);
      if (!isEvmAddress(address)) throw new Error("address must be a 0x-prefixed 20-byte hex address");
      return json(
        await traceEvm({ chain, address, hops, branchFactor, sinceTs: sinceUnix, etherscanKey: config.etherscanApiKey }),
      );
    }),
  );
}
