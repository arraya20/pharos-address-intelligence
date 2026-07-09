---
name: pharos-address-intelligence
description: >
  Read-only address intelligence for Pharos L1. Point at any address and get:
  EOA-vs-contract detection, native (PHRS/PROS) + ERC-20 token holdings, sent-tx
  count, best-effort activity (first/last seen, protocol interactions), a behavioral
  classification (EOA: New/Casual/Active/Whale/Bot/MEV/Dormant; Contract: Token/DEX/Protocol/Unknown),
  and a deterministic 0-100 risk score with evidence. Pure on-chain analysis via
  JSON-RPC; explorer API used only for best-effort enrichment. No private key, no
  transactions, no gas. Triggers: "analyze address", "who is this address",
  "check this wallet", "is this address safe", "EOA or contract", "address risk",
  "token holdings", "protocol interactions".
metadata:
  openclaw:
    homepage: https://github.com/arraya20/pharos-address-intelligence
---

# Pharos Address Intelligence

Read-only profiling for any address on Pharos L1. Answers the question the
`pharos-contract-inspector` skill leaves open: *"who is this address?"* — is it an
EOA or a contract, what does it hold, how does it behave, and should I trust it?

This skill is fully **executable**: the agent calls a CLI or HTTP API, not ad-hoc
commands. All core signals come from JSON-RPC so it works even when the explorer
API is rate-limited; the explorer is used only for optional enrichment and degrades
gracefully.

## When to load

- "Analyze address 0x..." on Pharos
- "Who is this address?" / "Is this address safe?"
- Before sending value to an unknown counterparty (agent pre-flight check)
- Classifying a destination as EOA vs contract before a payment
- Auditing a wallet's DeFi footprint

## Prerequisites

- **Node.js ≥ 18** (global `fetch` required)
- No runtime npm dependencies

## Quick Start (CLI)

```bash
# Inspect an address on Atlantic testnet (default)
node inspect.js 0x000000000022D473030F116dDEE9F6B43aC78BA3 --network testnet

# Inspect on Pacific mainnet
node inspect.js 0x000000000022D473030F116dDEE9F6B43aC78BA3 --network mainnet

# Machine-readable JSON output
node inspect.js 0xYourAddress --network mainnet --json

# Skip explorer enrichment (pure RPC, fastest, partial confidence)
node inspect.js 0xYourAddress --network mainnet --offline
```

`--offline` skips explorer enrichment only. The CLI still needs network access to
the configured Pharos RPC endpoint for address type, balances, token holdings,
and nonce.

## Quick Start (HTTP API)

```bash
# Start server (127.0.0.1:8800)
npm run serve

# Analyze via HTTP
curl -X POST http://127.0.0.1:8800/analyze \
  -H 'Content-Type: application/json' \
  --data '{"address":"0x000000000022D473030F116dDEE9F6B43aC78BA3","network":"mainnet","offline":true}'

# Health check
curl http://127.0.0.1:8800/health
```

For hosted deployments, set `HOST=0.0.0.0` behind a trusted platform/proxy and
configure `CORS_ORIGIN`, `RATE_LIMIT_MAX`, `MAX_BODY_BYTES`,
`REQUEST_TIMEOUT_MS`, and `CACHE_TTL_MS` for the expected traffic profile.

## What It Reports

| Section | Source | Always available? |
| --- | --- | --- |
| Address type (EOA/Contract) + bytecode size | `eth_getCode` | ✅ RPC |
| Native balance (PHRS/PROS) | `eth_getBalance` | ✅ RPC |
| ERC-20 token holdings | `eth_call balanceOf` on known tokens | ✅ RPC |
| Sent-tx count (nonce) | `eth_getTransactionCount` | ✅ RPC |
| Activity: first/last seen, tx count, protocols | Explorer API | ⚠️ best-effort |
| Classification label (EOA/Contract + subtype) | Derived from above | ✅ (partial if activity missing) |
| Risk score 0-100 + level + factors | Derived (see matrix) | ✅ (conservative if activity missing) |

