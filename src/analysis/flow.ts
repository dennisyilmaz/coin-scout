import type { HeliusApi, Direction } from "../helius/api.js";
import { iso, round } from "../util/format.js";
import { BURN_ADDRESSES, labelOf } from "../util/programs.js";
import { detectBridgeTxs, resolveBridgeTx, type BridgeHop, type BridgeName } from "./bridges.js";
import { historicalPrices } from "./prices.js";
import { amountOf, fetchTransfers } from "./transfers.js";

const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
const MAX_BRIDGE_RESOLUTIONS = 12;
const MAX_PRICE_POINTS = 3_000;

export interface TraceOptions {
  root: string;
  direction: Exclude<Direction, "any">;
  hops: number;
  mint?: string;
  minAmount?: number;
  sinceTs?: number;
  perNodeTransfers: number;
  maxNodes: number;
  branchFactor: number;
  maxNodesShown: number;
  maxEdgesShown: number;
  usdAtTime: boolean;
  followBridges: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
  mint: string;
  amount: number;
  transfers: number;
  firstTs: number;
  lastTs: number;
  hop: number;
  sampleSig: string;
  maxSig: string;
  maxAmount: number;
  samples: Array<{ ts: number; amount: number }>;
  usdAtTime: number | null;
}

export async function traceFunds(api: HeliusApi, options: TraceOptions) {
  const edges = new Map<string, FlowEdge>();
  const visited = new Set<string>([options.root]);
  const hopOf = new Map<string, number>([[options.root, 0]]);
  const truncatedNodes: string[] = [];
  const bridgeSigs = new Map<string, BridgeName[]>();
  const bridgeTargets = new Map<string, Set<string>>();
  let frontier = [options.root];

  for (let hop = 1; hop <= options.hops; hop++) {
    if (frontier.length === 0) break;

    const results = await Promise.all(
      frontier.map((address) =>
        fetchTransfers(
          api,
          {
            address,
            direction: options.direction,
            mint: options.mint,
            sortOrder: "desc",
            filters: buildFilters(options),
          },
          options.perNodeTransfers,
          Math.ceil(options.perNodeTransfers / 100),
        )
          .then((page) => ({ address, page }))
          .catch(() => null),
      ),
    );

    const nextCandidates = new Map<string, { amount: number; sig: string; best: number }>();
    const burnSigs: string[] = [];

    for (const result of results) {
      if (!result) continue;
      const { address, page } = result;
      if (page.truncated) truncatedNodes.push(address);

      for (const transfer of page.transfers) {
        const forward = options.direction === "out";
        const from = forward ? address : transfer.fromUserAccount;
        const to = forward
          ? (transfer.toUserAccount ?? (transfer.type === "burn" ? INCINERATOR : null))
          : address;
        const other = forward ? to : from;
        if (!from || !to || !other || other === address) continue;

        const amount = amountOf(transfer);
        if (options.minAmount && amount < options.minAmount) continue;

        const key = `${from}|${to}|${transfer.mint}`;
        const edge = edges.get(key);
        if (edge) {
          edge.amount = round(edge.amount + amount, 9);
          edge.transfers++;
          edge.firstTs = Math.min(edge.firstTs, transfer.blockTime);
          edge.lastTs = Math.max(edge.lastTs, transfer.blockTime);
          edge.samples.push({ ts: transfer.blockTime, amount });
          if (amount > edge.maxAmount) {
            edge.maxAmount = amount;
            edge.maxSig = transfer.signature;
          }
        } else {
          edges.set(key, {
            from,
            to,
            mint: transfer.mint,
            amount: round(amount, 9),
            transfers: 1,
            firstTs: transfer.blockTime,
            lastTs: transfer.blockTime,
            hop,
            sampleSig: transfer.signature,
            maxSig: transfer.signature,
            maxAmount: amount,
            samples: [{ ts: transfer.blockTime, amount }],
            usdAtTime: null,
          });
        }

        if (BURN_ADDRESSES.has(other)) {
          burnSigs.push(transfer.signature);
        } else if (!visited.has(other)) {
          const candidate = nextCandidates.get(other) ?? { amount: 0, sig: transfer.signature, best: 0 };
          candidate.amount += amount;
          if (amount > candidate.best) {
            candidate.best = amount;
            candidate.sig = transfer.signature;
          }
          nextCandidates.set(other, candidate);
        }
      }
    }

    let pool = [...nextCandidates.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, options.branchFactor * 2);

    if (options.followBridges && (pool.length || burnSigs.length)) {
      const found = await detectBridgeTxs(api, [
        ...pool.map(([, c]) => c.sig),
        ...burnSigs.slice(0, 20),
      ]).catch(() => new Map<string, BridgeName[]>());
      for (const [sig, bridges] of found) bridgeSigs.set(sig, bridges);
      const target = (sig: string, address: string) => {
        const set = bridgeTargets.get(sig) ?? new Set<string>();
        set.add(address);
        bridgeTargets.set(sig, set);
      };
      for (const [address, c] of pool) if (found.has(c.sig)) target(c.sig, address);
      for (const sig of burnSigs) if (found.has(sig)) target(sig, INCINERATOR);
      pool = pool.filter(([, c]) => !found.has(c.sig));
    }

    frontier = pool
      .slice(0, options.branchFactor)
      .map(([address]) => address)
      .filter((address) => {
        if (visited.size >= options.maxNodes) return false;
        visited.add(address);
        hopOf.set(address, hop);
        return true;
      });
  }

  const edgeList = [...edges.values()];
  const [priceNote, crossings] = await Promise.all([
    options.usdAtTime ? priceEdges(edgeList) : Promise.resolve(null),
    resolveCrossings(bridgeSigs, bridgeTargets, edgeList, options.direction === "out"),
  ]);
  const nodes = buildNodes(edgeList, hopOf, options.root);
  const priced = options.usdAtTime && edgeList.some((e) => e.usdAtTime !== null);
  const value = (e: FlowEdge) => (priced ? (e.usdAtTime ?? -1) : e.amount);
  const shownEdges = withPathsToRoot(
    [...edgeList].sort((a, b) => value(b) - value(a) || b.amount - a.amount),
    options.maxEdgesShown,
    options.root,
    options.direction === "out",
  );

  return {
    root: options.root,
    direction: options.direction,
    hopsRequested: options.hops,
    mint: options.mint ?? "any",
    nodeCount: nodes.length,
    edgeCount: edgeList.length,
    reachedNodeCap: visited.size >= options.maxNodes,
    truncatedNodes: truncatedNodes.slice(0, 20),
    totalUsdAtTime: priced
      ? round(
          edgeList.filter((e) => e.hop === 1).reduce((acc, e) => acc + (e.usdAtTime ?? 0), 0),
          2,
        )
      : null,
    priceNote,
    bridgeCrossings: crossings.resolved,
    unresolvedBridgeTxs: crossings.unresolved,
    terminals: nodes
      .filter((n) => n.outEdges === 0 && n.address !== options.root)
      .sort((a, b) => (priced ? (b.receivedUsd ?? -1) - (a.receivedUsd ?? -1) : b.received - a.received))
      .slice(0, 20),
    cycles: findCycles(edgeList, options.root),
    nodesShown: Math.min(nodes.length, options.maxNodesShown),
    edgesShown: shownEdges.length,
    nodes: nodes.slice(0, options.maxNodesShown),
    edges: shownEdges.map((e) => ({
        from: e.from,
        to: e.to,
        mint: e.mint,
        amount: e.amount,
        usdAtTime: options.usdAtTime ? e.usdAtTime : undefined,
        transfers: e.transfers,
        hop: e.hop,
        firstAt: iso(e.firstTs),
        lastAt: iso(e.lastTs),
        sampleSig: e.sampleSig,
      })),
  };
}

