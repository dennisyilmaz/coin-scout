import type { HeliusApi, RawTransaction } from "../helius/api.js";
import type { SignatureInfo } from "../helius/types.js";
import { iso, round } from "../util/format.js";
import { PROGRAM_LABELS, labelOf } from "../util/programs.js";
import { BRIDGE_PROGRAMS } from "./bridges.js";
import { SOL_ALIASES } from "./prices.js";
import { amountOf, fetchTransfers } from "./transfers.js";

export type SignalType =
  | "co_signer"
  | "pays_seed_fees"
  | "receives_seed_rent"
  | "sends_rent_to_seed"
  | "fee_payer_shared"
  | "rent_destination_shared"
  | "funded_seed"
  | "sole_funder"
  | "shared_funder"
  | "funded_same_window"
  | "created_near_seed"
  | "same_slot"
  | "direct_transfer"
  | "similar_timing";

export const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  co_signer: 45,
  pays_seed_fees: 45,
  receives_seed_rent: 40,
  sends_rent_to_seed: 40,
  fee_payer_shared: 30,
  rent_destination_shared: 30,
  funded_seed: 15,
  sole_funder: 35,
  shared_funder: 20,
  funded_same_window: 15,
  created_near_seed: 15,
  same_slot: 20,
  direct_transfer: 10,
  similar_timing: 5,
};

const MIN_FUNDING_SOL = 0.001;
const SERVICE_FANOUT = 60;
const EXPAND_PER_KIND = 3;
const WINDOW_SECONDS = 3_600;

interface Signal {
  detail: string;
  evidence: string[];
}

export class CandidateSet {
  readonly map = new Map<string, Map<SignalType, Signal>>();

  constructor(private readonly exclude: Set<string>) {}

  add(
    address: string | null | undefined,
    type: SignalType,
    detail: string,
    evidence?: string,
  ): void {
    if (
      !address ||
      this.exclude.has(address) ||
      PROGRAM_LABELS[address] ||
      BRIDGE_PROGRAMS[address]
    )
      return;
    let signals = this.map.get(address);
    if (!signals) {
      signals = new Map();
      this.map.set(address, signals);
    }
    const existing = signals.get(type);
    if (existing) {
      if (evidence && existing.evidence.length < 3 && !existing.evidence.includes(evidence)) {
        existing.evidence.push(evidence);
      }
    } else {
      signals.set(type, { detail, evidence: evidence ? [evidence] : [] });
    }
  }

  score(address: string): number {
    let total = 0;
    for (const type of this.map.get(address)?.keys() ?? []) total += SIGNAL_WEIGHTS[type];
    return Math.min(100, total);
  }
}

interface ParsedIx {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

export function signersOf(tx: RawTransaction): string[] {
  return tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);
}

export function closesIn(tx: RawTransaction): Array<{ owner: string; destination: string }> {
  const inner = (
    (tx.meta?.innerInstructions ?? []) as Array<{ instructions?: ParsedIx[] }>
  ).flatMap((group) => group.instructions ?? []);
  return [...(tx.transaction.message.instructions as ParsedIx[]), ...inner]
    .filter((ix) => ix.parsed?.type === "closeAccount" && ix.program?.startsWith("spl-token"))
    .map((ix) => ({
      owner: String(ix.parsed?.info?.owner ?? ix.parsed?.info?.multisigOwner ?? ""),
      destination: String(ix.parsed?.info?.destination ?? ""),
    }))
    .filter((c) => c.owner && c.destination);
}

export function collectSeedSignals(seed: string, txs: RawTransaction[], candidates: CandidateSet) {
  const payers = new Map<string, number>();
  const rentDestinations = new Map<string, number>();

  for (const tx of txs) {
    const sig = tx.transaction.signatures[0];
    const payer = tx.transaction.message.accountKeys[0]?.pubkey;
    const signers = signersOf(tx);
    if (signers.includes(seed)) {
      if (payer && payer !== seed) {
        candidates.add(payer, "pays_seed_fees", "paid fees for a transaction the seed signed", sig);
        payers.set(payer, (payers.get(payer) ?? 0) + 1);
      }
      for (const signer of signers) {
        if (signer !== seed && signer !== payer) {
          candidates.add(signer, "co_signer", "co-signed a transaction with the seed", sig);
        }
      }
    }
    for (const close of closesIn(tx)) {
      if (close.owner === seed && close.destination !== seed) {
        candidates.add(
          close.destination,
          "receives_seed_rent",
          "receives rent when the seed closes token accounts",
          sig,
        );
        rentDestinations.set(close.destination, (rentDestinations.get(close.destination) ?? 0) + 1);
      } else if (close.destination === seed && close.owner !== seed) {
        candidates.add(
          close.owner,
          "sends_rent_to_seed",
          "closes its token accounts into the seed",
          sig,
        );
      }
    }
  }

  return { payers: ranked(payers), rentDestinations: ranked(rentDestinations) };
}

