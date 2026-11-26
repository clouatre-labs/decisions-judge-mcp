# Audit: aptu.dev Integration, Clef, and Transport -- November 2026

Date: 2026-11-25  
Commit: 8623dfc (main)  
Version: v1.8.0  
Toolchain: Node v26.13.1 / @modelcontextprotocol/server 2.4.0 / @typesafe-ai/sdk 0.7.0 / zod 4.6.7 / model jev-1.14.0

## See Also

- [2026-11-15-optimization-review.md](2026-11-15-optimization-review.md) -- findings 3, 4, 9 (box/images, HTTP transport, Cloudflare provider)
- Issue #119 (removal of box/images, HTTP transport, key rotation), #121 (serveStdio, Cloudflare pin)
- aptu-dev/aptu.dev: `workers/x402/src/judge.ts`, `workers/mcp/src/{index,tools}.ts`

## Purpose

Decide how decisions-judge-mcp should integrate with aptu.dev's paid `/v1/judge` (Cloudflare Clef over x402) and its `/mcp` endpoint; whether to offer a Streamable HTTP transport, x402, Clef, or unused Jev features; and what makes the judge leaner, faster, and more accessible. Only changes that add measured or verified value proceed.

## Methodology

1. **Live tree**: `server.mjs`, `providers/*.mjs`, `package.json`, installed package exports; aptu.dev `server.json`, `wrangler.toml`, `workers/mcp`, `workers/x402/src/judge.ts`, `src/lib/x402.ts`.
2. **Vendor docs fetched 2026-11-25**: `docs.typesafe.ai/{llms.txt,models.md}`, `developers.cloudflare.com/workers-ai/models/clef`, `developers.cloudflare.com/workers-ai/platform/pricing`, `blog.cloudflare.com/clef-decision-models`, `modelcontextprotocol.io/specification/latest` (redirects to 2026-07-28), npm registry versions.
3. **Three read-only research agents** (Clef, Jev, MCP/x402), each claim re-checked against a primary source where marked.
4. **Judge gate** (jev-1.14.0, three passes, 3,598 input tokens total): each candidate scored for KISS, user value, and do-or-defer. Probabilities quoted inline; the final pass is authoritative because it carried the removal history from the 2026-11-15 audit.

Verdicts: **CONFIRMED** (live source or tree), **PARTIAL** (holds in part or impact unmeasured), **REFUTED** (does not hold).

## Verified Baseline

| Surface | Transport | Model | Payment | Images |
| --- | --- | --- | --- | --- |
| decisions-judge-mcp v1.8.0 | stdio | jev-1.14.0 (SDK) or `typesafe/jev-1.14.0` (Workers AI REST) | caller's key | local PNG/JPEG, Jev only |
| aptu.dev `/mcp` | Streamable HTTP, stateless, JSON | `@cf/cloudflare/clef` via x402 proxy to `/v1/judge` | $0.005 USDC, Base or Solana | none |

- Jev 1.14.0 is current (released 2026-10-14): $0.042/Mtok, 64k request / 32k question, Box new in 1.14, 262k via `TypeSafe-Danger-Zone-Long-Context`. SDK 0.7.0 is latest.
- Clef (Cloudflare in-house, Apache 2.0 weights, 2026-10-01): same System One request shape, `model` selector required, 1 to 64 questions, max 4 embedded images, 65,536 context, no `box`, rolling alias with no version pin. Pricing page: clef $0.240, clef-flash $0.038, clef-omni $0.150 per Mtok. Blog latency table: Clef 209.3 ms median, clef-flash 38.8 ms, Jev 524.1 ms. TypeSafe docs do not mention Clef.
- MCP spec latest is 2026-07-28: Streamable HTTP is stateless; stdio stays first-class. `createMcpHandler` and `serveStdio` share one factory in SDK 2.4.0, which also exports `originValidationResponse`, `hostHeaderValidationResponse`, and `requireBearerAuth`.
- No mainstream MCP client pays x402 automatically; ChatGPT connectors are OAuth-only and cannot send static headers (mcptest.io matrix, secondary source).
- The zod `questionSpec` and `questionsSchema` in aptu.dev `workers/x402/src/judge.ts` are a hand copy of this repo's; nothing enforces equality, and the paid path adds a 25-question cap the free path lacks.

