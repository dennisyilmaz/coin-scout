# Contributing

Bug reports and pull requests are welcome. For security issues, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setup

```bash
npm ci
cp .env.example .env      # put your Helius API key in HELIUS_API_KEY
npm run build
```

## Checks

CI runs these on Node 22 and 24. Run them before opening a pull request:

```bash
npm run typecheck
npm test                  # unit tests, no network
npm run build && npm run bundle && npm run mcpb
npm audit --audit-level=moderate
```

`npm run bundle` writes the single-file server `build/coin-scout.mjs`; `npm run mcpb` packs it into `build/coin-scout.mcpb` with a manifest generated from the live tool list, and writes the MCP Registry entry `build/server.json`.

## Live scripts

Helius bills per RPC call, and `trace_funds` / `analyze_wallet` fan out to hundreds of calls each. These scripts spend real credits from the key in `.env`, `bench` and `validate` most of all.

```bash
npm run dev            # stdio server via tsx
npm run verify-fixes   # ~4 calls  — regression check on get_swaps / get_asset_activity
npm run smoke          # ~16 calls — one hit per Helius endpoint, plus a check that every program label is a real program
npm run stdio-load     # ~30 calls — 12 concurrent tools/call over stdio
npm run validate       # heavy     — the original 20 tools + concurrent load
npm run bench          # heavy     — 3x50-call fan-outs, batching/cache benchmark
```

`scripts/e2e.ts` drives the HTTP server through every tool over real MCP JSON-RPC:

```bash
npm run http &
npx tsx scripts/e2e.ts
```

## Releases

Maintainers do not bump versions by hand. `.github/workflows/release.yml` runs every Saturday at 14:00 UTC when `src/` or the dependencies changed, or on demand from the Actions tab. It reruns CI, stamps the version, builds the bundle, the `.mcpb` and an SBOM, attests build provenance, publishes the GitHub release and updates the MCP Registry entry.
