import { decodeBase58 } from "./base58.js";

const P = 2n ** 255n - 19n;
const Y_MASK = (1n << 255n) - 1n;

function mod(value: bigint): bigint {
  const r = value % P;
  return r >= 0n ? r : r + P;
}

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}

const D = mod(-121665n * pow(121666n, P - 2n));

// Mirrors curve25519-dalek decompression, which Solana uses: top bit ignored, y reduced mod p.
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y = mod(y & Y_MASK);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = (u * pow(v, P - 2n)) % P;
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}

export function isOffCurve(address: string): boolean {
  const bytes = decodeBase58(address);
  return bytes !== null && bytes.length === 32 && !isOnCurve(bytes);
}
