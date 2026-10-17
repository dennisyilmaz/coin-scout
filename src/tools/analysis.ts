import { z } from "zod";
import { assertPubkey, assertSignature } from "../util/base58.js";
import { LAMPORTS_PER_SOL, iso, json, num, pct, round, topN } from "../util/format.js";
import { labelOf } from "../util/programs.js";
import { aggregateCounterparties, fetchTransfers } from "../analysis/transfers.js";
import { profileWallet } from "../analysis/wallet.js";
import { analyzeToken } from "../analysis/token.js";
import { traceFunds } from "../analysis/flow.js";
import { compareWallets } from "../analysis/linkage.js";
import { normalizeSwap } from "../analysis/swaps.js";
import { findCluster } from "../analysis/cluster.js";
import { walletPnl } from "../analysis/pnl.js";
import { historicalPrices } from "../analysis/prices.js";
import { bridgesIn, resolveBridgeTx, type BridgeHop } from "../analysis/bridges.js";
import type { EnhancedTransaction } from "../helius/types.js";
import { saveArtifact } from "../cases/store.js";
import { shortAddress } from "../cases/diagram.js";
import { READ_ONLY, safe, type ToolContext } from "./common.js";

const Address = z.string().describe("Base58 Solana address");
const CaseName = z
  .string()
  .optional()
  .describe("Save the result into this case file (created if missing) so later work and exports can use it");

