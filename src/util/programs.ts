import { caseLabelOf } from "../cases/store.js";

export const PROGRAM_LABELS: Record<string, string> = {
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "SPL Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  Stake11111111111111111111111111111111111111: "Stake Program",
  Vote111111111111111111111111111111111111111: "Vote Program",
  BPFLoaderUpgradeab1e11111111111111111111111: "BPF Upgradeable Loader",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: "Metaplex Core",
  cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK: "Account Compression",
  noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV: "SPL Noop",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "Jupiter Aggregator v4",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpools",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Orca Swap v2",
  MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG: "Moonshot",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "Pump.fun AMM",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora Pools",
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: "Magic Eden v2",
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: "Tensorswap",
  wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb: "Wormhole Token Bridge",
  worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth: "Wormhole Core",
  DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh: "deBridge",
  src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4: "deBridge DLN Source",
  dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo: "deBridge DLN Destination",
  BLZRi6frs4X4DNLw56V4EXai1b6QVESN1BhHBTYM9VcY: "Mayan Swift",
  FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf: "Mayan Swap",
  "1nc1nerator11111111111111111111111111111111": "Incinerator (burn address)",
  SysvarRent111111111111111111111111111111111: "Sysvar: Rent",
  SysvarC1ock11111111111111111111111111111111: "Sysvar: Clock",
};

export const BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);

export function labelOf(address: string): string | undefined {
  return PROGRAM_LABELS[address] ?? caseLabelOf(address);
}
