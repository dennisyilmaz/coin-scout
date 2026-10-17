import type { HeliusApi, Direction, Range } from "../helius/api.js";
import type { TransferRecord } from "../helius/types.js";
import { num } from "../util/format.js";

export interface TransferQuery {
  address: string;
  with?: string;
  direction?: Direction;
  mint?: string;
  limit?: number;
  sortOrder?: "asc" | "desc";
  solMode?: "merged" | "separate";
  filters?: { amount?: Range; blockTime?: Range; slot?: Range };
}

export async function fetchTransfers(
  api: HeliusApi,
  query: TransferQuery,
  maxRecords: number,
  maxPages: number,
): Promise<{ transfers: TransferRecord[]; truncated: boolean; nextCursor: string | null }> {
  const out: TransferRecord[] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (out.length < maxRecords && pages < maxPages) {
    const page = await api.getTransfersByAddress({
      ...query,
      limit: Math.min(100, maxRecords - out.length),
      paginationToken: cursor,
    });
    pages++;
    const rows = page.data ?? [];
    out.push(...rows);
    cursor = page.paginationToken ?? undefined;
    if (!cursor || rows.length === 0) {
      return { transfers: out.slice(0, maxRecords), truncated: false, nextCursor: null };
    }
  }

  return {
    transfers: out.slice(0, maxRecords),
    truncated: true,
    nextCursor: cursor ?? null,
  };
}

export function amountOf(transfer: TransferRecord): number {
  const ui = num(transfer.uiAmount);
  if (ui) return ui;
  const raw = num(transfer.amount);
  return transfer.decimals ? raw / 10 ** transfer.decimals : raw;
}

export function slimTransfer(transfer: TransferRecord) {
  return {
    sig: transfer.signature,
    slot: transfer.slot,
    ts: transfer.blockTime,
    type: transfer.type,
    from: transfer.fromUserAccount,
    to: transfer.toUserAccount,
    mint: transfer.mint,
    amount: amountOf(transfer),
    decimals: transfer.decimals,
  };
}

export interface CounterpartyStat {
  address: string;
  inCount: number;
  outCount: number;
  inByMint: Record<string, number>;
  outByMint: Record<string, number>;
  firstTs: number;
  lastTs: number;
}

export function aggregateCounterparties(
  transfers: TransferRecord[],
  self: string,
): CounterpartyStat[] {
  const map = new Map<string, CounterpartyStat>();

  for (const transfer of transfers) {
    const inbound = transfer.toUserAccount === self;
    const other = inbound ? transfer.fromUserAccount : transfer.toUserAccount;
    if (!other || other === self) continue;

    let stat = map.get(other);
    if (!stat) {
      stat = {
        address: other,
        inCount: 0,
        outCount: 0,
        inByMint: {},
        outByMint: {},
        firstTs: transfer.blockTime,
        lastTs: transfer.blockTime,
      };
      map.set(other, stat);
    }

    const amount = amountOf(transfer);
    const bucket = inbound ? stat.inByMint : stat.outByMint;
    bucket[transfer.mint] = (bucket[transfer.mint] ?? 0) + amount;
    if (inbound) stat.inCount++;
    else stat.outCount++;
    stat.firstTs = Math.min(stat.firstTs, transfer.blockTime);
    stat.lastTs = Math.max(stat.lastTs, transfer.blockTime);
  }

  return [...map.values()];
}
