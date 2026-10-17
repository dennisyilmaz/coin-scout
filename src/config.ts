import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Network = "mainnet" | "devnet";

function loadEnvFile(): void {
  const candidates = process.env.COIN_SCOUT_ENV_FILE
    ? [resolve(process.env.COIN_SCOUT_ENV_FILE)]
    : [resolve(".env"), resolve(import.meta.dirname, "..", ".env")];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch {
      /* a malformed .env must not stop a server whose vars are already exported */
    }
    return;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface Config {
  apiKey: string;
  network: Network;
  rpcOrigin: string;
  rpcPath: string;
  connections: number;
  maxConcurrency: number;
  batchWindowMs: number;
  maxBatchSize: number;
  requestTimeoutMs: number;
  maxRetries: number;
  cacheMaxEntries: number;
  allowH2: boolean;
  maxTraceNodes: number;
  maxPageFetch: number;
  casesDir: string;
}

export function loadConfig(): Config {
  loadEnvFile();
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "HELIUS_API_KEY is not set. Export it or put it in a .env file next to the server.",
    );
  }

  const network: Network =
    process.env.HELIUS_NETWORK?.trim().toLowerCase() === "devnet" ? "devnet" : "mainnet";

  const host = process.env.HELIUS_RPC_HOST?.trim() || `${network}.helius-rpc.com`;

  return {
    apiKey,
    network,
    rpcOrigin: `https://${host}`,
    rpcPath: `/?api-key=${apiKey}`,
    connections: envInt("HELIUS_CONNECTIONS", 64),
    maxConcurrency: envInt("HELIUS_MAX_CONCURRENCY", 24),
    batchWindowMs: envInt("HELIUS_BATCH_WINDOW_MS", 4),
    maxBatchSize: envInt("HELIUS_MAX_BATCH_SIZE", 20),
    requestTimeoutMs: envInt("HELIUS_TIMEOUT_MS", 30_000),
    maxRetries: envInt("HELIUS_MAX_RETRIES", 6),
    cacheMaxEntries: envInt("HELIUS_CACHE_ENTRIES", 20_000),
    allowH2: envBool("HELIUS_HTTP2", true),
    maxTraceNodes: envInt("COIN_SCOUT_MAX_TRACE_NODES", 400),
    maxPageFetch: envInt("COIN_SCOUT_MAX_PAGES", 20),
    casesDir: resolve(process.env.COIN_SCOUT_CASES_DIR?.trim() || join(homedir(), ".coin-scout", "cases")),
  };
}

export const NATIVE_SOL = "SOL";
