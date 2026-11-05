import { historicalPrices } from "../analysis/prices.js";
import { iso, round } from "../util/format.js";
import { HttpError, getJson } from "../util/http.js";

export interface EvmChain {
  name: string;
  chainId: number;
  llama: string;
  native: { symbol: string; coingecko: string };
  explorer: string;
  blockscout?: string;
  aliases: string[];
}

export const EVM_CHAINS: EvmChain[] = [
  { name: "Ethereum", chainId: 1, llama: "ethereum", native: { symbol: "ETH", coingecko: "ethereum" }, explorer: "https://etherscan.io", blockscout: "eth.blockscout.com", aliases: ["eth", "mainnet"] },
  { name: "BNB Chain", chainId: 56, llama: "bsc", native: { symbol: "BNB", coingecko: "binancecoin" }, explorer: "https://bscscan.com", aliases: ["bsc", "bnb"] },
  { name: "Polygon", chainId: 137, llama: "polygon", native: { symbol: "POL", coingecko: "polygon-ecosystem-token" }, explorer: "https://polygonscan.com", aliases: ["matic", "pol"] },
  { name: "Avalanche", chainId: 43114, llama: "avax", native: { symbol: "AVAX", coingecko: "avalanche-2" }, explorer: "https://snowtrace.io", aliases: ["avax"] },
  { name: "Arbitrum", chainId: 42161, llama: "arbitrum", native: { symbol: "ETH", coingecko: "ethereum" }, explorer: "https://arbiscan.io", aliases: ["arb", "arbitrum one"] },
  { name: "Optimism", chainId: 10, llama: "optimism", native: { symbol: "ETH", coingecko: "ethereum" }, explorer: "https://optimistic.etherscan.io", aliases: ["op"] },
  { name: "Base", chainId: 8453, llama: "base", native: { symbol: "ETH", coingecko: "ethereum" }, explorer: "https://basescan.org", aliases: [] },
  { name: "Fantom", chainId: 250, llama: "fantom", native: { symbol: "FTM", coingecko: "fantom" }, explorer: "https://ftmscan.com", aliases: ["ftm"] },
  { name: "Celo", chainId: 42220, llama: "celo", native: { symbol: "CELO", coingecko: "celo" }, explorer: "https://celoscan.io", aliases: [] },
  { name: "Moonbeam", chainId: 1284, llama: "moonbeam", native: { symbol: "GLMR", coingecko: "moonbeam" }, explorer: "https://moonscan.io", aliases: [] },
  { name: "Scroll", chainId: 534352, llama: "scroll", native: { symbol: "ETH", coingecko: "ethereum" }, explorer: "https://scrollscan.com", aliases: [] },
  { name: "Mantle", chainId: 5000, llama: "mantle", native: { symbol: "MNT", coingecko: "mantle" }, explorer: "https://mantlescan.xyz", aliases: [] },
  { name: "Linea", chainId: 59144, llama: "linea", native: { symbol: "ETH", coingecko: "ethereum" }, explorer: "https://lineascan.build", aliases: [] },
];

export function evmChain(name: string | number): EvmChain | undefined {
  const key = String(name).trim().toLowerCase();
  return EVM_CHAINS.find(
    (c) => c.name.toLowerCase() === key || String(c.chainId) === key || c.aliases.includes(key),
  );
}

export function isEvmAddress(address: string | null | undefined): address is string {
  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address);
}

export interface EvmTransfer {
  hash: string;
  ts: number;
  from: string;
  to: string;
  token: string | null;
  symbol: string;
  amount: number;
}

export class EvmProviderError extends Error {}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface EtherscanReply<T> {
  status: string;
  message: string;
  result: T[] | string;
}

interface EtherscanTokenTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  tokenDecimal: string;
  tokenSymbol: string;
  contractAddress: string;
}

interface EtherscanTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError: string;
}

export function parseEtherscan<T>(reply: EtherscanReply<T>): T[] {
  if (Array.isArray(reply.result)) return reply.result;
  if (reply.message === "No transactions found") return [];
  throw new EvmProviderError(`Etherscan: ${reply.result || reply.message}`);
}

function scaled(raw: string, decimals: number): number {
  if (!/^\d+$/.test(raw)) return 0;
  const digits = raw.padStart(decimals + 1, "0");
  return Number(`${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals) || "0"}`);
}

