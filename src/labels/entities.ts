import type { HeliusApi } from "../helius/api.js";
import { HeliusError } from "../helius/client.js";
import type { TransferRecord } from "../helius/types.js";
import { isOffCurve } from "../util/curve.js";
import { TTL } from "../util/cache.js";
import { OKX_SNAPSHOT, OKX_SOLANA } from "./okx-solana.js";

export interface Entity {
  name: string;
  kind: "exchange" | "exchange_deposit" | "exchange_user" | "hot_wallet" | "identity";
  confidence: "established" | "high" | "medium" | "low";
  source: string;
  counterparty?: string;
  evidence?: string[];
}

const UNIDENTIFIED = "unidentified exchange or service";
const SWEEP_SHARE = 0.9;
const HOT_WALLET_SENDERS = 25;
const MAX_DEPOSIT_CHECKS = 8;
const MAX_TARGET_CHECKS = 4;

let okx: Set<string> | null = null;

export function knownEntity(address: string): Entity | undefined {
  okx ??= new Set(OKX_SOLANA.split("\n").filter(Boolean));
  if (!okx.has(address)) return undefined;
  return {
    name: "OKX",
    kind: "exchange",
    confidence: "established",
    source: `OKX proof of reserves ${OKX_SNAPSHOT.file}: wallet signed "I am an OKX address", signature verified`,
  };
}

export function describeEntity(entity: Entity): string {
  const unknown = entity.name === UNIDENTIFIED;
  if (entity.kind === "exchange") return `${entity.name} wallet (proof of reserves)`;
  if (entity.kind === "exchange_deposit") {
    return unknown ? "likely deposit or collection address (unidentified exchange or service)" : `likely ${entity.name} deposit address`;
  }
  if (entity.kind === "exchange_user" && entity.counterparty) {
    return `sends its funds to ${entity.name} address ${entity.counterparty.slice(0, 4)}…${entity.counterparty.slice(-4)}`;
  }
  if (entity.kind === "hot_wallet") return unknown ? "likely hot wallet (unidentified exchange or service)" : `likely ${entity.name} hot wallet`;
  return entity.name;
}

export function entityLabel(address: string): string | undefined {
  const entity = knownEntity(address);
  return entity ? describeEntity(entity) : undefined;
}

export interface HeliusIdentity {
  address: string;
  name?: string;
  type?: string;
  category?: string;
  tags?: string[];
}

let identityUnavailable: string | null = null;

export async function heliusIdentities(
  api: HeliusApi,
  addresses: string[],
): Promise<{ identities: Map<string, HeliusIdentity>; note: string | null }> {
  const identities = new Map<string, HeliusIdentity>();
  if (identityUnavailable || addresses.length === 0) return { identities, note: identityUnavailable };
  try {
    for (let i = 0; i < addresses.length; i += 100) {
      const body = await api.client.restPost<HeliusIdentity[] | { data?: HeliusIdentity[] }>(
        "/v1/wallet/batch-identity",
        { addresses: addresses.slice(i, i + 100) },
        { ttlMs: TTL.immutable },
      );
      for (const row of Array.isArray(body) ? body : (body.data ?? [])) {
        if (row?.address && (row.name || row.category || row.type)) identities.set(row.address, row);
      }
    }
    return { identities, note: null };
  } catch (error) {
    const status = error instanceof HeliusError ? Number(error.code) : NaN;
    const note = `Helius wallet identity unavailable${Number.isFinite(status) ? ` (HTTP ${status})` : ""}; it needs a paid Helius plan`;
    if (status === 401 || status === 403 || status === 404) identityUnavailable = note;
    return { identities, note };
  }
}

export interface SweepPattern {
  address: string;
  target: string;
  sweeps: number;
  outgoing: number;
  share: number;
  sampleSig: string;
}

