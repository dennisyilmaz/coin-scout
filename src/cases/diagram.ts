export interface GraphNode {
  id: string;
  title: string;
  subtitle?: string;
  column: number;
  weight: number;
  kind: "root" | "bridge" | "labeled" | "alert" | "plain";
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
  weight: number;
}

export interface Graph {
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const NODE_W = 240;
const NODE_H = 48;
const COL_GAP = 170;
const ROW_GAP = 22;
const PAD = 40;
const TOP = 80;

const FILL: Record<GraphNode["kind"], [string, string, string]> = {
  root: ["#1f2937", "#111827", "#ffffff"],
  bridge: ["#ede9fe", "#7c3aed", "#3b0764"],
  labeled: ["#fef3c7", "#d97706", "#451a03"],
  alert: ["#fee2e2", "#dc2626", "#450a0a"],
  plain: ["#f9fafb", "#9ca3af", "#111827"],
};

export function renderSvg(graph: Graph): string {
  const columns = [...new Set(graph.nodes.map((n) => n.column))].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number }>();
  let rows = 0;
  columns.forEach((column, ci) => {
    graph.nodes
      .filter((n) => n.column === column)
      .sort((a, b) => b.weight - a.weight)
      .forEach((node, ri) => {
        pos.set(node.id, { x: PAD + ci * (NODE_W + COL_GAP), y: TOP + ri * (NODE_H + ROW_GAP) });
        rows = Math.max(rows, ri + 1);
      });
  });

  const width =
    PAD * 2 + Math.max(1, columns.length) * NODE_W + Math.max(0, columns.length - 1) * COL_GAP;
  const height = TOP + rows * (NODE_H + ROW_GAP) + PAD;
  const maxWeight = Math.max(1, ...graph.edges.map((e) => e.weight));

  const edges = graph.edges
    .filter((e) => pos.has(e.from) && pos.has(e.to))
    .map((edge) => {
      const a = pos.get(edge.from)!;
      const b = pos.get(edge.to)!;
      const forward = b.x > a.x;
      const x1 = forward ? a.x + NODE_W : a.x + NODE_W / 2;
      const y1 = forward ? a.y + NODE_H / 2 : a.y + NODE_H;
      const x2 = forward ? b.x : b.x + NODE_W / 2;
      const y2 = forward ? b.y + NODE_H / 2 : b.y;
      const bend = forward ? (x2 - x1) / 2 : 60;
      const path = forward
        ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
        : `M${x1},${y1} C${x1 + bend},${y1 + bend} ${x2 + bend},${y2 - bend} ${x2},${y2}`;
      const stroke = 1 + 5 * (Math.log1p(edge.weight) / Math.log1p(maxWeight));
      const mx = (x1 + x2) / 2 + (forward ? 0 : bend * 0.75);
      const my = (y1 + y2) / 2;
      const labelWidth = edge.label.length * 6.4 + 10;
      return [
        `<path d="${path}" class="edge" stroke-width="${stroke.toFixed(2)}" marker-end="url(#arrow)"/>`,
        edge.label
          ? `<rect x="${(mx - labelWidth / 2).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="${labelWidth.toFixed(1)}" height="18" rx="4" class="edge-label-bg"/>` +
            `<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" class="edge-label">${esc(edge.label)}</text>`
          : "",
      ].join("");
    });

  const nodes = graph.nodes
    .filter((n) => pos.has(n.id))
    .map((node) => {
      const { x, y } = pos.get(node.id)!;
      const [fill, stroke, ink] = FILL[node.kind];
      return (
        `<g><title>${esc(node.id)}</title>` +
        `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
        `<text x="${x + 12}" y="${y + (node.subtitle ? 20 : 29)}" class="title" fill="${ink}">${esc(clip(node.title, 34))}</text>` +
        (node.subtitle
          ? `<text x="${x + 12}" y="${y + 37}" class="subtitle" fill="${ink}">${esc(clip(node.subtitle, 40))}</text>`
          : "") +
        `</g>`
      );
    });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>`,
    `text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}`,
    `.heading{font-size:18px;font-weight:600;fill:#111827}`,
    `.title{font-size:13px;font-weight:600}`,
    `.subtitle{font-size:11px;opacity:.75;font-family:ui-monospace,Menlo,monospace}`,
    `.edge{fill:none;stroke:#6b7280;stroke-opacity:.7}`,
    `.edge-label{font-size:11px;fill:#374151;text-anchor:middle}`,
    `.edge-label-bg{fill:#ffffff;fill-opacity:.9}`,
    `</style>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#6b7280"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${PAD}" y="${PAD + 4}" class="heading">${esc(graph.title)}</text>`,
    ...edges,
    ...nodes,
    `</svg>`,
  ].join("\n");
}

export function renderMermaid(graph: Graph): string {
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ["flowchart LR"];
  for (const node of graph.nodes) {
    const text = node.subtitle ? `${node.title}<br/>${node.subtitle}` : node.title;
    lines.push(`  ${ids.get(node.id)}["${mermaidText(text)}"]`);
  }
  for (const edge of graph.edges) {
    const a = ids.get(edge.from);
    const b = ids.get(edge.to);
    if (!a || !b) continue;
    lines.push(edge.label ? `  ${a} -->|"${mermaidText(edge.label)}"| ${b}` : `  ${a} --> ${b}`);
  }
  return lines.join("\n");
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mermaidText(text: string): string {
  return text.replace(/"/g, "#quot;");
}