export function fromEtherscan(address: string, tokens: EtherscanTokenTx[], txs: EtherscanTx[], native: string): EvmTransfer[] {
  const self = address.toLowerCase();
  return [
    ...tokens
      .filter((t) => t.from.toLowerCase() === self && t.to)
      .map((t) => ({
        hash: t.hash,
        ts: Number(t.timeStamp),
        from: t.from.toLowerCase(),
        to: t.to.toLowerCase(),
        token: t.contractAddress.toLowerCase(),
        symbol: t.tokenSymbol,
        amount: scaled(t.value, Number(t.tokenDecimal) || 0),
      })),
    ...txs
      .filter((t) => t.from.toLowerCase() === self && t.to && t.isError === "0" && t.value !== "0")
      .map((t) => ({
        hash: t.hash,
        ts: Number(t.timeStamp),
        from: t.from.toLowerCase(),
        to: t.to.toLowerCase(),
        token: null,
        symbol: native,
        amount: scaled(t.value, 18),
      })),
  ];
}

interface BlockscoutAddress {
  hash: string;
  is_contract?: boolean;
  proxy_type?: string | null;
  name?: string | null;
  metadata?: { tags?: Array<{ name: string; tagType: string }> } | null;
}

interface BlockscoutTokenTransfer {
  transaction_hash: string;
  timestamp: string;
  from: BlockscoutAddress;
  to: BlockscoutAddress | null;
  token: { address_hash?: string; address?: string; symbol?: string; reputation?: string };
  total: { decimals?: string; value?: string } | null;
}

interface BlockscoutTx {
  hash: string;
  timestamp: string;
  from: BlockscoutAddress;
  to: BlockscoutAddress | null;
  value: string;
  status?: string;
}

function isBlockscoutContract(address: BlockscoutAddress | null | undefined): boolean {
  return Boolean(address?.is_contract) && address?.proxy_type !== "eip7702";
}

export function blockscoutLabel(address: BlockscoutAddress | null | undefined): string | null {
  const tag = address?.metadata?.tags?.find((t) => t.tagType === "name") ?? address?.metadata?.tags?.[0];
  if (tag?.name) return tag.name;
  if (isBlockscoutContract(address)) return address?.name ? `contract: ${address.name}` : "contract";
  return null;
}

export function fromBlockscout(
  address: string,
  tokens: BlockscoutTokenTransfer[],
  txs: BlockscoutTx[],
  native: string,
  labels: Map<string, string>,
): EvmTransfer[] {
  const self = address.toLowerCase();
  const note = (a: BlockscoutAddress | null) => {
    const label = blockscoutLabel(a);
    if (a?.hash && label) labels.set(a.hash.toLowerCase(), label);
  };
  const out: EvmTransfer[] = [];
  for (const t of tokens) {
    note(t.to);
    if (t.from.hash.toLowerCase() !== self || !t.to?.hash || t.token.reputation === "scam") continue;
    out.push({
      hash: t.transaction_hash,
      ts: Math.floor(Date.parse(t.timestamp) / 1000),
      from: self,
      to: t.to.hash.toLowerCase(),
      token: (t.token.address_hash ?? t.token.address ?? "").toLowerCase() || null,
      symbol: t.token.symbol ?? "?",
      amount: scaled(t.total?.value ?? "0", Number(t.total?.decimals) || 0),
    });
  }
  for (const t of txs) {
    note(t.to);
    if (t.from.hash.toLowerCase() !== self || !t.to?.hash || t.status !== "ok" || t.value === "0") continue;
    out.push({
      hash: t.hash,
      ts: Math.floor(Date.parse(t.timestamp) / 1000),
      from: self,
      to: t.to.hash.toLowerCase(),
      token: null,
      symbol: native,
      amount: scaled(t.value, 18),
    });
  }
  return out;
}

let etherscanQueue: Promise<unknown> = Promise.resolve();