export function sweepPattern(address: string, transfers: TransferRecord[]): SweepPattern | null {
  const outgoing = transfers.filter((t) => t.fromUserAccount === address && t.toUserAccount && t.toUserAccount !== address);
  if (outgoing.length === 0) return null;
  const byTarget = new Map<string, TransferRecord[]>();
  for (const t of outgoing) {
    const list = byTarget.get(t.toUserAccount!) ?? [];
    list.push(t);
    byTarget.set(t.toUserAccount!, list);
  }
  const [target, sweeps] = [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const share = sweeps.length / outgoing.length;
  if (share < SWEEP_SHARE || isOffCurve(target)) return null;
  return { address, target, sweeps: sweeps.length, outgoing: outgoing.length, share, sampleSig: sweeps[0].signature };
}

export function distinctSenders(address: string, transfers: TransferRecord[]): number {
  return new Set(
    transfers.filter((t) => t.toUserAccount === address && t.fromUserAccount).map((t) => t.fromUserAccount),
  ).size;
}

export function classifyDeposit(
  pattern: SweepPattern,
  target: { entity?: Entity; senders: number | null; sampled: number },
): { deposit: Entity; hotWallet: Entity | null } | null {
  const evidence = [pattern.sampleSig];
  const swept = `${pattern.sweeps} of its ${pattern.outgoing} recent outgoing transfers went to ${pattern.target}`;
  if (target.entity?.kind === "exchange") {
    const name = target.entity.name;
    const hot = target.senders !== null && target.senders >= HOT_WALLET_SENDERS;
    const fanIn = target.senders === null ? "" : `, ${target.senders} distinct senders in its last ${target.sampled} inbound transfers`;
    return {
      deposit: hot
        ? {
            name,
            kind: "exchange_deposit",
            confidence: pattern.sweeps >= 2 ? "high" : "medium",
            source: `sweep pattern: ${swept} (${name} wallet${fanIn})`,
            evidence,
          }
        : {
            name,
            kind: "exchange_user",
            confidence: "medium",
            source: `${swept} (${name} wallet${fanIn}). That wallet is likely this sender's ${name} deposit address, the one to ask ${name} about`,
            counterparty: pattern.target,
            evidence,
          },
      hotWallet: null,
    };
  }
  if (pattern.sweeps < 2 || target.senders === null || target.senders < HOT_WALLET_SENDERS) return null;
  const fanIn = `${target.senders} distinct senders in its last ${target.sampled} inbound transfers`;
  return {
    deposit: {
      name: UNIDENTIFIED,
      kind: "exchange_deposit",
      confidence: "low",
      source: `sweep pattern: ${swept}, which has ${fanIn}`,
      evidence,
    },
    hotWallet: {
      name: UNIDENTIFIED,
      kind: "hot_wallet",
      confidence: "low",
      source: `fan-in: ${fanIn}`,
    },
  };
}

export async function detectDeposits(
  api: HeliusApi,
  addresses: string[],
): Promise<Map<string, Entity>> {
  const found = new Map<string, Entity>();
  const candidates = addresses.filter((a) => !knownEntity(a) && !isOffCurve(a)).slice(0, MAX_DEPOSIT_CHECKS);
  const patterns = (
    await Promise.all(
      candidates.map((address) =>
        api
          .getTransfersByAddress({ address, direction: "out", sortOrder: "desc", limit: 50 })
          .then((page) => sweepPattern(address, page.data ?? []))
          .catch(() => null),
      ),
    )
  ).filter((p): p is SweepPattern => p !== null);

  const targets = [...new Set(patterns.map((p) => p.target))].slice(0, MAX_TARGET_CHECKS);
  const fanIn = new Map<string, { senders: number; sampled: number }>();
  await Promise.all(
    targets.map((target) =>
      api
        .getTransfersByAddress({ address: target, direction: "in", sortOrder: "desc", limit: 100 })
        .then((page) => {
          const rows = page.data ?? [];
          fanIn.set(target, { senders: distinctSenders(target, rows), sampled: rows.length });
        })
        .catch(() => {}),
    ),
  );

  for (const pattern of patterns) {
    const stats = fanIn.get(pattern.target);
    const verdict = classifyDeposit(pattern, {
      entity: knownEntity(pattern.target),
      senders: stats?.senders ?? null,
      sampled: stats?.sampled ?? 0,
    });
    if (!verdict) continue;
    found.set(pattern.address, verdict.deposit);
    if (verdict.hotWallet && !found.has(pattern.target)) found.set(pattern.target, verdict.hotWallet);
  }
  return found;
}

export async function identifyEntities(
  api: HeliusApi,
  addresses: string[],
  options: { deposits: boolean },
): Promise<{ entities: Map<string, Entity>; notes: string[] }> {
  const entities = new Map<string, Entity>();
  for (const address of addresses) {
    const known = knownEntity(address);
    if (known) entities.set(address, known);
  }
  const rest = addresses.filter((a) => !entities.has(a));
  const [{ identities, note }, deposits] = await Promise.all([
    heliusIdentities(api, rest),
    options.deposits ? detectDeposits(api, rest) : Promise.resolve(new Map<string, Entity>()),
  ]);
  for (const [address, identity] of identities) {
    entities.set(address, {
      name: identity.name ?? identity.category ?? identity.type ?? "labelled by Helius",
      kind: "identity",
      confidence: "high",
      source: `Helius wallet identity${identity.category ? ` (${identity.category})` : ""}`,
    });
  }
  for (const [address, entity] of deposits) if (!entities.has(address)) entities.set(address, entity);
  return { entities, notes: note ? [note] : [] };
}
