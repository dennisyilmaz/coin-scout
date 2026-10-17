import type { HeliusApi } from "../helius/api.js";
import type { EnhancedTransaction } from "../helius/types.js";
import { num, round } from "../util/format.js";
import { HttpError, getJson } from "../util/http.js";
import { TTL } from "../util/cache.js";

export type BridgeName = "wormhole" | "debridge" | "mayan";

export const BRIDGE_PROGRAMS: Record<string, BridgeName> = {
  wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb: "wormhole",
  worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth: "wormhole",
  src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4: "debridge",
  dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo: "debridge",
  DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh: "debridge",
  BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY: "mayan",
  FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf: "mayan",
};

const WORMHOLE_CHAINS: Record<number, string> = {
  1: "Solana",
  2: "Ethereum",
  4: "BNB Chain",
  5: "Polygon",
  6: "Avalanche",
  10: "Fantom",
  14: "Celo",
  16: "Moonbeam",
  21: "Sui",
  22: "Aptos",
  23: "Arbitrum",
  24: "Optimism",
  30: "Base",
  34: "Scroll",
  35: "Mantle",
  38: "Linea",
};

const DEBRIDGE_CHAINS: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  43114: "Avalanche",
  59144: "Linea",
  7565164: "Solana",
};

const WORMHOLE_CORE = "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth";
const WORMHOLE_SOLANA = 1;
const DEBRIDGE_SOLANA = 7565164;

export interface BridgeHop {
  bridge: BridgeName;
  signature: string;
  direction: "out" | "in" | "unknown";
  status: string | null;
  fromChain: string;
  fromAddress: string | null;
  toChain: string;
  toAddress: string | null;
  sent: { token: string | null; amount: number | null } | null;
  received: { token: string | null; amount: number | null } | null;
  usd: number | null;
  sourceTx: string | null;
  destinationTx: string | null;
  explorer: string;
}

export function bridgesIn(tx: EnhancedTransaction): BridgeName[] {
  const found = new Set<BridgeName>();
  const programs = (tx.instructions ?? []).flatMap((ix) => [
    ix.programId,
    ...(ix.innerInstructions ?? []).map((inner) => inner.programId),
  ]);
  for (const program of programs) {
    if (program === WORMHOLE_CORE) continue;
    const bridge = BRIDGE_PROGRAMS[program];
    if (bridge) found.add(bridge);
  }
  // Core-only transactions are mostly guardian-signature verification; count them only when tokens move (NTT).
  if (programs.includes(WORMHOLE_CORE) && (tx.tokenTransfers?.length ?? 0) > 0) found.add("wormhole");
  return [...found];
}