export function withPathsToRoot(
  ranked: FlowEdge[],
  limit: number,
  root: string,
  forward: boolean,
): FlowEdge[] {
  const toward = new Map<string, FlowEdge>();
  for (const edge of ranked) {
    const node = forward ? edge.to : edge.from;
    const best = toward.get(node);
    if (!best || edge.hop < best.hop) toward.set(node, edge);
  }

  const picked = new Set(ranked.slice(0, limit));
  for (const edge of ranked.slice(0, limit)) {
    const seen = new Set<string>();
    let node = forward ? edge.from : edge.to;
    while (node !== root && !seen.has(node)) {
      seen.add(node);
      const step = toward.get(node);
      if (!step) break;
      picked.add(step);
      node = forward ? step.from : step.to;
    }
  }
  return ranked.filter((edge) => picked.has(edge));
}

async function priceEdges(edges: FlowEdge[]): Promise<string | null> {
  const points = edges.flatMap((e) => e.samples.map((s) => ({ mint: e.mint, ts: s.ts })));
  if (points.length > MAX_PRICE_POINTS) {
    return `Skipped USD pricing: ${points.length} transfers exceeds ${MAX_PRICE_POINTS}. Narrow with mint, minAmount or sinceUnix.`;
  }
  const book = await historicalPrices(points);
  for (const edge of edges) {
    let total = 0;
    let any = false;
    for (const sample of edge.samples) {
      const usd = book.usd(edge.mint, sample.ts, sample.amount);
      if (usd !== null) {
        total += usd;
        any = true;
      }
    }
    edge.usdAtTime = any ? round(total, 2) : null;
  }
  return book.errors[0] ?? null;
}

