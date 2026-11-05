import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeBase58 } from "../src/util/base58.js";
import { isOffCurve, isOnCurve } from "../src/util/curve.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const HOLDER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const HOLDER_BONK_ATA = "5hpfC9VBxVcoW9opCnM2PqR6YWRLBzrBpabJTZnwwNiw";

function findProgramAddress(seeds: Uint8Array[], program: string): Uint8Array {
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    hash.update(Uint8Array.of(bump));
    hash.update(decodeBase58(program)!);
    hash.update("ProgramDerivedAddress");
    const candidate = new Uint8Array(hash.digest());
    if (!isOnCurve(candidate)) return candidate;
  }
  throw new Error("no viable bump");
}

describe("ed25519 curve check", () => {
  it("treats signing wallets as on-curve", () => {
    for (const wallet of [
      "11111111111111111111111111111111",
      HOLDER,
      "74xPaYPYThVds82iumn97qoxS3fb1jXycKD3LQqkVXmv",
      "7Ag95vBBM8tKdhH8kf4NwX8T9aGsZAoMMv1c6SULjbqs",
      "2sSAob5P2p2oD6H5FyoVCArCApk6HqnaE5v8Mm5Vr6R2",
    ]) {
      expect(isOffCurve(wallet), wallet).toBe(false);
    }
  });

  it("treats program-derived addresses as off-curve", () => {
    expect(isOffCurve("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1")).toBe(true);
    expect(isOffCurve(HOLDER_BONK_ATA)).toBe(true);
  });

  it("derives the same associated token account address Solana does", () => {
    const ata = findProgramAddress(
      [decodeBase58(HOLDER)!, decodeBase58(TOKEN_PROGRAM)!, decodeBase58(BONK)!],
      ATA_PROGRAM,
    );
    expect(Buffer.from(ata).equals(Buffer.from(decodeBase58(HOLDER_BONK_ATA)!))).toBe(true);
  });

  it("rejects input that is not a 32-byte key", () => {
    expect(isOffCurve("not-base58!")).toBe(false);
    expect(isOnCurve(new Uint8Array(31))).toBe(false);
  });
});