export async function resolveBridgeTx(
  signature: string,
  bridges: BridgeName[],
): Promise<{ hops: BridgeHop[]; errors: string[] }> {
  const errors: string[] = [];
  const attempt = async (bridge: BridgeName, fn: () => Promise<BridgeHop[]>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return [];
      errors.push(`${bridge}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };

  const [mayan, debridge, wormhole] = await Promise.all([
    bridges.includes("mayan") ? attempt("mayan", () => resolveMayan(signature)) : [],
    bridges.includes("debridge") ? attempt("debridge", () => resolveDebridge(signature)) : [],
    bridges.includes("wormhole") ? attempt("wormhole", () => resolveWormhole(signature)) : [],
  ]);

  const hops = [...mayan, ...debridge, ...(mayan.length ? [] : wormhole)];
  return { hops, errors };
}

export async function detectBridgeTxs(
  api: HeliusApi,
  signatures: string[],
): Promise<Map<string, BridgeName[]>> {
  const unique = [...new Set(signatures)];
  const found = new Map<string, BridgeName[]>();
  for (let i = 0; i < unique.length; i += 100) {
    const parsed = await api.parseTransactions(unique.slice(i, i + 100), "confirmed");
    for (const tx of parsed) {
      const bridges = bridgesIn(tx);
      if (bridges.length) found.set(tx.signature, bridges);
    }
  }
  return found;
}

async function resolveWormhole(signature: string): Promise<BridgeHop[]> {
  const body = await getJson<{ operations?: WormholeOperation[] }>(
    `https://api.wormholescan.io/api/v1/operations?txHash=${signature}`,
    { ttlMs: TTL.asset },
  );
  return (body.operations ?? []).map((op) => normalizeWormhole(op, signature));
}

async function resolveDebridge(signature: string): Promise<BridgeHop[]> {
  const ids = await getJson<{ orderIds?: Array<{ stringValue?: string }> }>(
    `https://stats-api.dln.trade/api/Transaction/${signature}/orderIds`,
    { ttlMs: TTL.asset },
  );
  const orderIds = (ids.orderIds ?? []).map((o) => o.stringValue).filter(Boolean) as string[];
  const orders = await Promise.all(
    orderIds
      .slice(0, 5)
      .map((id) =>
        getJson<DlnOrder>(`https://stats-api.dln.trade/api/Orders/${id}`, { ttlMs: TTL.asset }),
      ),
  );
  return orders.map((order) => normalizeDebridge(order, signature));
}

async function resolveMayan(signature: string): Promise<BridgeHop[]> {
  const record = await getJson<MayanSwap>(
    `https://explorer-api.mayan.finance/v3/swap/trx/${signature}`,
    { ttlMs: TTL.asset },
  );
  return record?.sourceChain ? [normalizeMayan(record, signature)] : [];
}

export interface WormholeOperation {
  emitterChain?: number;
  content?: {
    standarizedProperties?: {
      fromChain?: number;
      fromAddress?: string;
      toChain?: number;
      toAddress?: string;
    };
  };
  sourceChain?: {
    chainId?: number;
    from?: string;
    status?: string;
    transaction?: { txHash?: string };
  };
  targetChain?: { chainId?: number; status?: string; transaction?: { txHash?: string } };
  data?: { symbol?: string; tokenAmount?: string; usdAmount?: string };
}

export function normalizeWormhole(op: WormholeOperation, signature: string): BridgeHop {
  const props = op.content?.standarizedProperties ?? {};
  const fromId = op.sourceChain?.chainId ?? props.fromChain ?? op.emitterChain ?? 0;
  const toId = op.targetChain?.chainId ?? props.toChain ?? 0;
  return {
    bridge: "wormhole",
    signature,
    direction: direction(fromId, toId, WORMHOLE_SOLANA),
    status:
      op.targetChain?.status ??
      (op.sourceChain?.status ? `source ${op.sourceChain.status}, not redeemed` : null),
    fromChain: chainName(WORMHOLE_CHAINS, fromId, "wormhole"),
    fromAddress: op.sourceChain?.from || props.fromAddress || null,
    toChain: chainName(WORMHOLE_CHAINS, toId, "wormhole"),
    toAddress: props.toAddress || null,
    sent: op.data ? { token: op.data.symbol ?? null, amount: maybeNum(op.data.tokenAmount) } : null,
    received: null,
    usd: maybeNum(op.data?.usdAmount, 2),
    sourceTx: op.sourceChain?.transaction?.txHash ?? null,
    destinationTx: op.targetChain?.transaction?.txHash ?? null,
    explorer: `https://wormholescan.io/#/tx/${signature}`,
  };
}

type Wrapped = { stringValue?: string } | string | number | null | undefined;

interface DlnOffer {
  chainId?: Wrapped;
  tokenAddress?: Wrapped;
  finalAmount?: Wrapped;
  amount?: Wrapped;
  decimals?: number;
  symbol?: string;
}

export interface DlnOrder {
  orderId?: Wrapped;
  makerSrc?: Wrapped;
  receiverDst?: Wrapped;
  state?: string;
  giveOfferWithMetadata?: DlnOffer;
  takeOfferWithMetadata?: DlnOffer;
  actualFulfillAmount?: Wrapped;
  createdSrcEventMetadata?: { transactionHash?: Wrapped } | null;
  fulfilledDstEventMetadata?: { transactionHash?: Wrapped } | null;
  preswapData?: {
    inTokenAddress?: string;
    inAmount?: Wrapped;
    tokenInMetadata?: { decimals?: number; symbol?: string };
  } | null;
}

export function normalizeDebridge(order: DlnOrder, signature: string): BridgeHop {
  const give = order.giveOfferWithMetadata ?? {};
  const take = order.takeOfferWithMetadata ?? {};
  const fromId = num(unwrap(give.chainId));
  const toId = num(unwrap(take.chainId));
  const preswap = order.preswapData;
  const sent = preswap?.inAmount
    ? {
        token: preswap.tokenInMetadata?.symbol ?? preswap.inTokenAddress ?? null,
        amount: scaled(unwrap(preswap.inAmount), preswap.tokenInMetadata?.decimals),
      }
    : {
        token: give.symbol ?? null,
        amount: scaled(unwrap(give.finalAmount ?? give.amount), give.decimals),
      };
  const orderId = unwrap(order.orderId);
  return {
    bridge: "debridge",
    signature,
    direction: direction(fromId, toId, DEBRIDGE_SOLANA),
    status: order.state ?? null,
    fromChain: chainName(DEBRIDGE_CHAINS, fromId, "debridge"),
    fromAddress: unwrap(order.makerSrc),
    toChain: chainName(DEBRIDGE_CHAINS, toId, "debridge"),
    toAddress: unwrap(order.receiverDst),
    sent,
    received: {
      token: take.symbol ?? null,
      amount: scaled(
        unwrap(order.actualFulfillAmount ?? take.finalAmount ?? take.amount),
        take.decimals,
      ),
    },
    usd: null,
    sourceTx: unwrap(order.createdSrcEventMetadata?.transactionHash),
    destinationTx: unwrap(order.fulfilledDstEventMetadata?.transactionHash),
    explorer: orderId
      ? `https://app.debridge.finance/order?orderId=${orderId}`
      : `https://app.debridge.finance/orders?s=${signature}`,
  };
}

export interface MayanSwap {
  sourceChain?: string;
  destChain?: string;
  trader?: string;
  destAddress?: string;
  status?: string;
  fromTokenSymbol?: string;
  fromAmount?: string;
  toTokenSymbol?: string;
  toAmount?: string;
  sourceTxHash?: string;
  fulfillTxHash?: string | null;
  redeemTxHash?: string | null;
}

export function normalizeMayan(record: MayanSwap, signature: string): BridgeHop {
  const fromId = num(record.sourceChain);
  const toId = num(record.destChain);
  return {
    bridge: "mayan",
    signature,
    direction: direction(fromId, toId, WORMHOLE_SOLANA),
    status: record.status ?? null,
    fromChain: chainName(WORMHOLE_CHAINS, fromId, "wormhole"),
    fromAddress: record.trader ?? null,
    toChain: chainName(WORMHOLE_CHAINS, toId, "wormhole"),
    toAddress: record.destAddress ?? null,
    sent: { token: record.fromTokenSymbol ?? null, amount: maybeNum(record.fromAmount) },
    received: { token: record.toTokenSymbol ?? null, amount: maybeNum(record.toAmount) },
    usd: null,
    sourceTx: record.sourceTxHash ?? null,
    destinationTx: record.fulfillTxHash ?? record.redeemTxHash ?? null,
    explorer: `https://explorer.mayan.finance/swap/${record.sourceTxHash ?? signature}`,
  };
}

function direction(fromId: number, toId: number, solana: number): BridgeHop["direction"] {
  if (fromId === solana && toId !== solana) return "out";
  if (toId === solana && fromId !== solana) return "in";
  return "unknown";
}

function chainName(map: Record<number, string>, id: number, family: string): string {
  return map[id] ?? `${family}-chain-${id}`;
}

function unwrap(value: Wrapped): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value.stringValue ?? null;
  return String(value);
}

function scaled(raw: string | null, decimals: number | undefined): number | null {
  if (raw === null) return null;
  return round(num(raw) / 10 ** (decimals ?? 0), 9);
}

function maybeNum(value: string | undefined | null, digits = 9): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round(n, digits) : null;
}
