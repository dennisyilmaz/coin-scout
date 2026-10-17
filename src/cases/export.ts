import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOL_ALIASES } from "../analysis/prices.js";
import type { BridgeHop } from "../analysis/bridges.js";
import { caseDir, type CaseArtifact, type CaseFile } from "./store.js";
import { renderMermaid, renderSvg, shortAddress, type Graph, type GraphNode } from "./diagram.js";

const MAX_DIAGRAM_NODES = 40;

interface TraceNode {
  address: string;
  label: string | null;
  sent: number;
  received: number;
  receivedUsd?: number | null;
  outEdges: number;
  inEdges: number;
}

interface TraceEdge {
  from: string;
  to: string;
  mint: string;
  amount: number;
  usdAtTime?: number | null;
  transfers: number;
  sampleSig: string;
}

type Crossing = BridgeHop & { via: { from: string; to: string; mint: string; amount: number } };

interface TraceData {
  root: string;
  direction: "out" | "in";
  hopsRequested: number;
  nodes: TraceNode[];
  edges: TraceEdge[];
  terminals?: TraceNode[];
  bridgeCrossings?: Crossing[];
  mintSymbols?: Record<string, string>;
  totalUsdAtTime?: number | null;
}

interface ClusterData {
  seed: string;
  members: Array<{
    address: string;
    label: string | null;
    score: number;
    tier: string;
    signals: Array<{ type: string; detail: string; evidence: string[] }>;
  }>;
}

interface BridgeData {
  crossings: BridgeHop[];
}

export function exportCase(c: CaseFile, artifactId?: string) {
  const dir = caseDir(c.name);
  mkdirSync(dir, { recursive: true });
  const diagrams: string[] = [];
  const md: string[] = [
    `# Case: ${c.name}`,
    "",
    c.summary || "_No summary yet._",
    "",
    `_Updated ${c.updatedAt}_`,
    "",
  ];

  const labels = Object.entries(c.labels);
  if (labels.length) {
    md.push("## Labels", "", "| Address | Label | Confidence | Evidence |", "|---|---|---|---|");
    for (const [address, entry] of labels) {
      md.push(
        `| \`${address}\` | ${cell(entry.label)} | ${entry.confidence} | ${entry.evidence.map((e) => `\`${shortAddress(e)}\``).join(" ")} |`,
      );
    }
    md.push("");
  }

  if (c.notes.length) {
    md.push("## Notes", "");
    for (const note of c.notes)
      md.push(`- **${note.at.slice(0, 16).replace("T", " ")}** — ${note.text}`);
    md.push("");
  }

  const artifacts = c.artifacts.filter((a) => !artifactId || a.id === artifactId);
  if (artifactId && artifacts.length === 0)
    throw new Error(`No artifact ${artifactId} in case ${c.name}`);

  for (const artifact of artifacts) {
    md.push(`## ${artifact.title}`, "", `_${artifact.kind} · ${artifact.id} · ${artifact.at}_`, "");
    const graph = artifactGraph(artifact, c);
    if (graph) {
      const file = `${artifact.id}.svg`;
      writeFileSync(join(dir, file), renderSvg(graph));
      diagrams.push(join(dir, file));
      md.push(`![${artifact.title}](${file})`, "", "```mermaid", renderMermaid(graph), "```", "");
    }
    md.push(...artifactTables(artifact));
  }

  const report = join(dir, "report.md");
  writeFileSync(report, md.join("\n"));
  return { directory: dir, report, diagrams };
}

function artifactGraph(artifact: CaseArtifact, c: CaseFile): Graph | null {
  if (artifact.kind === "trace") return traceGraph(artifact.data as TraceData, artifact.title, c);
  if (artifact.kind === "cluster")
    return clusterGraph(artifact.data as ClusterData, artifact.title, c);
  return null;
}