export function slotOverlap(seedSigs: SignatureInfo[], otherSigs: SignatureInfo[]) {
  const seedBySlot = new Map<number, Set<string>>();
  for (const s of seedSigs) {
    const set = seedBySlot.get(s.slot) ?? new Set<string>();
    set.add(s.signature);
    seedBySlot.set(s.slot, set);
  }
  const shared: number[] = [];
  const otherSlots = new Set<number>();
  for (const s of otherSigs) {
    otherSlots.add(s.slot);
    const seedSet = seedBySlot.get(s.slot);
    if (seedSet && !seedSet.has(s.signature) && !shared.includes(s.slot)) shared.push(s.slot);
  }

  const range = (sigs: SignatureInfo[]) =>
    sigs.length
      ? [Math.min(...sigs.map((s) => s.slot)), Math.max(...sigs.map((s) => s.slot))]
      : [0, 0];
  const [a0, a1] = range(seedSigs);
  const [b0, b1] = range(otherSigs);
  const overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0) + 1);
  const inWindow = (slots: Iterable<number>) =>
    [...slots].filter((slot) => slot >= Math.max(a0, b0) && slot <= Math.min(a1, b1)).length;
  const expected = overlap > 0 ? (inWindow(seedBySlot.keys()) * inWindow(otherSlots)) / overlap : 0;

  return { sharedSlots: shared, expected: round(expected, 3) };
}

export function hourCosine(a: number[], b: number[]): number | null {
  if (a.length < 20 || b.length < 20) return null;
  const hist = (ts: number[]) => {
    const h = new Array<number>(24).fill(0);
    for (const t of ts) h[new Date(t * 1000).getUTCHours()]++;
    return h;
  };
  const ha = hist(a);
  const hb = hist(b);
  const dot = ha.reduce((acc, v, i) => acc + v * hb[i], 0);
  const norm = (h: number[]) => Math.sqrt(h.reduce((acc, v) => acc + v * v, 0));
  return round(dot / (norm(ha) * norm(hb) || 1), 3);
}

