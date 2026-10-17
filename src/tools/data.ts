import { z } from "zod";
import { assertPubkey, assertSignature } from "../util/base58.js";
import { LAMPORTS_PER_SOL, iso, json, num, round } from "../util/format.js";
import { labelOf } from "../util/programs.js";
import { fetchTransfers, slimTransfer } from "../analysis/transfers.js";
import { historicalPrices } from "../analysis/prices.js";
import { fetchSwaps, normalizeSwap, summarizeSwaps } from "../analysis/swaps.js";
import { READ_ONLY, safe, type ToolContext } from "./common.js";

const Address = z.string().describe("Base58 Solana address");
const Commitment = z.enum(["processed", "confirmed", "finalized"]).default("confirmed");

export function registerDataTools(ctx: ToolContext): void {
  const { server, api, config } = ctx;

  server.registerTool(
    "chain_status",
    {
      title: "Chain status",
      description:
        "Current Solana slot, epoch, block height and recommended priority fee. Cheap orientation call — use it to anchor timestamps and confirm the RPC is healthy.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    safe(async () => {
      const [epoch, fee] = await Promise.all([
        api.getEpochInfo(),
        api
          .getPriorityFeeEstimate({ options: { includeAllPriorityFeeLevels: true } })
          .catch(() => null),
      ]);
      return json({
        network: config.network,
        slot: epoch.absoluteSlot,
        blockHeight: epoch.blockHeight,
        epoch: epoch.epoch,
        slotInEpoch: `${epoch.slotIndex}/${epoch.slotsInEpoch}`,
        transactionCount: epoch.transactionCount,
        priorityFeeMicroLamports: fee?.priorityFeeLevels ?? null,
        serverTime: new Date().toISOString(),
      });
    }),
  );

  server.registerTool(
    "get_balances",
    {
      title: "Get balances",
      description:
        "SOL and SPL token balances for one or more wallets, with USD value where Helius prices the token. Use this before any transfer or portfolio question.",
      inputSchema: z.object({
        addresses: z.array(Address).min(1).max(20).describe("Wallet addresses to look up"),
        includeZero: z.boolean().default(false).describe("Include zero-balance token accounts"),
        limit: z.number().int().min(1).max(200).default(40).describe("Max token rows per wallet"),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ addresses, includeZero, limit }) => {
      addresses.forEach((a) => assertPubkey(a));
      const wallets = await Promise.all(
        addresses.map(async (address) => {
          const page = await api
            .getAssetsByOwner({
              ownerAddress: address,
              limit: 200,
              displayOptions: { showZeroBalance: includeZero },
            })
            .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));

          if ("error" in page) return { address, error: page.error };

          const tokens = (page.items ?? [])
            .filter((asset) => asset.token_info?.balance !== undefined)
            .map((asset) => {
              const info = asset.token_info!;
              const decimals = info.decimals ?? 0;
              const amount = (info.balance ?? 0) / 10 ** decimals;
              const price = info.price_info?.price_per_token ?? null;
              return {
                mint: asset.id,
                symbol: asset.content?.metadata?.symbol ?? info.symbol ?? null,
                amount: round(amount, 9),
                decimals,
                priceUsd: price,
                valueUsd: price ? round(amount * price, 2) : null,
                frozen: asset.ownership?.frozen ?? false,
                tokenAccount: info.associated_token_address ?? null,
              };
            })
            .filter((t) => includeZero || t.amount > 0)
            .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

          const lamports = page.nativeBalance?.lamports ?? 0;
          return {
            address,
            solBalance: round(lamports / LAMPORTS_PER_SOL, 9),
            solValueUsd: page.nativeBalance?.total_price ?? null,
            tokenValueUsd: round(
              tokens.reduce((acc, t) => acc + (t.valueUsd ?? 0), 0),
              2,
            ),
            tokenCount: tokens.length,
            assetsTotal: page.total,
            tokens: tokens.slice(0, limit),
            tokensTruncated: tokens.length > limit,
          };
        }),
      );
      return json({ wallets });
    }),
  );

  server.registerTool(
    "get_account",
    {
      title: "Get account",
      description:
        "Raw + parsed on-chain account state for any address: lamports, owning program, executable flag and parsed data (mint config, token account, stake, etc). Use this to tell a wallet from a PDA, a mint or a program.",
      inputSchema: z.object({
        addresses: z.array(Address).min(1).max(100),
        encoding: z.enum(["jsonParsed", "base64"]).default("jsonParsed"),
        commitment: Commitment,
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ addresses, encoding, commitment }) => {
      addresses.forEach((a) => assertPubkey(a));
      const result = await api.getMultipleAccounts(addresses, encoding, commitment);
      return json({
        slot: result.context.slot,
        accounts: result.value.map((account, index) => ({
          address: addresses[index],
          exists: account !== null,
          lamports: account?.lamports ?? 0,
          sol: account ? round(account.lamports / LAMPORTS_PER_SOL, 9) : 0,
          owner: account?.owner ?? null,
          ownerLabel: account?.owner ? (labelOf(account.owner) ?? null) : null,
          executable: account?.executable ?? null,
          space: account?.space ?? null,
          data: account?.data ?? null,
        })),
      });
    }),
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get parsed transactions",
      description:
        "Helius enhanced (human-readable) parse of up to 100 signatures: type, source protocol, description, native + token transfers, swap events and per-account balance deltas. This is the primary way to understand what a transaction actually did.",
      inputSchema: z.object({
        signatures: z.array(z.string()).min(1).max(100),
        commitment: z.enum(["confirmed", "finalized"]).default("finalized"),
        includeInstructions: z
          .boolean()
          .default(false)
          .describe("Include raw instruction list — verbose, only for deep decoding"),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ signatures, commitment, includeInstructions }) => {
      signatures.forEach((s) => assertSignature(s));
      const parsed = await api.parseTransactions(signatures, commitment);
      const found = new Set(parsed.map((tx) => tx.signature));
      return json({
        transactions: parsed.map((tx) => ({
          signature: tx.signature,
          slot: tx.slot,
          time: iso(tx.timestamp),
          type: tx.type,
          source: tx.source,
          description: tx.description,
          feePayer: tx.feePayer,
          feeSol: round(tx.fee / LAMPORTS_PER_SOL, 9),
          failed: Boolean(tx.transactionError),
          error: tx.transactionError ?? null,
          nativeTransfers: (tx.nativeTransfers ?? []).map((t) => ({
            from: t.fromUserAccount,
            to: t.toUserAccount,
            sol: round(t.amount / LAMPORTS_PER_SOL, 9),
          })),
          tokenTransfers: (tx.tokenTransfers ?? []).map((t) => ({
            from: t.fromUserAccount,
            to: t.toUserAccount,
            mint: t.mint,
            amount: num(t.tokenAmount),
          })),
          swap: tx.events?.swap ? normalizeSwap(tx) : null,
          instructions: includeInstructions ? tx.instructions : undefined,
        })),
        notFound: signatures.filter((s) => !found.has(s)),
      });
    }),
  );

  server.registerTool(
    "get_transaction_raw",
    {
      title: "Get raw transaction",
      description:
        "Full raw jsonParsed transaction including logMessages, inner instructions, compute units and pre/post balances. Use only when the enhanced parse in get_transactions is not enough (custom programs, failure debugging).",
      inputSchema: z.object({
        signature: z.string(),
        commitment: z.enum(["confirmed", "finalized"]).default("confirmed"),
        includeLogs: z.boolean().default(true),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ signature, commitment, includeLogs }) => {
      assertSignature(signature);
      const tx = await api.getTransaction(signature, commitment);
      if (!tx) return json({ signature, found: false });
      if (!includeLogs && tx.meta) tx.meta.logMessages = undefined;
      return json({ signature, found: true, transaction: tx });
    }),
  );

  server.registerTool(
    "get_transfers",
    {
      title: "Get transfers",
      description:
        "Parsed SOL + SPL transfer feed for a wallet with server-side filters: counterparty, direction, mint, time and slot range. The fastest primitive for fund-movement questions — prefer it over walking signatures.",
      inputSchema: z.object({
        address: Address,
        counterparty: z
          .string()
          .optional()
          .describe("Only transfers between address and this counterparty"),
        direction: z.enum(["in", "out", "any"]).default("any"),
        mint: z.string().optional().describe("Restrict to one token mint"),
        limit: z.number().int().min(1).max(1000).default(100),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
        solMode: z.enum(["merged", "separate"]).default("merged"),
        sinceUnix: z.number().int().optional().describe("Only transfers at/after this unix second"),
        untilUnix: z.number().int().optional().describe("Only transfers at/before this unix second"),
        usdAtTime: z
          .boolean()
          .default(false)
          .describe("Add each transfer's USD value at the time it happened"),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      assertPubkey(args.address);
      if (args.counterparty) assertPubkey(args.counterparty, "counterparty");
      if (args.mint) assertPubkey(args.mint, "mint");

      const blockTime: Record<string, number> = {};
      if (args.sinceUnix) blockTime.gte = args.sinceUnix;
      if (args.untilUnix) blockTime.lte = args.untilUnix;

      const page = await fetchTransfers(
        api,
        {
          address: args.address,
          with: args.counterparty,
          direction: args.direction,
          mint: args.mint,
          sortOrder: args.sortOrder,
          solMode: args.solMode,
          filters: Object.keys(blockTime).length ? { blockTime } : undefined,
        },
        args.limit,
        config.maxPageFetch,
      );

      const transfers = page.transfers.map(slimTransfer);
      if (!args.usdAtTime) {
        return json({
          address: args.address,
          count: transfers.length,
          truncated: page.truncated,
          nextCursor: page.nextCursor,
          transfers,
        });
      }

      const book = await historicalPrices(transfers.map((t) => ({ mint: t.mint, ts: t.ts })));
      const valued = transfers.map((t) => ({ ...t, usdAtTime: book.usd(t.mint, t.ts, t.amount) }));
      const total = (dir: "in" | "out") =>
        round(
          valued
            .filter((t) => (dir === "in" ? t.to === args.address : t.from === args.address))
            .reduce((acc, t) => acc + (t.usdAtTime ?? 0), 0),
          2,
        );
      return json({
        address: args.address,
        count: valued.length,
        truncated: page.truncated,
        nextCursor: page.nextCursor,
        usdInAtTime: total("in"),
        usdOutAtTime: total("out"),
        unpricedTransfers: valued.filter((t) => t.usdAtTime === null).length,
        priceErrors: book.errors,
        transfers: valued,
      });
    }),
  );

  server.registerTool(
    "get_transaction_history",
    {
      title: "Get transaction history",
      description:
        "Signature-level history for an address with slot/time/status filters and cursor pagination. Use when you need coverage of every transaction touching an address, not just transfers.",
      inputSchema: z.object({
        address: Address,
        limit: z.number().int().min(1).max(1000).default(100),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
        status: z.enum(["any", "succeeded", "failed"]).default("any"),
        full: z.boolean().default(false).describe("Return full transactions instead of signatures"),
        paginationToken: z.string().optional(),
        sinceUnix: z.number().int().optional(),
        untilUnix: z.number().int().optional(),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      assertPubkey(args.address);
      const blockTime: Record<string, number> = {};
      if (args.sinceUnix) blockTime.gte = args.sinceUnix;
      if (args.untilUnix) blockTime.lte = args.untilUnix;

      const filters: Record<string, unknown> = {};
      if (args.status !== "any") filters.status = args.status;
      if (Object.keys(blockTime).length) filters.blockTime = blockTime;

      const page = await api.getTransactionsForAddress({
        address: args.address,
        limit: args.limit,
        sortOrder: args.sortOrder,
        transactionDetails: args.full ? "full" : "signatures",
        encoding: args.full ? "jsonParsed" : undefined,
        paginationToken: args.paginationToken,
        filters: Object.keys(filters).length ? filters : undefined,
      });

      return json({
        address: args.address,
        count: page.data?.length ?? 0,
        nextCursor: page.paginationToken,
        data: page.data,
      });
    }),
  );

  server.registerTool(
    "get_swaps",
    {
      title: "Get swaps",
      description:
        "Normalized DEX swap history for a wallet: what was sold, what was bought, venue and fee per trade, plus a per-mint net-position summary. Use for trading behaviour, wash-trading and PnL groundwork.",
      inputSchema: z.object({
        address: Address,
        limit: z.number().int().min(1).max(500).default(100),
        source: z
          .string()
          .optional()
          .describe("Filter by venue, e.g. JUPITER, RAYDIUM, ORCA, PUMP_FUN"),
        includeTrades: z.boolean().default(true).describe("Include the per-trade list"),
        resumeBeforeSignature: z
          .string()
          .optional()
          .describe("Continue an earlier scan from this signature (nextBeforeSignature)"),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ address, limit, source, includeTrades, resumeBeforeSignature }) => {
      assertPubkey(address);
      if (resumeBeforeSignature) assertSignature(resumeBeforeSignature);
      const result = await fetchSwaps(
        api,
        address,
        limit,
        config.maxPageFetch,
        source,
        resumeBeforeSignature,
      );
      return json({
        address,
        truncated: result.truncated,
        nextBeforeSignature: result.lastSignature ?? result.resumeSignature,
        searchExhausted: result.searchExhausted,
        note: result.searchExhausted
          ? "Helius stopped the scan before finding more swaps in this history window. Call again with resumeBeforeSignature set to nextBeforeSignature to keep searching further back."
          : undefined,
        summary: summarizeSwaps(result.swaps),
        trades: includeTrades ? result.swaps : undefined,
      });
    }),
  );

  server.registerTool(
    "get_token_holders",
    {
      title: "Get token holders",
      description:
        "Paginated list of every token account for a mint with owner and balance. Use for holder-distribution work beyond the top-20 that analyze_token returns.",
      inputSchema: z.object({
        mint: Address,
        limit: z.number().int().min(1).max(1000).default(100),
        cursor: z.string().optional(),
        minAmountRaw: z
          .number()
          .optional()
          .describe("Drop accounts below this raw (undecimalised) amount"),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ mint, limit, cursor, minAmountRaw }) => {
      assertPubkey(mint, "mint");
      const [page, supply] = await Promise.all([
        api.getDasTokenAccounts({ mint, limit, cursor }),
        api.getTokenSupply(mint).catch(() => null),
      ]);
      const decimals = supply?.value.decimals ?? 0;
      const total = num(supply?.value.uiAmountString);
      const accounts = (page.token_accounts ?? [])
        .filter((a) => (minAmountRaw ? a.amount >= minAmountRaw : true))
        .map((a) => ({
          tokenAccount: a.address,
          owner: a.owner,
          amount: round(a.amount / 10 ** decimals, 9),
          supplyPct: total ? round((a.amount / 10 ** decimals / total) * 100, 6) : null,
          frozen: a.frozen ?? false,
          delegatedAmount: a.delegated_amount ?? 0,
        }));
      return json({
        mint,
        returned: accounts.length,
        moreAvailable: Boolean(page.cursor) && (page.token_accounts?.length ?? 0) >= limit,
        nextCursor: page.cursor ?? null,
        totalSupply: total,
        accounts,
      });
    }),
  );

  server.registerTool(
    "get_assets",
    {
      title: "Get assets (DAS)",
      description:
        "Digital Asset Standard lookup: one asset by mint, or every asset held by an owner. Covers NFTs, compressed NFTs, fungible tokens and Token-2022, with metadata, authorities, creators, royalties and price.",
      inputSchema: z.object({
        mode: z.enum(["byId", "byOwner", "byCreator", "byAuthority", "byCollection"]),
        value: z.string().describe("The mint, owner, creator, authority or collection address"),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(1000).default(100),
        onlyVerified: z.boolean().default(false).describe("byCreator only: verified creators"),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ mode, value, page, limit, onlyVerified }) => {
      assertPubkey(value);
      switch (mode) {
        case "byId":
          return json(await api.getAsset(value, { showCollectionMetadata: true }));
        case "byOwner":
          return json(await api.getAssetsByOwner({ ownerAddress: value, page, limit }));
        case "byCreator":
          return json(await api.getAssetsByCreator({ creatorAddress: value, page, limit, onlyVerified }));
        case "byAuthority":
          return json(await api.getAssetsByAuthority({ authorityAddress: value, page, limit }));
        case "byCollection":
          return json(
            await api.getAssetsByGroup({ groupKey: "collection", groupValue: value, page, limit }),
          );
      }
    }),
  );

  server.registerTool(
    "search_assets",
    {
      title: "Search assets (DAS)",
      description:
        "Flexible DAS query across owner, creator, collection, compression state and token type. Use to enumerate a scammer's mints, a collection's supply, or every token a wallet ever created.",
      inputSchema: z.object({
        ownerAddress: z.string().optional(),
        creatorAddress: z.string().optional(),
        creatorVerified: z.boolean().optional(),
        collection: z.string().optional(),
        authorityAddress: z.string().optional(),
        tokenType: z
          .enum(["fungible", "nonFungible", "regularNft", "compressedNft", "all"])
          .optional(),
        compressed: z.boolean().optional(),
        burnt: z.boolean().optional(),
        frozen: z.boolean().optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(1000).default(100),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const { collection, ...rest } = args;
      const params: Record<string, unknown> = { ...rest };
      if (collection) {
        assertPubkey(collection, "collection");
        params.grouping = ["collection", collection];
      }
      for (const key of ["ownerAddress", "creatorAddress", "authorityAddress"] as const) {
        if (params[key]) assertPubkey(params[key] as string, key);
      }
      return json(await api.searchAssets(params));
    }),
  );

  server.registerTool(
    "get_asset_activity",
    {
      title: "Get asset activity",
      description:
        "Every transaction signature that touched a COMPRESSED NFT (Bubblegum tree asset), oldest to newest. Use to reconstruct a cNFT's mint-and-sale chain of custody. Fungible mints and standard NFTs are not indexed here — use get_transaction_history or get_transfers for those.",
      inputSchema: z.object({
        assetId: Address,
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(1000).default(100),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ assetId, page, limit }) => {
      assertPubkey(assetId, "assetId");
      try {
        return json(await api.getSignaturesForAsset({ id: assetId, page, limit }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/tree not found|recordnotfound/i.test(message)) throw error;
        return json({
          assetId,
          supported: false,
          reason:
            "Not a compressed NFT — getSignaturesForAsset only indexes Bubblegum tree assets. Use get_transaction_history for a mint's transactions, or get_transfers for its value movements.",
        });
      }
    }),
  );

  server.registerTool(
    "solana_rpc",
    {
      title: "Raw Solana RPC (read-only)",
      description:
        "Escape hatch: call any read-only Solana JSON-RPC or Helius DAS method directly when no dedicated tool fits. Write methods (sendTransaction, requestAirdrop) are rejected.",
      inputSchema: z.object({
        method: z.string().describe("e.g. getProgramAccounts, getInflationReward, getVoteAccounts"),
        params: z
          .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
          .default([])
          .describe("Positional array for Solana RPC, object for DAS methods"),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ method, params }) => {
      if (BLOCKED_METHODS.has(method)) {
        return json({
          error: `Method ${method} is blocked: coin-scout is read-only and never submits transactions.`,
        });
      }
      const result = await api.client.rpc<unknown>(method, params, {
        ttlMs: 0,
        batch: Array.isArray(params),
      });
      return json({ method, result });
    }),
  );

  server.registerTool(
    "server_metrics",
    {
      title: "Server metrics",
      description:
        "coin-scout transport stats: HTTP requests issued, JSON-RPC batch compression, retries, cache hit rate and adaptive rate-limit state. Use to explain slow responses or confirm caching is working.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    safe(async () =>
      json({
        network: config.network,
        rpcOrigin: config.rpcOrigin,
        http2: config.allowH2,
        ...api.client.metrics(),
      }),
    ),
  );
}

const BLOCKED_METHODS = new Set([
  "sendTransaction",
  "requestAirdrop",
  "sendBundle",
  "signTransaction",
]);
