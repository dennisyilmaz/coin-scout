export const LAMPORTS_PER_SOL = 1_000_000_000;

export function toSol(lamports: number): number {
  return round(lamports / LAMPORTS_PER_SOL, 9);
}

export function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return round((part / whole) * 100, 3);
}

export function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : 0;
}

export function ago(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds) return null;
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function iso(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function json(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, replacer) }] };
}

export function fail(message: string, detail?: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, detail }, replacer) }],
    isError: true,
  };
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function topN<T>(items: T[], n: number, score: (item: T) => number): T[] {
  return [...items].sort((a, b) => score(b) - score(a)).slice(0, n);
}

export function herfindahl(shares: number[]): number {
  const total = shares.reduce((acc, s) => acc + s, 0);
  if (total <= 0) return 0;
  return round(
    shares.reduce((acc, s) => acc + (s / total) ** 2, 0),
    6,
  );
}
