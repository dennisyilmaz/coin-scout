import { createPrivateKey, createPublicKey } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

function encodeBase58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function wallet(seed: number): string {
  const secret = Buffer.alloc(32);
  secret.writeUInt32BE(seed + 1);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, secret]), format: "der", type: "pkcs8" });
  const x = createPublicKey(key).export({ format: "jwk" }).x!;
  return encodeBase58(Buffer.from(x, "base64url"));
}