export async function findCluster(
  api: HeliusApi,
  seed: string,
  options: { txSample: number; maxCandidates: number; maxPages: number },
) {
  const exclude = new Set([seed]);
  const candidates = new CandidateSet(exclude);
  const skipped: string[] = [];

  const [seedTxs, seedSigs, seedFirst, earlyInbound, recent] = await Promise.all([
    fullTransactions(api, seed, options.txSample),
    signatures(api, seed, 1000, "desc"),
    signatures(api, seed, 1, "asc"),
    fetchTransfers(api, { address: seed, direction: "in", sortOrder: "asc" }, 200, 2),
    fetchTransfers(api, { address: seed, sortOrder: "desc" }, 400, options.maxPages),
  ]);
  const seedFirstTs = seedFirst[0]?.blockTime ?? null;

  const { payers, rentDestinations } = collectSeedSignals(seed, seedTxs, candidates);

  const funders: Array<{ address: string; ts: number; sig: string }> = [];
  for (const t of earlyInbound.transfers) {
    if (!SOL_ALIASES.has(t.mint) || amountOf(t) < MIN_FUNDING_SOL || !t.fromUserAccount) continue;
    if (funders.some((f) => f.address === t.fromUserAccount)) continue;
    funders.push({ address: t.fromUserAccount, ts: t.blockTime, sig: t.signature });
    candidates.add(
      t.fromUserAccount,
      "funded_seed",
      `sent the seed ${amountOf(t)} SOL early on`,
      t.signature,
    );
    if (funders.length >= EXPAND_PER_KIND) break;
  }
  const realInbound = earlyInbound.transfers.filter(
    (t) => SOL_ALIASES.has(t.mint) && amountOf(t) >= MIN_FUNDING_SOL && t.fromUserAccount,
  );
  const sources = new Set(realInbound.map((t) => t.fromUserAccount));
  if (!earlyInbound.truncated && sources.size === 1) {
    candidates.add(
      realInbound[0].fromUserAccount,
      "sole_funder",
      `only source of SOL into the seed (${realInbound.length} transfers, dust excluded)`,
      realInbound[0].signature,
    );
  }

  await Promise.all([
    ...payers.slice(0, EXPAND_PER_KIND).map(async (payer) => {
      const txs = await fullTransactions(api, payer, 100).catch(() => []);
      const paidFor = new Set<string>();
      for (const tx of txs) {
        if (tx.transaction.message.accountKeys[0]?.pubkey !== payer) continue;
        for (const signer of signersOf(tx)) if (signer !== payer) paidFor.add(signer);
      }
      if (paidFor.size > SERVICE_FANOUT) {
        skipped.push(
          `fee payer ${payer} pays for ${paidFor.size}+ signers — looks like a relayer, not expanded`,
        );
        return;
      }
      for (const tx of txs) {
        if (tx.transaction.message.accountKeys[0]?.pubkey !== payer) continue;
        for (const signer of signersOf(tx)) {
          if (signer !== payer) {
            candidates.add(
              signer,
              "fee_payer_shared",
              `fees also paid by ${payer}`,
              tx.transaction.signatures[0],
            );
          }
        }
      }
    }),
    ...rentDestinations.slice(0, EXPAND_PER_KIND).map(async (destination) => {
      const txs = await fullTransactions(api, destination, 100).catch(() => []);
      const owners = new Map<string, string>();
      for (const tx of txs) {
        for (const close of closesIn(tx)) {
          if (
            close.destination === destination &&
            close.owner !== seed &&
            !owners.has(close.owner)
          ) {
            owners.set(close.owner, tx.transaction.signatures[0]);
          }
        }
      }
      if (owners.size > SERVICE_FANOUT) {
        skipped.push(
          `rent destination ${destination} collects from ${owners.size}+ owners — looks like a service, not expanded`,
        );
        return;
      }
      for (const [owner, sig] of owners) {
        candidates.add(
          owner,
          "rent_destination_shared",
          `also closes token accounts into ${destination}`,
          sig,
        );
      }
    }),
    ...funders.map(async (funder) => {
      const page = await fetchTransfers(
        api,
        {
          address: funder.address,
          direction: "out",
          sortOrder: "asc",
          filters: { blockTime: { gte: funder.ts - 7 * 86_400, lte: funder.ts + 7 * 86_400 } },
        },
        300,
        3,
      ).catch(() => null);
      if (!page) return;
      const funded = page.transfers.filter(
        (t) =>
          SOL_ALIASES.has(t.mint) &&
          amountOf(t) >= MIN_FUNDING_SOL &&
          t.toUserAccount &&
          t.toUserAccount !== seed,
      );
      const recipients = new Set(funded.map((t) => t.toUserAccount));
      if (recipients.size > SERVICE_FANOUT) {
        skipped.push(
          `funder ${funder.address} sent SOL to ${recipients.size}+ wallets in a week — looks like an exchange or service, siblings not expanded`,
        );
        return;
      }
      for (const t of funded) {
        candidates.add(
          t.toUserAccount,
          "shared_funder",
          `also funded by ${funder.address}`,
          t.signature,
        );
        if (Math.abs(t.blockTime - funder.ts) <= WINDOW_SECONDS) {
          candidates.add(
            t.toUserAccount,
            "funded_same_window",
            `funded within an hour of the seed by ${funder.address}`,
            t.signature,
          );
        }
      }
    }),
  ]);

  const shortlist = [...candidates.map.keys()]
    .sort((a, b) => candidates.score(b) - candidates.score(a))
    .slice(0, options.maxCandidates);

  const directCounts = new Map<string, { count: number; sig: string }>();
  for (const t of recent.transfers) {
    const other = t.fromUserAccount === seed ? t.toUserAccount : t.fromUserAccount;
    if (!other || (SOL_ALIASES.has(t.mint) && amountOf(t) < MIN_FUNDING_SOL)) continue;
    const entry = directCounts.get(other) ?? { count: 0, sig: t.signature };
    entry.count++;
    directCounts.set(other, entry);
  }
  const seedTimes = seedSigs.map((s) => s.blockTime).filter((t): t is number => !!t);

  const enriched = await Promise.all(
    shortlist.map(async (address) => {
      const [sigs, first] = await Promise.all([
        signatures(api, address, 500, "desc").catch(() => []),
        signatures(api, address, 1, "asc").catch(() => []),
      ]);
      const firstTs = first[0]?.blockTime ?? null;

      const direct = directCounts.get(address);
      if (direct)
        candidates.add(
          address,
          "direct_transfer",
          `${direct.count} transfers with the seed in sample`,
          direct.sig,
        );

      const { sharedSlots, expected } = slotOverlap(seedSigs, sigs);
      if (sharedSlots.length >= 2 && sharedSlots.length >= 3 * expected) {
        candidates.add(
          address,
          "same_slot",
          `separate transactions in the same slot ${sharedSlots.length}× (≈${expected} expected by chance), e.g. slot ${sharedSlots[0]}`,
        );
      }

      if (firstTs && seedFirstTs && Math.abs(firstTs - seedFirstTs) <= WINDOW_SECONDS) {
        candidates.add(
          address,
          "created_near_seed",
          `first activity ${Math.round(Math.abs(firstTs - seedFirstTs) / 60)} min from the seed's`,
          first[0]?.signature,
        );
      }

      const cosine = hourCosine(
        seedTimes,
        sigs.map((s) => s.blockTime).filter((t): t is number => !!t),
      );
      if (cosine !== null && cosine >= 0.9) {
        candidates.add(address, "similar_timing", `hour-of-day activity cosine ${cosine}`);
      }

      return { address, firstTs, sampled: sigs.length };
    }),
  );

  const members = enriched
    .map(({ address, firstTs }) => {
      const score = candidates.score(address);
      return {
        address,
        label: labelOf(address) ?? null,
        score,
        tier: score >= 60 ? "strong" : score >= 35 ? "medium" : "weak",
        firstActivityAt: iso(firstTs),
        signals: [...(candidates.map.get(address) ?? new Map<SignalType, Signal>()).entries()]
          .sort((a, b) => SIGNAL_WEIGHTS[b[0]] - SIGNAL_WEIGHTS[a[0]])
          .map(([type, signal]) => ({ type, weight: SIGNAL_WEIGHTS[type], ...signal })),
      };
    })
    .filter((m) => m.score >= 15)
    .sort((a, b) => b.score - a.score);

  return {
    seed,
    seedFirstActivityAt: iso(seedFirstTs),
    sampled: {
      fullTransactions: seedTxs.length,
      signatures: seedSigs.length,
      transfers: recent.transfers.length,
    },
    seedFacts: {
      funders: funders.map((f) => ({ address: f.address, at: iso(f.ts), sig: f.sig })),
      externalFeePayers: payers.slice(0, 5),
      rentDestinations: rentDestinations.slice(0, 5),
    },
    candidatesConsidered: candidates.map.size,
    candidatesScored: shortlist.length,
    skipped,
    members,
  };
}

function ranked(counts: Map<string, number>): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([address]) => address);
}

async function fullTransactions(
  api: HeliusApi,
  address: string,
  max: number,
): Promise<RawTransaction[]> {
  const out: RawTransaction[] = [];
  let token: string | undefined;
  while (out.length < max) {
    const page = await api.getTransactionsForAddress({
      address,
      limit: Math.min(100, max - out.length),
      sortOrder: "desc",
      transactionDetails: "full",
      encoding: "jsonParsed",
      paginationToken: token,
      filters: { status: "succeeded" },
    });
    const rows = (page.data ?? []) as RawTransaction[];
    out.push(...rows);
    token = page.paginationToken ?? undefined;
    if (!token || rows.length === 0) break;
  }
  return out;
}

async function signatures(
  api: HeliusApi,
  address: string,
  limit: number,
  sortOrder: "asc" | "desc",
): Promise<SignatureInfo[]> {
  const page = await api.getTransactionsForAddress({
    address,
    limit,
    sortOrder,
    transactionDetails: "signatures",
  });
  return (page.data ?? []) as SignatureInfo[];
}