export function traceGraph(data: TraceData, title: string, c: CaseFile): Graph {
  const forward = data.direction !== "in";
  const priced = data.edges.some((e) => e.usdAtTime != null);
  const weightOf = (e: TraceEdge) => (priced ? (e.usdAtTime ?? 0) : e.amount);
  const ranked = [...data.edges].sort((a, b) => weightOf(b) - weightOf(a));
  const keep = new Set<string>([data.root]);
  for (let grew = true; grew && keep.size < MAX_DIAGRAM_NODES;) {
    grew = false;
    for (const e of ranked) {
      if (keep.size >= MAX_DIAGRAM_NODES) break;
      if (keep.has(e.from) !== keep.has(e.to)) {
        keep.add(keep.has(e.from) ? e.to : e.from);
        grew = true;
      }
    }
  }
  const edges = data.edges.filter((e) => keep.has(e.from) && keep.has(e.to));

  const depth = new Map<string, number>([[data.root, 0]]);
  let frontier = [data.root];
  while (frontier.length) {
    const next: string[] = [];
    for (const address of frontier) {
      for (const edge of edges) {
        const [here, there] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
        if (here === address && !depth.has(there)) {
          depth.set(there, depth.get(address)! + 1);
          next.push(there);
        }
      }
    }
    frontier = next;
  }
  const maxDepth = Math.max(0, ...depth.values());
  const columnOf = (address: string) => {
    const d = depth.get(address) ?? maxDepth + 1;
    return forward ? d : maxDepth - d;
  };

  const bridgeAccounts = new Set(
    (data.bridgeCrossings ?? []).map((x) => (forward ? x.via.to : x.via.from)),
  );
  const info = new Map(data.nodes.map((n) => [n.address, n]));
  const senders = new Set(data.edges.map((e) => e.from));
  const receivers = new Set(data.edges.map((e) => e.to));
  const nodeWeight = new Map<string, number>();
  for (const e of edges) {
    for (const address of [e.from, e.to]) {
      nodeWeight.set(address, (nodeWeight.get(address) ?? 0) + weightOf(e));
    }
  }
  const nodes: GraphNode[] = [...keep].map((address) => {
    const label =
      c.labels[address]?.label ??
      info.get(address)?.label?.replace(/ \[case: [^\]]+\]$/, "") ??
      null;
    const terminal = forward ? !senders.has(address) : !receivers.has(address);
    const kind: GraphNode["kind"] =
      address === data.root
        ? "root"
        : bridgeAccounts.has(address)
          ? "bridge"
          : label
            ? "labeled"
            : terminal
              ? "alert"
              : "plain";
    return {
      id: address,
      title: label ?? shortAddress(address),
      subtitle: label ? shortAddress(address) : undefined,
      column: columnOf(address),
      weight: nodeWeight.get(address) ?? 0,
      kind,
    };
  });

  const graphEdges = edges.map((e) => ({
    from: e.from,
    to: e.to,
    label: amountLabel(e.amount, e.mint, data.mintSymbols, e.usdAtTime),
    weight: weightOf(e),
  }));

  for (const crossing of data.bridgeCrossings ?? []) {
    const anchor = forward ? crossing.via.to : crossing.via.from;
    if (!keep.has(anchor)) continue;
    const id = `bridge:${crossing.signature}:${crossing.bridge}`;
    const other = forward ? crossing.toChain : crossing.fromChain;
    const otherAddress = forward ? crossing.toAddress : crossing.fromAddress;
    nodes.push({
      id,
      title: `${crossing.bridge} ${forward ? "→" : "←"} ${other}`,
      subtitle: otherAddress ? shortAddress(otherAddress) : undefined,
      column: columnOf(anchor) + (forward ? 1 : -1),
      weight: crossing.usd ?? crossing.via.amount,
      kind: "bridge",
    });
    const sent = crossing.sent?.amount
      ? `${fmt(crossing.sent.amount)} ${crossing.sent.token ?? ""}`.trim()
      : "";
    graphEdges.push(
      forward
        ? { from: anchor, to: id, label: sent, weight: crossing.usd ?? crossing.via.amount }
        : { from: id, to: anchor, label: sent, weight: crossing.usd ?? crossing.via.amount },
    );
  }

  return { title, nodes, edges: graphEdges };
}

