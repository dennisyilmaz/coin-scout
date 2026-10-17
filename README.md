# coin-scout

A read-only MCP server that gives an AI agent deep, fast access to Solana on-chain data through [Helius](https://www.helius.dev) — built for financial analysis and fraud investigation.

Speaks the **2026-07-28** MCP revision (`@modelcontextprotocol/server` v2, stateless core, `server/discover`, cacheable `tools/list`). Ships both a stdio entry point and a Streamable HTTP entry point.

It never signs or submits transactions. `sendTransaction`, `requestAirdrop` and friends are rejected at the tool layer. The only thing it writes is your local case files.

## Quick start

```bash
npm install
cp .env.example .env      # put your Helius API key in HELIUS_API_KEY
npm run build
```

Register with Claude Code:

```bash
claude mcp add coin-scout --scope user -- node /absolute/path/to/coin-scout/build/index.js
```

Or in `claude_desktop_config.json` / any MCP client:

```json
{
  "mcpServers": {
    "coin-scout": {
      "command": "node",
      "args": ["/absolute/path/to/coin-scout/build/index.js"],
      "env": { "HELIUS_API_KEY": "your-key" }
    }
  }
}
```

### Share it as one file

```bash
npm run bundle        # writes build/coin-scout.mjs — the whole server, no node_modules needed
```

Send that file to someone with Node 20+ and Claude Code. They run `node coin-scout.mjs`, paste their Helius API key, restart Claude Code, and the tools are there. The file copies itself to `~/.coin-scout/` and registers itself at user scope.

Streamable HTTP instead of stdio:

```bash
npm run http          # binds 127.0.0.1:8787, GET /health for metrics
```

## Tools

### Analysis (composite — start here)

| Tool | What it answers |
| --- | --- |
| `analyze_wallet` | Portfolio value, holdings, wallet age, in/out flow shape, top counterparties, earliest funders, risk flags |
| `analyze_token` | Rug screen: live mint/freeze authority, metadata mutability, supply, FDV, holder concentration (top1 / top10 / HHI), 0-100 risk score |
| `trace_funds` | BFS fund-flow graph, forward or backward, up to 5 hops — nodes, weighted edges valued in USD at the time of each transfer, terminal sinks, circular flows. Stops at bridges and reports where the funds went |
| `follow_bridge` | Funds that left or entered Solana via Wormhole, deBridge or Mayan: other chain, recipient, amounts, destination-chain tx. Takes signatures, or an address to scan |
| `find_cluster` | From one wallet, discovers likely co-controlled wallets: fee payers, co-signers, rent destinations, shared or sole funders, same-slot activity, creation time. Scored, with signature evidence |
| `wallet_pnl` | Realized and unrealized PnL per token from swaps, priced at swap time. Flags sales of tokens never bought and, for one mint, who sent the tokens for free |
| `find_counterparties` | Every address a wallet transacted with, ranked, split by direction and per-mint volume |
| `compare_wallets` | Sybil / co-ownership test across 2-10 wallets: direct links, shared funders, counterparty Jaccard overlap, 0-100 link strength |
| `investigate_transaction` | One signature: enhanced parse, per-account balance deltas with USD at the time, rug screen on every mint involved, fee-payer profile |

### Case files

| Tool | What it does |
| --- | --- |
| `case_update` | Create a case or add a summary, address labels (with confidence and evidence signatures) and dated notes |
| `case_read` | List cases, read one, or search every case for an address before starting on it |
| `case_export` | Write `report.md` with Mermaid diagrams plus one standalone SVG fund-flow diagram per saved trace or cluster |

Pass `case: "<name>"` to `trace_funds`, `find_cluster` or `follow_bridge` to save the result into that case. Labels from any case show up in every tool's `label` field, so later investigations build on earlier ones. Cases live in `~/.coin-scout/cases/<name>/` as plain JSON.

### Data access

| Tool | Backed by |
| --- | --- |
| `chain_status` | `getEpochInfo` + `getPriorityFeeEstimate` |
| `get_balances` | DAS `getAssetsByOwner` with native balance and USD pricing |
| `get_account` | `getMultipleAccounts` (jsonParsed) with program labelling |
| `get_transactions` | Helius Enhanced Transactions — human-readable type, source, transfers, swap events |
| `get_transaction_raw` | `getTransaction` with logs, inner instructions, compute units |
| `get_transfers` | `getTransfersByAddress` — server-side counterparty / direction / mint / time filters, optional USD at the time of each transfer |
| `get_transaction_history` | `getTransactionsForAddress` — slot, time and status filters with cursor paging |
| `get_swaps` | Enhanced history filtered to `SWAP`, normalised into sold/bought legs plus a per-mint net summary |
| `get_token_holders` | DAS `getTokenAccounts` |
| `get_assets` / `search_assets` / `get_asset_activity` | Full DAS surface (NFTs, cNFTs, fungibles, Token-2022) |
| `solana_rpc` | Escape hatch for any read-only RPC or DAS method |
| `server_metrics` | Batch compression, cache hit rate, adaptive rate-limit state |

### Prompts

`investigate_address`, `screen_token`, `trace_stolen_funds` — each encodes an investigation order of operations.

## What makes it fast

Helius bills and rate-limits **per RPC call**, not per HTTP request, so raw parallelism just buys you 429s. The transport layer is built around that:

- **JSON-RPC micro-batching.** Calls issued within a 4 ms window are coalesced into one HTTP request. Measured on a 50-call `getTransaction` fan-out: **8 HTTP requests instead of 50, 2.2x faster wall clock.**
- **Adaptive batch sizing.** A batch that gets 429'd is halved and the un-answered calls are requeued rather than failed; the size grows back on sustained success. Empirically the API accepts batches of 20 but rejects 50.
- **Cost-aware adaptive rate limiting.** Request spacing scales with the *number of calls* in a request, so a 20-call batch is spaced like 20 calls. Concurrency halves and spacing doubles on each 429, then decay back. `server_metrics` reports the converged rate.
- **HTTP/2 + keep-alive** over an `undici` pool — no TLS handshake per call.
- **Two-tier TTL cache with in-flight coalescing.** Finalized transactions and blocks cache for hours; balances for seconds. Concurrent identical calls share one promise.
- **Narrow payloads.** Tools return one compact JSON document rather than raw node responses — the biggest lever on agent latency is tokens, not milliseconds.

## Configuration

All optional except the API key. See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HELIUS_API_KEY` | — | Required |
| `HELIUS_NETWORK` | `mainnet` | `mainnet` or `devnet` |
| `HELIUS_MAX_CONCURRENCY` | 24 | Ceiling on in-flight HTTP requests |
| `HELIUS_MAX_BATCH_SIZE` | 20 | Upper bound for JSON-RPC batching |
| `HELIUS_BATCH_WINDOW_MS` | 4 | Coalescing window |
| `HELIUS_HTTP2` | true | Disable to force HTTP/1.1 |
| `HELIUS_MAX_RETRIES` | 6 | Retries for single (non-batched) requests |
| `HELIUS_CACHE_ENTRIES` | 20000 | LRU capacity |
| `COIN_SCOUT_MAX_TRACE_NODES` | 400 | Hard cap on `trace_funds` graph size |
| `COIN_SCOUT_MAX_PAGES` | 20 | Hard cap on pagination loops |
| `COIN_SCOUT_CASES_DIR` | `~/.coin-scout/cases` | Where case files are stored |

## Development

Helius bills per RPC call, and `trace_funds` / `analyze_wallet` fan out to hundreds of calls each — the live scripts below spend real credits, `bench` and `validate` most of all.

```bash
npm run typecheck      # tsc --noEmit          — free
npm test               # 43 unit tests         — free, no network
npm run dev            # stdio server via tsx
npm run verify-fixes   # ~4 calls  — regression check on get_swaps / get_asset_activity
npm run smoke          # ~15 calls — one hit per Helius endpoint used
npm run stdio-load     # ~30 calls — 12 concurrent tools/call over stdio
npm run validate       # heavy     — the original 20 tools + concurrent load
npm run bench          # heavy     — 3x50-call fan-outs, batching/cache benchmark
```

`scripts/e2e.ts` drives the running HTTP server through every tool over real MCP JSON-RPC:

```bash
npm run http &
npx tsx scripts/e2e.ts
```

## Accuracy notes

- Analysis tools sample recent history. When a result carries `truncated` or `sampleTruncated`, its counts are lower bounds — raise `transferSample` for more coverage.
- Current USD values come from Helius pricing and `usdAtTime` values from DefiLlama historical prices; both cover actively traded tokens only. A missing price means unknown, not zero.
- `wallet_pnl` only knows what the swaps in its sample show. Tokens that arrived by transfer or before the sample have no cost basis; their sales are reported as `unmatchedProceedsUsd` rather than realized PnL.
- `find_cluster` looks one funder up from the seed. Run it again on a strong member to go further.
- Bridge resolution covers Wormhole, deBridge and Mayan. deBridge can only be followed outbound; chains the server does not recognise are shown by raw chain id.
- Bridge lookups send transaction signatures to WormholeScan, deBridge and Mayan; `usdAtTime` lookups send mint addresses and timestamps to DefiLlama. None of these need an API key.
- `analyze_token` scans up to 1000 token accounts. `holderAccountsExact` tells you whether the holder count is the real total or a floor.
- Risk flags and scores are heuristics for triage. They point an investigation at the right transactions; they are not a verdict.