async function resolveCrossings(
  bridgeSigs: Map<string, BridgeName[]>,
  targets: Map<string, Set<string>>,
  edges: FlowEdge[],
  forward: boolean,
) {
  const resolved: Array<BridgeHop & { via: { from: string; to: string; mint: string; amount: number } }> = [];
  const unresolved: Array<{ signature: string; bridges: BridgeName[]; reason: string }> = [];
  const entries = [...bridgeSigs.entries()];

  await Promise.all(
    entries.slice(0, MAX_BRIDGE_RESOLUTIONS).map(async ([signature, bridges]) => {
      const inTx = edges.filter((e) => e.maxSig === signature || e.sampleSig === signature);
      const wanted = targets.get(signature);
      const isTarget = (e: FlowEdge) => (wanted?.has(forward ? e.to : e.from) ? 1 : 0);
      const edge = inTx.sort((a, b) => isTarget(b) - isTarget(a) || b.amount - a.amount)[0];
      const via = edge
        ? { from: edge.from, to: edge.to, mint: edge.mint, amount: edge.amount }
        : { from: "", to: "", mint: "", amount: 0 };
      const { hops, errors } = await resolveBridgeTx(signature, bridges);
      if (hops.length === 0) {
        unresolved.push({ signature, bridges, reason: errors[0] ?? "bridge API has no record of this transaction" });
      }
      for (const hop of hops) resolved.push({ ...hop, via });
    }),
  );
  for (const [signature, bridges] of entries.slice(MAX_BRIDGE_RESOLUTIONS)) {
    unresolved.push({ signature, bridges, reason: "not resolved: crossing cap reached, use follow_bridge" });
  }
  return { resolved, unresolved };
}

interface FlowNode {
  address: string;
  label: string | null;
  hop: number;
  sent: number;
  received: number;
  sentUsd: number | null;
  receivedUsd: number | null;
  inEdges: number;
  outEdges: number;
}

function buildNodes(
  edges: FlowEdge[],
  hopOf: Map<string, number>,
  root: string,
): FlowNode[] {
  const map = new Map<string, FlowNode>();

  const ensure = (address: string): FlowNode => {
    let node = map.get(address);
    if (!node) {
      node = {
        address,
        label: labelOf(address) ?? null,
        hop: hopOf.get(address) ?? -1,
        sent: 0,
        received: 0,
        sentUsd: null,
        receivedUsd: null,
        inEdges: 0,
        outEdges: 0,
      };
      map.set(address, node);
    }
    return node;
  };

  ensure(root);
  for (const edge of edges) {
    const from = ensure(edge.from);
    const to = ensure(edge.to);
    if (to.hop === -1) to.hop = edge.hop;
    if (from.hop === -1) from.hop = edge.hop;
    from.sent = round(from.sent + edge.amount, 9);
    from.outEdges++;
    to.received = round(to.received + edge.amount, 9);
    to.inEdges++;
    if (edge.usdAtTime !== null) {
      from.sentUsd = round((from.sentUsd ?? 0) + edge.usdAtTime, 2);
      to.receivedUsd = round((to.receivedUsd ?? 0) + edge.usdAtTime, 2);
    }
  }

  return [...map.values()].sort((a, b) => a.hop - b.hop || b.received - a.received);
}

function findCycles(edges: FlowEdge[], root: string): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }

  const cycles: string[][] = [];
  const path: string[] = [];
  const onPath = new Set<string>();
  const seen = new Set<string>();
  let steps = 0;

  const walk = (node: string, depth: number): void => {
    if (cycles.length >= 20 || depth > 8 || ++steps > 50_000) return;
    path.push(node);
    onPath.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (onPath.has(next)) {
        const start = path.indexOf(next);
        const cycle = [...path.slice(start), next];
        const key = cycle.join(">");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else {
        walk(next, depth + 1);
      }
    }

    path.pop();
    onPath.delete(node);
  };

  walk(root, 0);
  for (const start of adjacency.keys()) {
    if (cycles.length >= 20) break;
    if (start !== root) walk(start, 0);
  }
  return cycles;
}

function buildFilters(options: TraceOptions) {
  return options.sinceTs ? { blockTime: { gte: options.sinceTs } } : undefined;
}
