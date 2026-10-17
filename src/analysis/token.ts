import type { HeliusApi } from "../helius/api.js";
import { herfindahl, num, pct, round } from "../util/format.js";
import { BURN_ADDRESSES, labelOf } from "../util/programs.js";

const HOLDER_SCAN_LIMIT = 1000;

export interface TokenReport {
  mint: string;
  metadata: Record<string, unknown>;
  supply: Record<string, unknown>;
  authorities: Record<string, unknown>;
  distribution: Record<string, unknown>;
  topHolders: HolderRow[];
  riskFlags: string[];
  riskScore: number;
}

interface HolderRow {
  tokenAccount: string;
  owner: string | null;
  ownerProgram: string | null;
  ownerLabel: string | null;
  amount: number;
  supplyPct: number;
  isBurn: boolean;
  isProgramOwned: boolean;
}

export async function analyzeToken(
  api: HeliusApi,
  mint: string,
  holdersShown: number,
): Promise<TokenReport> {
  const [asset, supply, largest, holderPage] = await Promise.all([
    api.getAsset(mint).catch(() => null),
    api.getTokenSupply(mint),
    api
      .getTokenLargestAccounts(mint)
      .catch((error: unknown) => ({
        value: [],
        error: error instanceof Error ? error.message : String(error),
      })),
    api.getDasTokenAccounts({ mint, limit: HOLDER_SCAN_LIMIT }).catch(() => null),
  ]);

  const decimals = supply.value.decimals;
  const totalSupply = num(supply.value.uiAmountString ?? supply.value.uiAmount);

  const largestAccounts = largest.value ?? [];
  const owners = largestAccounts.length
    ? await api
        .getMultipleAccounts(largestAccounts.map((a) => a.address))
        .then((res) => res.value)
        .catch(() => [])
    : [];

  const ownerAddresses = owners.map((account) => {
    const parsed = account?.data as { parsed?: { info?: { owner?: string } } } | undefined;
    return parsed?.parsed?.info?.owner ?? null;
  });

  const uniqueOwners = [...new Set(ownerAddresses.filter((o): o is string => Boolean(o)))];
  const ownerAccounts = uniqueOwners.length
    ? await api
        .getMultipleAccounts(uniqueOwners)
        .then((res) => res.value)
        .catch(() => [])
    : [];

  const ownerProgram = new Map<string, string>();
  uniqueOwners.forEach((owner, index) => {
    const program = ownerAccounts[index]?.owner;
    if (program) ownerProgram.set(owner, program);
  });

  const topHolders: HolderRow[] = largestAccounts.map((account, index) => {
    const owner = ownerAddresses[index] ?? null;
    const program = owner ? (ownerProgram.get(owner) ?? null) : null;
    const amount = num(account.uiAmountString ?? account.uiAmount);
    return {
      tokenAccount: account.address,
      owner,
      ownerProgram: program,
      ownerLabel: owner ? (labelOf(owner) ?? (program ? (labelOf(program) ?? null) : null)) : null,
      amount: round(amount, 6),
      supplyPct: pct(amount, totalSupply),
      isBurn: owner ? BURN_ADDRESSES.has(owner) : false,
      isProgramOwned: program !== null && program !== "11111111111111111111111111111111",
    };
  });

  const concentrationError = "error" in largest ? (largest.error as string) : null;
  const known = concentrationError === null && topHolders.length > 0;
  const circulating = topHolders.filter((h) => !h.isBurn);
  const top1 = known ? (circulating[0]?.supplyPct ?? 0) : null;
  const top10 = known
    ? round(
        circulating.slice(0, 10).reduce((acc, h) => acc + h.supplyPct, 0),
        3,
      )
    : null;
  const top20 = known
    ? round(
        circulating.slice(0, 20).reduce((acc, h) => acc + h.supplyPct, 0),
        3,
      )
    : null;
  const burnedPct = known
    ? round(
        topHolders.filter((h) => h.isBurn).reduce((acc, h) => acc + h.supplyPct, 0),
        3,
      )
    : null;

  const info = asset?.token_info;
  const mintAuthority = info?.mint_authority ?? null;
  const freezeAuthority = info?.freeze_authority ?? null;
  const scanned = holderPage?.token_accounts?.length ?? null;
  const holderCountExact = scanned !== null && scanned < HOLDER_SCAN_LIMIT;
  const holderCount = scanned;
  const priceUsd = info?.price_info?.price_per_token ?? null;

  const flags: string[] = [];
  let score = 0;

  if (mintAuthority) {
    flags.push(`mint_authority_active: ${mintAuthority} can mint unlimited new supply`);
    score += 30;
  }
  if (freezeAuthority) {
    flags.push(`freeze_authority_active: ${freezeAuthority} can freeze any holder's account`);
    score += 25;
  }
  if (asset?.mutable) {
    flags.push("metadata_mutable: name, symbol and image can still be changed by the authority");
    score += 5;
  }
  if (top1 === null) {
    flags.push(
      `concentration_unknown: holder distribution could not be measured (${concentrationError ?? "no top-holder data"}) — treat top1/top10 as unmeasured, not low`,
    );
  } else if (top1 >= 50) {
    flags.push(`extreme_concentration: largest non-burn holder controls ${top1}% of supply`);
    score += 25;
  } else if (top1 >= 20) {
    flags.push(`high_concentration: largest non-burn holder controls ${top1}% of supply`);
    score += 12;
  }
  if (top10 !== null && top10 >= 80) {
    flags.push(`top10_dominance: top 10 non-burn holders control ${top10}% of supply`);
    score += 15;
  }
  if (holderCountExact && holderCount !== null && holderCount < 100) {
    flags.push(`low_holder_count: only ${holderCount} token accounts exist`);
    score += 10;
  }
  if (priceUsd === null) {
    flags.push("no_price_feed: not in Helius priced-token set — thin or no liquidity");
    score += 5;
  }
  const unverified = (asset?.creators ?? []).filter((c) => !c.verified);
  if (unverified.length > 0) {
    flags.push(`unverified_creators: ${unverified.length} of ${asset?.creators?.length} creators unverified`);
    score += 5;
  }
  if (asset?.burnt) {
    flags.push("asset_burnt: DAS reports this asset as burnt");
    score += 10;
  }
  const programOwnedTop = circulating.filter((h) => h.isProgramOwned).length;
  if (programOwnedTop > 0) {
    flags.push(
      `${programOwnedTop} of the top holders are program-owned accounts (likely AMM pools or vaults, not individuals)`,
    );
  }

  return {
    mint,
    metadata: {
      name: asset?.content?.metadata?.name ?? null,
      symbol: asset?.content?.metadata?.symbol ?? info?.symbol ?? null,
      interface: asset?.interface ?? null,
      tokenProgram: info?.token_program ?? null,
      mutable: asset?.mutable ?? null,
      burnt: asset?.burnt ?? null,
      creators: asset?.creators ?? null,
      jsonUri: asset?.content?.json_uri ?? null,
    },
    supply: {
      totalSupply,
      decimals,
      rawAmount: supply.value.amount,
      burnedPct,
      holderAccounts: holderCount,
      holderAccountsExact: holderCountExact,
      priceUsd,
      fdvUsd: priceUsd ? round(priceUsd * totalSupply, 2) : null,
    },
    authorities: {
      mintAuthority,
      freezeAuthority,
      mintRenounced: mintAuthority === null,
      freezeRenounced: freezeAuthority === null,
      updateAuthorities: asset?.authorities ?? null,
    },
    distribution: {
      measured: known,
      error: concentrationError,
      top1Pct: top1,
      top10Pct: top10,
      top20Pct: top20,
      hhiTop20: known ? herfindahl(circulating.slice(0, 20).map((h) => h.amount)) : null,
      sampledHolders: topHolders.length,
    },
    topHolders: topHolders.slice(0, holdersShown),
    riskFlags: flags,
    riskScore: Math.min(100, score),
  };
}
