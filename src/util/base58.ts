const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charCodeAt(i)] = i;

export function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null;

  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros++;

  const size = Math.floor(((value.length - zeros) * 733) / 1000) + 1;
  const bytes = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const digit = code < 128 ? INDEX[code] : -1;
    if (digit < 0) return null;

    let carry = digit;
    let k = size - 1;
    for (; (carry !== 0 || k >= size - length) && k >= 0; k--) {
      carry += 58 * bytes[k];
      bytes[k] = carry & 0xff;
      carry >>= 8;
    }
    length = size - 1 - k;
  }

  const out = new Uint8Array(zeros + length);
  out.set(bytes.subarray(size - length), zeros);
  return out;
}

export function isPubkey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  const decoded = decodeBase58(value);
  return decoded !== null && decoded.length === 32;
}

export function isSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 64 || value.length > 90) return false;
  const decoded = decodeBase58(value);
  return decoded !== null && decoded.length === 64;
}

export function assertPubkey(value: string, label = "address"): string {
  if (!isPubkey(value)) throw new Error(`Invalid Solana ${label}: ${value}`);
  return value;
}

export function assertSignature(value: string): string {
  if (!isSignature(value)) throw new Error(`Invalid transaction signature: ${value}`);
  return value;
}