function etherscanGet<T>(chain: EvmChain, key: string, params: Record<string, string>, ttlMs: number): Promise<T> {
  const query = new URLSearchParams({ chainid: String(chain.chainId), ...params, apikey: key });
  const run = etherscanQueue.then(async () => {
    try {
      return await getJson<T>(`https://api.etherscan.io/v2/api?${query}`, { ttlMs });
    } catch (error) {
      if (error instanceof HttpError) throw new EvmProviderError(`Etherscan HTTP ${error.status}`);
      throw error;
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  });
  etherscanQueue = run.catch(() => {});
  return run;
}

export interface EvmSource {
  name: "etherscan" | "blockscout";
  outgoing(address: string, sinceTs?: number): Promise<EvmTransfer[]>;
  isContract(address: string): Promise<boolean>;
  labels: Map<string, string>;
}

export function evmSource(chain: EvmChain, etherscanKey: string | null): EvmSource {
  const labels = new Map<string, string>();
  if (etherscanKey) {
    const key = etherscanKey;
    return {
      name: "etherscan",
      labels,
      async outgoing(address, sinceTs) {
        const base = { module: "account", address, page: "1", offset: "100", sort: "desc" };
        const [tokens, txs] = await Promise.all([
          etherscanGet<EtherscanReply<EtherscanTokenTx>>(chain, key, { ...base, action: "tokentx" }, 30_000).then(parseEtherscan),
          etherscanGet<EtherscanReply<EtherscanTx>>(chain, key, { ...base, action: "txlist" }, 30_000).then(parseEtherscan),
        ]);
        return fromEtherscan(address, tokens, txs, chain.native.symbol).filter((t) => !sinceTs || t.ts >= sinceTs);
      },
      async isContract(address) {
        const code = await etherscanGet<{ result?: string }>(
          chain,
          key,
          { module: "proxy", action: "eth_getCode", address, tag: "latest" },
          3_600_000,
        ).catch(() => ({ result: undefined }));
        return typeof code.result === "string" && /^0x[0-9a-f]{2,}/i.test(code.result) && !code.result.startsWith("0xef0100");
      },
    };
  }
  if (!chain.blockscout) {
    throw new EvmProviderError(
      `Tracing on ${chain.name} needs ETHERSCAN_API_KEY (free at https://etherscan.io/apis). Without a key only Ethereum is supported, through Blockscout.`,
    );
  }
  const host = chain.blockscout;
  const contracts = new Set<string>();
  return {
    name: "blockscout",
    labels,
    async outgoing(address, sinceTs) {
      const base = `https://${host}/api/v2/addresses/${address}`;
      const get = <T>(path: string) =>
        getJson<{ items?: T[] }>(`${base}/${path}`, { ttlMs: 30_000 }).catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 404) return { items: [] as T[] };
          throw new EvmProviderError(`Blockscout: ${error instanceof Error ? error.message : String(error)}`);
        });
      const [tokens, txs] = await Promise.all([
        get<BlockscoutTokenTransfer>("token-transfers?type=ERC-20&filter=from"),
        get<BlockscoutTx>("transactions?filter=from"),
      ]);
      for (const t of [...(tokens.items ?? []), ...(txs.items ?? [])]) {
        if (t.to && isBlockscoutContract(t.to)) contracts.add(t.to.hash.toLowerCase());
      }
      return fromBlockscout(address, tokens.items ?? [], txs.items ?? [], chain.native.symbol, labels).filter(
        (t) => !sinceTs || t.ts >= sinceTs,
      );
    },
    async isContract(address) {
      return contracts.has(address.toLowerCase());
    },
  };
}

interface EvmEdge {
  from: string;
  to: string;
  token: string | null;
  symbol: string;
  amount: number;
  usd: number | null;
  transfers: number;
  hop: number;
  firstTs: number;
  lastTs: number;
  sampleTx: string;
  samples: Array<{ ts: number; amount: number }>;
}

export function priceKeyFor(chain: EvmChain, token: string | null): string {
  return token ? `${chain.llama}:${token}` : `coingecko:${chain.native.coingecko}`;
}