function clusterGraph(data: ClusterData, title: string, c: CaseFile): Graph {
  const seedLabel = c.labels[data.seed]?.label;
  const nodes: GraphNode[] = [
    {
      id: data.seed,
      title: seedLabel ?? shortAddress(data.seed),
      subtitle: seedLabel ? shortAddress(data.seed) : "seed",
      column: 0,
      weight: 1,
      kind: "root",
    },
  ];
  const edges = [];
  for (const member of data.members.slice(0, MAX_DIAGRAM_NODES)) {
    const label = c.labels[member.address]?.label ?? null;
    nodes.push({
      id: member.address,
      title: label ?? shortAddress(member.address),
      subtitle: `${member.tier} · score ${member.score}`,
      column: 1,
      weight: member.score,
      kind: member.tier === "strong" ? "alert" : member.tier === "medium" ? "labeled" : "plain",
    });
    edges.push({
      from: data.seed,
      to: member.address,
      label: member.signals
        .slice(0, 2)
        .map((s) => s.type)
        .join(", "),
      weight: member.score,
    });
  }
  return { title, nodes, edges };
}

function artifactTables(artifact: CaseArtifact): string[] {
  const out: string[] = [];
  if (artifact.kind === "trace") {
    const data = artifact.data as TraceData;
    if (data.totalUsdAtTime)
      out.push(`Total moved (USD at time of transfer): **$${fmt(data.totalUsdAtTime)}**`, "");
    if (data.terminals?.length) {
      const usd = data.terminals.some((t) => t.receivedUsd != null);
      out.push(
        "**Terminal addresses**",
        "",
        `| Address | Label | ${usd ? "Received (USD at time)" : "Received (token units)"} |`,
        "|---|---|---|",
      );
      for (const t of data.terminals.slice(0, 15)) {
        const received = usd
          ? t.receivedUsd != null
            ? `$${fmt(t.receivedUsd)}`
            : "unpriced"
          : fmt(t.received);
        out.push(`| \`${t.address}\` | ${cell(t.label ?? "")} | ${received} |`);
      }
      out.push("");
    }
    out.push(...crossingTable(data.bridgeCrossings ?? []));
  } else if (artifact.kind === "cluster") {
    const data = artifact.data as ClusterData;
    out.push("| Address | Score | Tier | Signals |", "|---|---|---|---|");
    for (const m of data.members) {
      out.push(
        `| \`${m.address}\` | ${m.score} | ${m.tier} | ${cell(m.signals.map((s) => `${s.type}: ${s.detail}`).join("; "))} |`,
      );
    }
    out.push("");
  } else {
    out.push(...crossingTable((artifact.data as BridgeData).crossings ?? []));
  }
  return out;
}

function crossingTable(crossings: BridgeHop[]): string[] {
  if (!crossings.length) return [];
  const out = [
    "**Bridge crossings**",
    "",
    "| Bridge | Route | Sent | Destination address | Destination tx | Status |",
    "|---|---|---|---|---|---|",
  ];
  for (const x of crossings) {
    const sent = x.sent?.amount ? `${fmt(x.sent.amount)} ${x.sent.token ?? ""}` : "";
    out.push(
      `| [${x.bridge}](${x.explorer}) | ${x.fromChain} → ${x.toChain} | ${cell(sent)} | \`${x.toAddress ?? "?"}\` | \`${x.destinationTx ?? "pending"}\` | ${cell(x.status ?? "")} |`,
    );
  }
  out.push("");
  return out;
}

function amountLabel(
  amount: number,
  mint: string,
  symbols: Record<string, string> | undefined,
  usd: number | null | undefined,
): string {
  const symbol = SOL_ALIASES.has(mint) ? "SOL" : (symbols?.[mint] ?? shortAddress(mint));
  return `${fmt(amount)} ${symbol}${usd ? ` · $${fmt(usd)}` : ""}`;
}

function fmt(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(value) < 1 ? 6 : 2,
  }).format(value);
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