## Findings

### 1. Streamable HTTP in this repo: defer (CONFIRMED, low now)

Removed on 2026-11-15 (#119) for zero usage in 1,572 calls and a missing `Origin` check. A secure re-add is about 40 lines with the SDK validators, but the package has no host and aptu.dev already serves `/mcp`. Judge: re-add now 0.32. **Action**: none; revisit when a host and a usage signal exist. If re-added, validate origin and host with the SDK helpers before `handler.fetch`.

### 2. Shared judge schema across both repos: do (CONFIRMED, high)

Two hand copies with no drift guard is the only verified defect in the integration. Judge: real drift risk 0.84; subpath export leaner than a new package 0.85; user value 1.89 of 2 (0.90 at top). **Action**: export `questionSpec`, `questionsSchema`, `entryType` from `decisions-judge-mcp/schema`; aptu.dev depends on the package and deletes its copies.

### 3. Clef as default on the Cloudflare provider: skip (CONFIRMED, low)

No version pin, no `box`, 5.7x Jev's price per Mtok; the provider is pinned to `typesafe/jev-1.14.0` by #121. Judge: switch 0.23 (first pass 0.75 without pricing facts), skip 0.74. clef-flash is reachable later through the `model` override with a two-line change (send the required `input.model`). **Action**: none.

### 4. x402 in the stdio server: skip (CONFIRMED)

Judge: 0.17. Payment belongs to the hosted path, which exists. **Action**: none.

### 5. Unused Jev features: box, URL images, long-context header (REFUTED as gaps)

Zero `box` and image calls in the measured corpus; p95 state is 2.3 KB against a 256 KiB cap; images remain beta. Judge: box 0.57, URL images risk 0.78, long-context 0.31. **Action**: none.

### 6. Automatic provider failover, aptu.dev importing the tool, description guidance (REFUTED)

Judge: failover YAGNI 0.56, importing the tool 0.34, description sentence 0.38 to 0.61 across passes. The never-blocking fallback envelope already covers failures. **Action**: none.

## Summary Table

| # | Candidate | Verdict | Judge | Action |
| --- | --- | --- | --- | --- |
| 1 | Streamable HTTP transport | CONFIRMED, defer | 0.32 | None |
| 2 | Shared schema via subpath export | CONFIRMED, high | 0.84 / 0.85 | Issue here, issue in aptu.dev |
| 3 | Clef as Cloudflare default | CONFIRMED, skip | 0.23 | None |
| 4 | x402 in stdio | CONFIRMED, skip | 0.17 | None |
| 5 | box, URL images, long context | REFUTED | 0.31 to 0.78 | None |
| 6 | Failover, tool import, description | REFUTED | 0.34 to 0.61 | None |

## Reproduction

```sh
# Baseline smoke (passes on 8623dfc)
node --check server.mjs && node scripts/smoke.mjs && node scripts/smoke-judge.mjs && node scripts/smoke-server.mjs

# Model and pricing
curl -s https://docs.typesafe.ai/models.md | grep -E 'jev-1\.1|Price'
curl -s https://developers.cloudflare.com/workers-ai/platform/pricing/index.md | grep clef
curl -s https://developers.cloudflare.com/workers-ai/models/clef/index.md | grep -E 'required|1 to 64|max 4'

# Spec version
curl -sI https://modelcontextprotocol.io/specification/latest | grep -i location

# SDK helpers for a future HTTP transport
node -e 'import("@modelcontextprotocol/server").then(m => console.log(typeof m.createMcpHandler, typeof m.originValidationResponse, typeof m.requireBearerAuth))'

# Duplicated schema (absolute path to the sibling checkout)
diff <(sed -n '/^const questionSpec/,/^});/p' server.mjs) \
  <(sed -n '/^const questionSpec/,/^});/p' ~/git/aptu-dev/aptu.dev/workers/x402/src/judge.ts)
```
