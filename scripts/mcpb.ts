import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const REPO = "https://github.com/dennisyilmaz/coin-scout";
const BUNDLE = "build/coin-scout.mjs";
const STAGE = "build/mcpb";
const MCPB = "build/coin-scout.mcpb";
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "coin-scout-mcpb", version: "1" },
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.description.length > 100) throw new Error("package.json description must fit the registry's 100 characters");

async function listFromBundle(): Promise<{ tools: Array<{ name: string; description: string }> }> {
  const child = spawn(process.execPath, [BUNDLE], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, HELIUS_API_KEY: "listing-only", COIN_SCOUT_ENV_FILE: "/dev/null" },
  });
  const reply = new Promise<{ tools: Array<{ name: string; description: string }> }>((resolve, reject) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === 1) message.result ? resolve(message.result) : reject(new Error(line));
    });
    child.on("exit", (code) => reject(new Error(`bundle exited with ${code} before listing tools`)));
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } })}\n`);
  try {
    return await reply;
  } finally {
    child.kill();
  }
}

const { tools } = await listFromBundle();

const manifest = {
  manifest_version: "0.3",
  name: "coin-scout",
  display_name: "Coin Scout",
  version: pkg.version,
  description: pkg.description,
  author: { name: "coin-scout contributors", url: REPO },
  repository: { type: "git", url: `${REPO}.git` },
  homepage: REPO,
  documentation: `${REPO}#readme`,
  support: `${REPO}/issues`,
  license: pkg.license,
  keywords: pkg.keywords,
  privacy_policies: [
    "https://www.helius.dev/privacy-policy",
    "https://defillama.com/privacy-policy",
    "https://wormhole.com/pages/data-protection-and-privacy-policy",
    "https://app.debridge.finance/assets/files/debridge_privacy_policy.pdf",
    "https://mayan.finance/privacy-policy",
    "https://www.circle.com/legal/privacy-policy",
    "https://docs.dexscreener.com/privacy/privacy-policy",
    "https://eaas.blockscout.com/privacy-notice",
  ],
  server: {
    type: "node",
    entry_point: "server/coin-scout.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/coin-scout.mjs"],
      env: {
        HELIUS_API_KEY: "${user_config.helius_api_key}",
        ETHERSCAN_API_KEY: "${user_config.etherscan_api_key}",
      },
    },
  },
  user_config: {
    helius_api_key: {
      type: "string",
      title: "Helius API key",
      description: "Free at https://www.helius.dev. Sent only to Helius.",
      sensitive: true,
      required: true,
    },
    etherscan_api_key: {
      type: "string",
      title: "Etherscan API key (optional)",
      description: "Free at https://etherscan.io/apis. Lets EVM tracing cover chains beyond Ethereum. Sent only to Etherscan.",
      sensitive: true,
      required: false,
    },
  },
  tools: tools.map(({ name, description }) => ({ name, description })),
  prompts_generated: true,
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: pkg.engines.node },
  },
};

rmSync(STAGE, { recursive: true, force: true });
rmSync(MCPB, { force: true });
mkdirSync(`${STAGE}/server`, { recursive: true });
copyFileSync(BUNDLE, `${STAGE}/server/coin-scout.mjs`);
writeFileSync(`${STAGE}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
execFileSync("zip", ["-q", "-X", "-9", "-r", "../coin-scout.mcpb", "manifest.json", "server"], { cwd: STAGE });

const sha256 = createHash("sha256").update(readFileSync(MCPB)).digest("hex");
const server = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.dennisyilmaz/coin-scout",
  title: "Coin Scout",
  description: pkg.description,
  repository: { url: REPO, source: "github" },
  version: pkg.version,
  packages: [
    {
      registryType: "mcpb",
      identifier: `${REPO}/releases/download/v${pkg.version}/coin-scout.mcpb`,
      fileSha256: sha256,
      transport: { type: "stdio" },
      environmentVariables: [
        {
          name: "HELIUS_API_KEY",
          description: "Helius API key, free at https://www.helius.dev",
          isRequired: true,
          isSecret: true,
        },
        {
          name: "ETHERSCAN_API_KEY",
          description: "Optional Etherscan API key for EVM tracing beyond Ethereum, free at https://etherscan.io/apis",
          isRequired: false,
          isSecret: true,
        },
      ],
    },
  ],
};
writeFileSync("build/server.json", `${JSON.stringify(server, null, 2)}\n`);

console.log(`${MCPB} (${tools.length} tools, sha256 ${sha256})\nbuild/server.json`);
