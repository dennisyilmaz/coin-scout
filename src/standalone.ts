import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

// Claude Code spawns the server with piped stdin; a human running the file gets a TTY.
if (!process.stdin.isTTY) {
  await import("./index.js");
} else {
  await install();
}

async function install(): Promise<void> {
  const claude = (...args: string[]) =>
    execFileSync("claude", args, { stdio: "pipe", shell: process.platform === "win32" });

  try {
    claude("--version");
  } catch {
    console.error("Claude Code not found. Install it first: https://claude.com/claude-code");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const key = (await rl.question("Helius API key (free at https://www.helius.dev): ").catch(() => "")).trim();
  rl.close();
  if (!key) {
    console.error("No key entered, nothing installed.");
    process.exit(1);
  }

  const dir = join(homedir(), ".coin-scout");
  const target = join(dir, "coin-scout.mjs");
  mkdirSync(dir, { recursive: true });
  copyFileSync(process.argv[1], target);

  try {
    claude("mcp", "remove", "coin-scout", "-s", "user");
  } catch {}
  claude("mcp", "add", "coin-scout", "-s", "user", "-e", `HELIUS_API_KEY=${key}`, "--", process.execPath, target);

  console.log("\ncoin-scout installed. Restart Claude Code and ask it about any Solana wallet or token.");
}