> **Confidence:** when the explorer API is unavailable, the report still returns
> full RPC-based signals but flags `confidence: partial`, applies a +15
> uncertainty penalty, and floors the risk score at MODERATE (25). As of Jul 2026
> the Pharos explorer REST API is down, so the tool runs in RPC-only mode; token
> holdings use the verified [Pharos token registry](https://docs.pharos.xyz/getting-started/token-registry).

## Network Configuration

Read from `assets/networks.json` (RPC URLs, chain IDs, explorer API):

| Network | RPC | Chain ID | Native | Explorer API |
| --- | --- | --- | --- | --- |
| Atlantic Testnet | `https://atlantic.dplabs-internal.com` | 688689 | PHRS | `atlantic.pharosscan.xyz/api/v2` |
| Pacific Mainnet | `https://rpc.pharos.xyz` | 1672 | PROS | `www.pharosscan.xyz/api/v2` |

## Risk Scoring Matrix

Deterministic, evidence-based (no ML). Summary of factors:

| Factor | Impact | Condition |
| --- | --- | --- |
| Empty balance (no native + no tokens) | +15 | 0 holdings |
| No transaction history | +10 | nonce 0, no tx |
| Very new address | +10 | age < 7 days |
| Unverified contract | +20 | no verified source / unknown pattern |
| High-frequency bot pattern | +10 | >100 tx/day |
| Dormant + large balance | +5 | no activity >30d, balance >100 |
| Single-protocol interaction | +5 | 1 contract only |
| Verified contract | -10 | source visible |
| Long history (>90 days) | -10 | established |
| 3+ protocol diversity | -5 | diversified |
| Active consistent pattern | -5 | regular activity |

Outputs a level: `LOW` (0-20), `MODERATE` (21-40), `ELEVATED` (41-60), `HIGH` (61-80), `CRITICAL` (81-100).

> When the explorer API is unavailable, a +15 uncertainty penalty is applied and
> the score is floored at MODERATE (25) — an unverified-history address is never
> rated LOW. See `references/address-intel.md` §9 for details.

## Classification Labels

- **EOA:** New · Casual · Active · Whale · Bot · MEV · Dormant
- **Contract:** Token · DEX · Protocol · Unknown (unverified)

## Agent Guidelines

1. Validate address: `0x` + 40 hex chars.
2. Pick network (default Atlantic testnet) if not specified.
3. Call the CLI or HTTP API — do not hand-craft `cast` commands.
4. Present the structured report; always end with the disclaimer.
5. Use the risk level for the recommendation, never a binary safe/unsafe verdict.

## Anvita Flow Packaging

Package the whole `pharos-address-intelligence/` folder, not just its contents.
The frontmatter `name` above intentionally matches the folder name exactly. Use:

```bash
npm run package:skill
```

Then upload `pharos-address-intelligence.zip` in the Anvita Flow Service Agent
console, run a debug session, complete the Agent Card, and publish after review.

## Security Reminders

- 100% read-only. Never requests or stores a private key.
- Never asks for token approvals or transfers.
- All analysis from public on-chain data.
- Risk scores are heuristics, not guarantees — always qualify them.

## Architecture

```
pharos-address-intelligence/
├── inspect.js            # CLI orchestrator
├── server.js             # Optional dependency-free HTTP API (port 8800)
├── package.json
├── lib/
│   ├── rpc.js            # JSON-RPC client (fetch-based, retry/backoff) — reused from pharos-contract-inspector
│   ├── analyze.js        # Signal collection (RPC + best-effort explorer)
│   └── report.js         # Classification, risk score, text/JSON formatting
├── assets/
│   ├── networks.json     # Pharos testnet/mainnet config
│   └── tokens.json       # Known ERC-20 registry per network
├── references/
│   └── address-intel.md  # Detailed operation reference
└── SKILL.md              # This file
```

## License

MIT-0 (No Attribution Required)
