import type { HeliusClient } from "./client.js";
import { TTL } from "../util/cache.js";
import type {
  DasAsset,
  DasPage,
  EnhancedTransaction,
  SignatureInfo,
  TransferRecord,
} from "./types.js";

export type Commitment = "processed" | "confirmed" | "finalized";
export type Direction = "in" | "out" | "any";

export interface Range {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export class HeliusApi {
  constructor(readonly client: HeliusClient) {}

  getSlot(commitment: Commitment = "confirmed") {
    return this.client.rpc<number>("getSlot", [{ commitment }], { ttlMs: 400 });
  }

  getBalance(address: string, commitment: Commitment = "confirmed") {
    return this.client.rpc<{ context: { slot: number }; value: number }>(
      "getBalance",
      [address, { commitment }],
      { ttlMs: TTL.account },
    );
  }

  getAccountInfo(address: string, encoding = "jsonParsed", commitment: Commitment = "confirmed") {
    return this.client.rpc<{ context: { slot: number }; value: AccountValue | null }>(
      "getAccountInfo",
      [address, { encoding, commitment }],
      { ttlMs: TTL.account },
    );
  }

  getMultipleAccounts(
    addresses: string[],
    encoding = "jsonParsed",
    commitment: Commitment = "confirmed",
  ) {
    return this.client.rpc<{ context: { slot: number }; value: Array<AccountValue | null> }>(
      "getMultipleAccounts",
      [addresses, { encoding, commitment }],
      { ttlMs: TTL.account },
    );
  }

  getTransaction(signature: string, commitment: Commitment = "confirmed") {
    return this.client.rpc<RawTransaction | null>(
      "getTransaction",
      [
        signature,
        { encoding: "jsonParsed", commitment, maxSupportedTransactionVersion: 0 },
      ],
      { ttlMs: commitment === "finalized" ? TTL.immutable : TTL.history },
    );
  }

  getSignaturesForAddress(
    address: string,
    params: { limit?: number; before?: string; until?: string; commitment?: Commitment } = {},
  ) {
    return this.client.rpc<SignatureInfo[]>(
      "getSignaturesForAddress",
      [address, { commitment: "confirmed", ...params }],
      { ttlMs: TTL.history },
    );
  }

  getTransactionsForAddress(params: {
    address: string;
    limit?: number;
    sortOrder?: "asc" | "desc";
    transactionDetails?: "signatures" | "full";
    encoding?: "json" | "jsonParsed" | "base58" | "base64";
    commitment?: Commitment;
    paginationToken?: string;
    filters?: Record<string, unknown>;
  }) {
    const { address, ...rest } = params;
    return this.client.rpc<{
      data: unknown[];
      paginationToken: string | null;
    }>("getTransactionsForAddress", [address, compact(rest)], { ttlMs: TTL.history });
  }

  getTransfersByAddress(params: {
    address: string;
    with?: string;
    direction?: Direction;
    mint?: string;
    solMode?: "merged" | "separate";
    limit?: number;
    paginationToken?: string;
    sortOrder?: "asc" | "desc";
    commitment?: Commitment;
    filters?: { amount?: Range; blockTime?: Range; slot?: Range };
  }) {
    const { address, ...rest } = params;
    return this.client.rpc<{ data: TransferRecord[]; paginationToken: string | null }>(
      "getTransfersByAddress",
      [address, compact(rest)],
      { ttlMs: TTL.history },
    );
  }

  getTokenAccountsByOwner(owner: string, filter: { mint?: string; programId?: string } = {}) {
    const selector = filter.mint
      ? { mint: filter.mint }
      : { programId: filter.programId ?? TOKEN_PROGRAM };
    return this.client.rpc<{ context: { slot: number }; value: TokenAccountEntry[] }>(
      "getTokenAccountsByOwner",
      [owner, selector, { encoding: "jsonParsed", commitment: "confirmed" }],
      { ttlMs: TTL.account },
    );
  }

  getTokenSupply(mint: string) {
    return this.client.rpc<{ context: { slot: number }; value: UiTokenAmount }>(
      "getTokenSupply",
      [mint, { commitment: "confirmed" }],
      { ttlMs: TTL.supply },
    );
  }