export function registerAnalysisTools(ctx: ToolContext): void {
  const { server, api, config } = ctx;

  server.registerTool(
    "analyze_wallet",
    {
      title: "Analyze wallet",
      description:
        "One-call wallet profile: portfolio value, holdings, first/last activity, in/out flow shape, top counterparties, earliest funders and heuristic risk flags (fresh wallet, single funder, fan-in/fan-out, frozen assets). Start every wallet investigation here.",
      inputSchema: z.object({
        address: Address,
        transferSample: z
          .number()
          .int()
          .min(50)
          .max(2000)
          .default(400)
          .describe("How many recent transfers to profile — higher is slower but more accurate"),
        holdings: z.number().int().min(1).max(50).default(15),
        counterparties: z.number().int().min(1).max(50).default(15),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ address, transferSample, holdings, counterparties }) => {
      assertPubkey(address);
      return json(
        await profileWallet(api, address, {
          transferSample,
          maxPages: config.maxPageFetch,
          holdingsShown: holdings,
          counterpartiesShown: counterparties,
        }),
      );
    }),
  );

  server.registerTool(
    "analyze_token",
    {
      title: "Analyze token risk",
      description:
        "Rug-pull and manipulation screen for an SPL mint: live mint/freeze authority, metadata mutability, supply, FDV, holder count, top-holder concentration (top1/top10/HHI) with program-owned pools separated from real holders, plus a 0-100 risk score and explicit flags.",
      inputSchema: z.object({
        mint: Address,
        holders: z.number().int().min(1).max(20).default(20),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ mint, holders }) => {
      assertPubkey(mint, "mint");
      return json(await analyzeToken(api, mint, holders));
    }),
  );

  server.registerTool(
    "trace_funds",
    {
      title: "Trace fund flow",
      description:
        "Breadth-first fund-flow graph from a wallet, forwards (where money went) or backwards (where money came from), up to N hops. Returns nodes, weighted edges, terminal sinks and detected circular flows. The core tool for following stolen or laundered funds.",
      inputSchema: z.object({
        address: Address,
        direction: z
          .enum(["out", "in"])
          .default("out")
          .describe("out = follow money leaving; in = follow money arriving"),
        hops: z.number().int().min(1).max(5).default(3),
        mint: z.string().optional().describe("Restrict the trace to one token mint"),
        minAmount: z
          .number()
          .min(0)
          .default(0)
          .describe("Ignore transfers below this UI amount — key for cutting dust noise"),
        sinceUnix: z.number().int().optional(),
        perNodeTransfers: z.number().int().min(10).max(500).default(100),
        branchFactor: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(8)
          .describe("How many highest-value children to expand per hop"),
        maxNodesShown: z.number().int().min(10).max(400).default(80),
        maxEdgesShown: z.number().int().min(10).max(600).default(120),
        usdAtTime: z
          .boolean()
          .default(true)
          .describe("Value every edge in USD at the time of each transfer (DefiLlama historical prices)"),
        followBridges: z
          .boolean()
          .default(true)
          .describe("Stop at Wormhole/deBridge/Mayan transactions and resolve the destination chain and address"),
        case: CaseName,
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      assertPubkey(args.address);
      if (args.mint) assertPubkey(args.mint, "mint");
      const result = await traceFunds(api, {
        root: args.address,
        direction: args.direction,
        hops: args.hops,
        mint: args.mint,
        minAmount: args.minAmount,
        sinceTs: args.sinceUnix,
        perNodeTransfers: args.perNodeTransfers,
        maxNodes: config.maxTraceNodes,
        branchFactor: args.branchFactor,
        maxNodesShown: args.maxNodesShown,
        maxEdgesShown: args.maxEdgesShown,
        usdAtTime: args.usdAtTime,
        followBridges: args.followBridges,
      });
      if (!args.case) return json(result);

      const mints = [...new Set(result.edges.map((e) => e.mint))].slice(0, 50);
      const assets = await api.getAssetBatch(mints).catch(() => []);
      const mintSymbols: Record<string, string> = {};
      for (const asset of assets) {
        const symbol = asset?.content?.metadata?.symbol ?? asset?.token_info?.symbol;
        if (asset && symbol) mintSymbols[asset.id] = symbol;
      }
      const savedTo = saveArtifact(
        args.case,
        "trace",
        `Funds ${args.direction === "out" ? "leaving" : "arriving at"} ${shortAddress(args.address)} (${args.hops} hops)`,
        { ...result, mintSymbols },
      );
      return json({ ...result, savedTo });
    }),
  );

  server.registerTool(
    "find_cluster",
    {
      title: "Find wallet cluster",
      description:
        "Start from one wallet and discover the other wallets likely controlled by the same actor: who pays its fees, who co-signs with it, where its token-account rent goes, which wallets share its funder, plus same-slot activity, creation time and timing similarity. Returns scored members with the signature evidence for each signal. Use compare_wallets instead when you already have the candidate list.",
      inputSchema: z.object({
        address: Address,
        txSample: z
          .number()
          .int()
          .min(50)
          .max(500)
          .default(150)
          .describe("Recent full transactions of the seed to mine for fee payers, co-signers and rent flows"),
        maxCandidates: z
          .number()
          .int()
          .min(5)
          .max(60)
          .default(30)
          .describe("How many discovered candidates to score in depth"),
        case: CaseName,
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ address, txSample, maxCandidates, case: caseName }) => {
      assertPubkey(address);
      const result = await findCluster(api, address, {
        txSample,
        maxCandidates,
        maxPages: config.maxPageFetch,
      });
      if (!caseName) return json(result);
      const savedTo = saveArtifact(caseName, "cluster", `Cluster around ${shortAddress(address)}`, result);
      return json({ ...result, savedTo });
    }),
  );

  server.registerTool(
    "follow_bridge",
    {
      title: "Follow funds across a bridge",
      description:
        "Resolve where funds went when they left Solana (or where they came from when they arrived) through Wormhole, deBridge or Mayan: other chain, recipient address, amounts and the transaction hash on the other chain. Pass signatures, or an address to scan its recent history for bridge transactions. trace_funds already resolves the crossings it meets.",
      inputSchema: z.object({
        signatures: z.array(z.string()).min(1).max(20).optional(),
        address: Address.optional(),
        scanLimit: z
          .number()
          .int()
          .min(10)
          .max(1000)
          .default(200)
          .describe("How many recent transactions of address to scan for bridge activity"),
        case: CaseName,
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ signatures, address, scanLimit, case: caseName }) => {
      if (!signatures?.length && !address) throw new Error("Pass signatures or an address");
      signatures?.forEach((s) => assertSignature(s));
      if (address) assertPubkey(address);

      const txs: EnhancedTransaction[] = [];
      if (signatures?.length) {
        txs.push(...(await api.parseTransactions(signatures, "confirmed")));
      } else {
        let before: string | undefined;
        while (txs.length < scanLimit) {
          const page = await api
            .getEnhancedHistory({ address: address!, limit: Math.min(100, scanLimit - txs.length), before })
            .catch(() => [] as EnhancedTransaction[]);
          if (page.length === 0) break;
          txs.push(...page);
          before = page[page.length - 1].signature;
        }
      }

      const bridgeTxs = txs
        .map((tx) => ({ tx, bridges: bridgesIn(tx) }))
        .filter((entry) => entry.bridges.length > 0);
      const crossings: BridgeHop[] = [];
      const unresolved: Array<{ signature: string; bridges: string[]; reason: string }> = [];
      await Promise.all(
        bridgeTxs.slice(0, 25).map(async ({ tx, bridges }) => {
          const { hops, errors } = await resolveBridgeTx(tx.signature, bridges);
          if (hops.length === 0) {
            unresolved.push({
              signature: tx.signature,
              bridges,
              reason: errors[0] ?? "bridge API has no record of this transaction",
            });
          }
          crossings.push(...hops);
        }),
      );

      const result = {
        address: address ?? null,
        scannedTransactions: txs.length,
        bridgeTransactions: bridgeTxs.length,
        crossings,
        unresolved,
        notChecked: bridgeTxs.slice(25).map((entry) => entry.tx.signature),
        notFoundSignatures: signatures?.filter((s) => !txs.some((tx) => tx.signature === s)) ?? [],
      };
      if (!caseName) return json(result);
      const savedTo = saveArtifact(
        caseName,
        "bridge",
        address ? `Bridge activity of ${shortAddress(address)}` : `Bridge crossings (${crossings.length})`,
        result,
      );
      return json({ ...result, savedTo });
    }),
  );

  server.registerTool(
    "wallet_pnl",
    {
      title: "Wallet profit and loss",
      description:
        "Realized and unrealized PnL per token from a wallet's DEX swaps, valued in USD at the time of each swap (average-cost basis). Answers \"did this wallet profit from the rug\" (pass mint), sniper/insider profit, and overall trading results. Sales of tokens never bought in the sample (airdropped, sent by a dev wallet, bought before the sample) are reported as unmatchedProceedsUsd and realizedPnlIfUnboughtFreeUsd instead of realized PnL — check those for insiders. With mint set, receivedWithoutSwap lists who sent the wallet that token for free.",
      inputSchema: z.object({
        address: Address,
        mint: z.string().optional().describe("Only swaps that touch this token"),
        swapLimit: z.number().int().min(20).max(1000).default(300),
        top: z.number().int().min(1).max(100).default(25),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ address, mint, swapLimit, top }) => {
      assertPubkey(address);
      if (mint) assertPubkey(mint, "mint");
      return json(
        await walletPnl(api, address, { swapLimit, maxPages: config.maxPageFetch, mint, top }),
      );
    }),
  );

  server.registerTool(
    "find_counterparties",
    {
      title: "Find counterparties",
      description:
        "Rank every address a wallet transacted with over a transfer sample, split by inbound/outbound count and per-mint volume, with first/last contact. Use to spot the funder, the sink, or the one address a wallet keeps cycling with.",
      inputSchema: z.object({
        address: Address,
        transferSample: z.number().int().min(50).max(2000).default(500),
        mint: z.string().optional(),
        direction: z.enum(["in", "out", "any"]).default("any"),
        top: z.number().int().min(1).max(200).default(40),
        sinceUnix: z.number().int().optional(),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      assertPubkey(args.address);
      if (args.mint) assertPubkey(args.mint, "mint");
      const page = await fetchTransfers(
        api,
        {
          address: args.address,
          direction: args.direction,
          mint: args.mint,
          sortOrder: "desc",
          filters: args.sinceUnix ? { blockTime: { gte: args.sinceUnix } } : undefined,
        },
        args.transferSample,
        config.maxPageFetch,
      );

      const stats = aggregateCounterparties(page.transfers, args.address);
      return json({
        address: args.address,
        sampledTransfers: page.transfers.length,
        sampleTruncated: page.truncated,
        uniqueCounterparties: stats.length,
        counterparties: topN(stats, args.top, (c) => c.inCount + c.outCount).map((c) => ({
          address: c.address,
          label: labelOf(c.address) ?? null,
          inCount: c.inCount,
          outCount: c.outCount,
          sharePct: pct(c.inCount + c.outCount, page.transfers.length),
          inByMint: c.inByMint,
          outByMint: c.outByMint,
          firstAt: iso(c.firstTs),
          lastAt: iso(c.lastTs),
        })),
      });
    }),
  );

  server.registerTool(
    "compare_wallets",
    {
      title: "Compare wallets for linkage",
      description:
        "Sybil / co-ownership check across 2-10 wallets: direct transfers between them, shared funders, counterparty-set Jaccard overlap and a 0-100 link strength per pair. Use to test whether separate addresses are the same actor.",
      inputSchema: z.object({
        addresses: z.array(Address).min(2).max(10),
        transferSample: z.number().int().min(50).max(1000).default(300),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ addresses, transferSample }) => {
      addresses.forEach((a) => assertPubkey(a));
      return json(await compareWallets(api, addresses, transferSample, config.maxPageFetch));
    }),
  );

  server.registerTool(
    "investigate_transaction",
    {
      title: "Investigate transaction",
      description:
        "Deep dive on one signature: enhanced parse, net SOL/token delta per account, every mint involved screened for rug risk, and a profile of the fee payer. Use when a single transaction is the starting point of an investigation.",
      inputSchema: z.object({
        signature: z.string(),
        screenMints: z.boolean().default(true).describe("Run analyze_token on each mint involved"),
        profileFeePayer: z.boolean().default(true),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ signature, screenMints, profileFeePayer }) => {
      assertSignature(signature);
      const [parsed] = await api.parseTransactions([signature], "confirmed");
      if (!parsed) return json({ signature, found: false });

      const mints = [...new Set((parsed.tokenTransfers ?? []).map((t) => t.mint))].slice(0, 5);

      const [tokenReports, payerProfile] = await Promise.all([
        screenMints
          ? Promise.all(
              mints.map((mint) =>
                analyzeToken(api, mint, 5)
                  .then((report) => ({
                    mint,
                    symbol: report.metadata.symbol,
                    riskScore: report.riskScore,
                    riskFlags: report.riskFlags,
                    top1Pct: report.distribution.top1Pct,
                  }))
                  .catch((error) => ({ mint, error: String(error) })),
              ),
            )
          : Promise.resolve([]),
        profileFeePayer && parsed.feePayer
          ? profileWallet(api, parsed.feePayer, {
              transferSample: 200,
              maxPages: 3,
              holdingsShown: 5,
              counterpartiesShown: 5,
            }).catch(() => null)
          : Promise.resolve(null),
      ]);

      const changed = (parsed.accountData ?? []).filter(
        (entry) => entry.nativeBalanceChange !== 0 || entry.tokenBalanceChanges?.length > 0,
      );
      const book = await historicalPrices([
        { mint: "SOL", ts: parsed.timestamp },
        ...changed.flatMap((entry) =>
          (entry.tokenBalanceChanges ?? []).map((c) => ({ mint: c.mint, ts: parsed.timestamp })),
        ),
      ]);
      const balanceDeltas = changed.map((entry) => {
        const solDelta = round(entry.nativeBalanceChange / LAMPORTS_PER_SOL, 9);
        return {
          account: entry.account,
          label: labelOf(entry.account) ?? null,
          solDelta,
          solUsdAtTime: solDelta ? book.usd("SOL", parsed.timestamp, solDelta) : null,
          tokenDeltas: (entry.tokenBalanceChanges ?? []).map((change) => {
            const amount = round(
              num(change.rawTokenAmount.tokenAmount) / 10 ** change.rawTokenAmount.decimals,
              9,
            );
            return {
              mint: change.mint,
              owner: change.userAccount,
              amount,
              usdAtTime: book.usd(change.mint, parsed.timestamp, amount),
            };
          }),
        };
      });

      return json({
        signature,
        found: true,
        slot: parsed.slot,
        time: iso(parsed.timestamp),
        type: parsed.type,
        source: parsed.source,
        description: parsed.description,
        failed: Boolean(parsed.transactionError),
        error: parsed.transactionError ?? null,
        feePayer: parsed.feePayer,
        feeSol: round(parsed.fee / LAMPORTS_PER_SOL, 9),
        swap: parsed.events?.swap ? normalizeSwap(parsed) : null,
        balanceDeltas,
        mintsInvolved: tokenReports,
        feePayerProfile: payerProfile
          ? {
              portfolio: payerProfile.portfolio,
              activity: payerProfile.activity,
              riskFlags: payerProfile.riskFlags,
            }
          : null,
      });
    }),
  );
}
