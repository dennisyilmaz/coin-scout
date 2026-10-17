import { describe, expect, it } from "vitest";
import { decodeBase58, isPubkey, isSignature } from "../src/util/base58.js";

const PUBKEYS = [
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
];

const SIGNATURES = [
  "5ZWAB8Gr4zDjefZVug6rAUbgunASJ3pn6N3J9PMC7AMWtNWTAs5Nq4CYpwRMrJbfxcgVPUULXALsBMahbmuYvS4T",
  "5hNt3VxJi9yPdBDn8MtEbSbDwpcUK8GBAnjjHkEyDszwqGnWHQdtj4L5z3qtpcmbUyMpbvwXiGztFwp9ksAGL26t",
];

describe("base58", () => {
  it("decodes every real pubkey to exactly 32 bytes", () => {
    for (const key of PUBKEYS) {
      expect(decodeBase58(key), key).toHaveLength(32);
      expect(isPubkey(key), key).toBe(true);
    }
  });

  it("decodes signatures to 64 bytes", () => {
    for (const signature of SIGNATURES) {
      expect(decodeBase58(signature), signature).toHaveLength(64);
      expect(isSignature(signature), signature).toBe(true);
    }
  });

  it("preserves leading zero bytes", () => {
    const decoded = decodeBase58("11111111111111111111111111111111")!;
    expect([...decoded].every((byte) => byte === 0)).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isPubkey("not-a-real-address")).toBe(false);
    expect(isPubkey("0OIl11111111111111111111111111111")).toBe(false);
    expect(isPubkey("")).toBe(false);
    expect(isPubkey(SIGNATURES[0])).toBe(false);
    expect(isSignature(PUBKEYS[0])).toBe(false);
  });

  it("matches a known byte pattern", () => {
    expect([...decodeBase58("So11111111111111111111111111111111111111112")!.slice(0, 4)]).toEqual([
      6, 155, 136, 87,
    ]);
  });
});