  getTokenLargestAccounts(mint: string) {
    return this.client.rpc<{
      context: { slot: number };
      value: Array<UiTokenAmount & { address: string }>;
    }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], { ttlMs: TTL.supply });
  }

  getTokenAccountBalance(tokenAccount: string) {
    return this.client.rpc<{ context: { slot: number }; value: UiTokenAmount }>(
      "getTokenAccountBalance",
      [tokenAccount, { commitment: "confirmed" }],
      { ttlMs: TTL.account },
    );
  }

  getBlock(slot: number, transactionDetails: "none" | "signatures" | "accounts" | "full" = "none") {
    return this.client.rpc<unknown>(
      "getBlock",
      [
        slot,
        {
          encoding: "jsonParsed",
          transactionDetails,
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
      { ttlMs: TTL.immutable },
    );
  }

  getBlockTime(slot: number) {
    return this.client.rpc<number | null>("getBlockTime", [slot], { ttlMs: TTL.immutable });
  }

  getEpochInfo() {
    return this.client.rpc<{
      absoluteSlot: number;
      blockHeight: number;
      epoch: number;
      slotIndex: number;
      slotsInEpoch: number;
      transactionCount: number;
    }>("getEpochInfo", [{ commitment: "confirmed" }], { ttlMs: 2_000 });
  }

  getProgramAccounts(programId: string, options: Record<string, unknown>) {
    return this.client.rpc<unknown>("getProgramAccounts", [programId, options], {
      ttlMs: TTL.account,
      batch: false,
    });
  }

  getPriorityFeeEstimate(params: Record<string, unknown>) {
    return this.client.rpc<{
      priorityFeeEstimate?: number;
      priorityFeeLevels?: Record<string, number>;
    }>("getPriorityFeeEstimate", [params], { ttlMs: TTL.fee });
  }

  simulateTransaction(transaction: string, options: Record<string, unknown> = {}) {
    return this.client.rpc<unknown>(
      "simulateTransaction",
      [transaction, { encoding: "base64", commitment: "confirmed", ...options }],
      { batch: false },
    );
  }

  getAsset(id: string, displayOptions: Record<string, boolean> = {}) {
    return this.client.rpc<DasAsset>(
      "getAsset",
      { id, options: { showFungible: true, ...displayOptions } },
      { ttlMs: TTL.asset, batch: false },
    );
  }

  getAssetBatch(ids: string[], displayOptions: Record<string, boolean> = {}) {
    return this.client.rpc<Array<DasAsset | null>>(
      "getAssetBatch",
      { ids, options: { showFungible: true, ...displayOptions } },
      { ttlMs: TTL.asset, batch: false },
    );
  }

  getAssetsByOwner(params: {
    ownerAddress: string;
    page?: number;
    limit?: number;
    displayOptions?: Record<string, boolean>;
    sortBy?: { sortBy: string; sortDirection: string };
  }) {
    return this.client.rpc<DasPage<DasAsset>>(
      "getAssetsByOwner",
      {
        page: 1,
        limit: 200,
        ...params,
        displayOptions: {
          showFungible: true,
          showNativeBalance: true,
          showGrandTotal: true,
          ...params.displayOptions,
        },
      },
      { ttlMs: TTL.asset, batch: false },
    );
  }

  searchAssets(params: Record<string, unknown>) {
    return this.client.rpc<DasPage<DasAsset>>("searchAssets", params, {
      ttlMs: TTL.asset,
      batch: false,
    });
  }

  getAssetsByGroup(params: {
    groupKey: string;
    groupValue: string;
    page?: number;
    limit?: number;
  }) {
    return this.client.rpc<DasPage<DasAsset>>(
      "getAssetsByGroup",
      { page: 1, limit: 1000, ...params },
      { ttlMs: TTL.asset, batch: false },
    );
  }

  getAssetsByCreator(params: {
    creatorAddress: string;
    onlyVerified?: boolean;
    page?: number;
    limit?: number;
  }) {
    return this.client.rpc<DasPage<DasAsset>>(
      "getAssetsByCreator",
      { page: 1, limit: 1000, ...params },
      { ttlMs: TTL.asset, batch: false },
    );
  }

  getAssetsByAuthority(params: { authorityAddress: string; page?: number; limit?: number }) {
    return this.client.rpc<DasPage<DasAsset>>(
      "getAssetsByAuthority",
      { page: 1, limit: 1000, ...params },
      { ttlMs: TTL.asset, batch: false },
    );
  }

  getSignaturesForAsset(params: { id: string; page?: number; limit?: number }) {
    return this.client.rpc<DasPage<[string, string]>>(
      "getSignaturesForAsset",
      { page: 1, limit: 1000, ...params },
      { ttlMs: TTL.history, batch: false },
    );
  }

  getDasTokenAccounts(params: {
    mint?: string;
    owner?: string;
    limit?: number;
    cursor?: string;
    options?: Record<string, boolean>;
  }) {
    return this.client.rpc<{
      total: number;
      limit: number;
      cursor?: string;
      token_accounts: DasTokenAccount[];
    }>("getTokenAccounts", { limit: 1000, ...params }, { ttlMs: TTL.asset, batch: false });
  }

  parseTransactions(signatures: string[], commitment: Commitment = "finalized") {
    return this.client.restPost<EnhancedTransaction[]>(
      "/v0/transactions",
      { transactions: signatures, commitment },
      { ttlMs: TTL.immutable },
    );
  }

  getEnhancedHistory(params: {
    address: string;
    limit?: number;
    type?: string;
    source?: string;
    before?: string;
    until?: string;
    commitment?: Commitment;
    timeoutMs?: number;
  }) {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.type) query.set("type", params.type);
    if (params.source) query.set("source", params.source);
    if (params.before) query.set("before-signature", params.before);
    if (params.until) query.set("after-signature", params.until);
    if (params.commitment) query.set("commitment", params.commitment);
    const suffix = query.toString();
    return this.client.restGet<EnhancedTransaction[]>(
      `/v0/addresses/${params.address}/transactions${suffix ? `?${suffix}` : ""}`,
      { ttlMs: TTL.history, timeoutMs: params.timeoutMs },
    );
  }
}

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface AccountValue {
  lamports: number;
  owner: string;
  executable: boolean;
  rentEpoch: number | string;
  space?: number;
  data: unknown;
}

export interface UiTokenAmount {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}

export interface TokenAccountEntry {
  pubkey: string;
  account: {
    lamports: number;
    owner: string;
    data: {
      parsed?: {
        info?: {
          mint: string;
          owner: string;
          tokenAmount: UiTokenAmount;
          state?: string;
          delegate?: string;
        };
      };
    };
  };
}

export interface DasTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: number;
  delegated_amount?: number;
  frozen?: boolean;
}

export interface RawTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: unknown[];
    postTokenBalances?: unknown[];
    logMessages?: string[];
    computeUnitsConsumed?: number;
    innerInstructions?: unknown[];
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean; source?: string }>;
      instructions: unknown[];
      recentBlockhash: string;
    };
  };
  version?: number | string;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