export async function traceEvm(
  options: {
    chain: EvmChain;
    address: string;
    hops: number;
    branchFactor: number;
    sinceTs?: number;
    etherscanKey: string | null;
  },
) {
  const { chain } = options;
  const root = options.address.toLowerCase();
  const source = evmSource(chain, options.etherscanKey);
  const edges = new Map<string, EvmEdge>();
  const visited = new Set([root]);
  const notes: string[] = [];
  const stoppedAt = new Map<string, string>();
  let frontier = [root];

  for (let hop = 1; hop <= options.hops && frontier.length; hop++) {
    const pages = await Promise.all(
      frontier.map((address) =>
        source.outgoing(address, options.sinceTs).catch((error: unknown) => {
          if (hop === 1) throw error;
          notes.push(`${address}: ${error instanceof Error ? error.message : String(error)}`);
          return [] as EvmTransfer[];
        }),
      ),
    );
    const hopEdges: EvmEdge[] = [];
    for (const transfer of pages.flat()) {
      if (transfer.to === transfer.from || transfer.to === ZERO_ADDRESS || transfer.amount <= 0) continue;
      const key = `${transfer.from}|${transfer.to}|${transfer.token ?? "native"}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = {
          from: transfer.from,
          to: transfer.to,
          token: transfer.token,
          symbol: transfer.symbol,
          amount: 0,
          usd: null,
          transfers: 0,
          hop,
          firstTs: transfer.ts,
          lastTs: transfer.ts,
          sampleTx: transfer.hash,
          samples: [],
        };
        edges.set(key, edge);
        hopEdges.push(edge);
      }
      edge.amount = round(edge.amount + transfer.amount, 9);
      edge.transfers++;
      edge.firstTs = Math.min(edge.firstTs, transfer.ts);
      edge.lastTs = Math.max(edge.lastTs, transfer.ts);
      edge.samples.push({ ts: transfer.ts, amount: transfer.amount });
    }

    const book = await historicalPrices(
      hopEdges.flatMap((e) => e.samples.map((s) => ({ mint: priceKeyFor(chain, e.token), ts: s.ts }))),
    );
    if (book.errors[0]) notes.push(book.errors[0]);
    for (const edge of hopEdges) {
      const values = edge.samples.map((s) => book.usd(priceKeyFor(chain, edge.token), s.ts, s.amount));
      edge.usd = values.some((v) => v !== null) ? round(values.reduce<number>((acc, v) => acc + (v ?? 0), 0), 2) : null;
    }

    const value = new Map<string, number>();
    for (const edge of hopEdges) value.set(edge.to, (value.get(edge.to) ?? 0) + (edge.usd ?? 0));
    const ranked = [...value.entries()]
      .filter(([address, usd]) => !visited.has(address) && usd > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.branchFactor * 2);

    const next: string[] = [];
    for (const [address] of ranked) {
      if (next.length >= options.branchFactor) break;
      visited.add(address);
      const label = source.labels.get(address);
      if (label || (await source.isContract(address))) {
        stoppedAt.set(address, label ?? "contract");
        continue;
      }
      next.push(address);
    }
    frontier = next;
  }

  const edgeList = [...edges.values()].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const sent = new Set(edgeList.map((e) => e.from));
  const received = new Map<string, number>();
  for (const e of edgeList) received.set(e.to, (received.get(e.to) ?? 0) + (e.usd ?? 0));
  const terminals = [...received.entries()]
    .filter(([address]) => !sent.has(address))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([address, usd]) => ({
      address,
      receivedUsd: round(usd, 2),
      label: source.labels.get(address) ?? stoppedAt.get(address) ?? null,
      explorer: `${chain.explorer}/address/${address}`,
    }));

  return {
    chain: chain.name,
    chainId: chain.chainId,
    source: source.name,
    root,
    hops: options.hops,
    edgeCount: edgeList.length,
    totalUsdOut: round(
      edgeList.filter((e) => e.hop === 1).reduce((acc, e) => acc + (e.usd ?? 0), 0),
      2,
    ),
    terminals,
    edges: edgeList.slice(0, 60).map(({ samples, ...e }) => ({
      ...e,
      firstAt: iso(e.firstTs),
      lastAt: iso(e.lastTs),
      explorer: `${chain.explorer}/tx/${e.sampleTx}`,
    })),
    notes: [
      ...notes,
      `Only the most recent outgoing transfers per address are read (${source.name === "blockscout" ? "50 token and 50 native" : "100 token and 100 native"})${options.sinceTs ? `, from ${iso(options.sinceTs)} on` : ""}. Only recipients with a USD value are expanded; contracts and labelled addresses are not.`,
    ],
  };
}

export async function traceDestinations(
  crossings: Array<{ direction: string; toChain: string; toAddress: string | null; via?: { ts: number | null } }>,
  etherscanKey: string | null,
  limit = 3,
) {
  const targets = new Map<string, { chain: EvmChain; address: string; sinceTs?: number }>();
  const skipped: string[] = [];
  for (const crossing of crossings) {
    const chain = evmChain(crossing.toChain);
    if (crossing.direction !== "out" || !chain || !isEvmAddress(crossing.toAddress)) continue;
    const key = `${chain.name}:${crossing.toAddress.toLowerCase()}`;
    if (targets.has(key)) continue;
    if (targets.size >= limit) skipped.push(key);
    else targets.set(key, { chain, address: crossing.toAddress, sinceTs: crossing.via?.ts ? crossing.via.ts - 3_600 : undefined });
  }
  const traces = await Promise.all(
    [...targets.values()].map(({ chain, address, sinceTs }) =>
      traceEvm({ chain, address, hops: 2, branchFactor: 3, sinceTs, etherscanKey }).catch((error: unknown) => ({
        chain: chain.name,
        root: address.toLowerCase(),
        error: error instanceof Error ? error.message : String(error),
      })),
    ),
  );
  return { traces, skipped };
}
