# Audit: Full Code Review -- September 2026

Date: 2026-09-22  
Commit: 135e174  
Version: v1.3.0  
Toolchain: Node v26.9.0 / npm 11.19.1 / @modelcontextprotocol/server 2.0.0 / @typesafe-ai/sdk 0.6.x / zod 4.x

## See Also

- [2026-09-21-mcp-server-review.md](2026-09-21-mcp-server-review.md) -- prior best-practice/performance/supply-chain/security review of v1.1.2
- [2026-09-20-dependency-supply-chain.md](2026-09-20-dependency-supply-chain.md) -- dependency supply-chain audit of v1.0.3

## Purpose

Point-in-time full static code review of `decisions-judge-mcp` v1.3.0, an MCP stdio server exposing a single `judge` tool backed by `@typesafe-ai/sdk`, with an opt-in Cloudflare Workers AI provider. Each finding was verified against the installed dependency sources rather than only public documentation, then remediated on main in the same session.

Scope:

- `server.mjs` (159 lines): MCP server bootstrap, provider selection, tool registration, Zod input/output schemas, question-spec validation.
- `providers/typesafe-api.mjs` (80 lines): default TypeSafe backend, envelope helpers, question construction.
- `providers/cloudflare-workers-ai.mjs` (185 lines): opt-in Cloudflare backend, retry policy, secret redaction, abort handling.
- `scripts/` (`demo.mjs`, `e2e.mjs`, `smoke.mjs`, `smoke-judge.mjs`) and `package.json`: reviewed for consistency with the shipped surface.

Validation baselines:

- `@typesafe-ai/sdk` 0.6.x source (timeout default in `index.mjs`, error construction, key handling).
- `@modelcontextprotocol/server` 2.0.0 typings (transport and tool registration surface).
- MCP specification revision 2026-07-28 (transport, authorization, annotations guidance).

## Methodology

Full static read of every runtime module, cross-checked against installed package sources (`node_modules/@typesafe-ai/sdk/dist/index.mjs`, `@modelcontextprotocol/server` typings) and the MCP 2026-07-28 specification. Each finding received an adversarial verification pass instructed to refute the claim before a remediation was proposed. Verdicts:

- **CONFIRMED**: the issue is real (severity or scope corrected during validation where noted).
- **REFUTED**: the claim does not hold against the installed code.
- **Non-issue**: reviewed and confirmed safe (recorded for traceability).

All 8 CONFIRMED findings were remediated on main via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52). Regression status at closure: `node --check` clean on all three runtime modules; `scripts/smoke.mjs` and `scripts/smoke-judge.mjs` passing; `markdownlint-cli2` clean on `docs/audit/**/*.md`.

---

## Summary Table

| # | Severity | Category | Location | Verdict | Resolution |
|---|----------|----------|----------|---------|------------|
| F1 | Low | Duplication | `server.mjs:82-92`, `providers/typesafe-api.mjs:24-38` | CONFIRMED | Resolved via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52) |
| F2 | Low | Duplication | `server.mjs:117-136`, `providers/typesafe-api.mjs:54-58,74-79` | CONFIRMED | Resolved via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52) |
| F3 | Low | Simplification | `providers/typesafe-api.mjs:62-66` | CONFIRMED | Resolved via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52) |
| F4 | Low | Simplification | `providers/cloudflare-workers-ai.mjs:103,115` | CONFIRMED | Resolved via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52) |
| F5 | Low | Duplication | `providers/cloudflare-workers-ai.mjs:44-50` | CONFIRMED | Resolved via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52) |
| F6 | Medium | Resource leak | `providers/cloudflare-workers-ai.mjs:104-114` | CONFIRMED | Resolved via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52) |
| F7 | Medium | Input hardening | `server.mjs:72-77` | CONFIRMED | Resolved via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52) |
| F8 | Medium | Input hardening | `server.mjs:52-56,73` | CONFIRMED | Resolved via [#52](https://github.com/clouatre-labs/decisions-judge-mcp/pull/52) |
| F9 | Medium (claimed) | Reliability | `providers/typesafe-api.mjs:62-66` | REFUTED | No action; see finding detail |
| F10 | High (claimed) | Secret leakage | `providers/cloudflare-workers-ai.mjs` | REFUTED | No action; see finding detail |
| F11 | Info | URL injection | `providers/cloudflare-workers-ai.mjs:17,78-80,95` | Non-issue | No action; accountId pre-validated |
| F12 | Info | Secret logging | `providers/cloudflare-workers-ai.mjs:24-34,82` | Non-issue | No action; `redactSecrets` covers error paths |
| F13 | Info | Performance | `providers/cloudflare-workers-ai.mjs:26-34` | Non-issue | No action; error-path only |
| F14 | Info | Connection hygiene | `providers/cloudflare-workers-ai.mjs:133-139` | Non-issue | No action; 429 body consumed pre-backoff |

---

## Finding Detail

### F1 -- CONFIRMED -- question-spec validation duplicated across server and provider

**Files:** `server.mjs:82-92`, `providers/typesafe-api.mjs:24-38`

Question-spec validation existed in two near-identical copies. Consolidated into one shared check path.

### F2 -- CONFIRMED -- triplicated fallback-envelope construction

**Files:** `server.mjs:117-136`, `providers/typesafe-api.mjs:54-58,74-79`

The fallback-envelope ternary appeared three times. Collapsed into `fallbackEnvelope` usage with a single message-normalization helper.

### F3 -- CONFIRMED -- three-branch options ternary unnecessary

**Files:** `providers/typesafe-api.mjs:62-66`

The SDK accepts `timeout: undefined` and falls back to its built-in 10 second default, so `{ timeout: timeout_ms, signal }` is always safe. Collapsed to a single expression.

### F4 -- CONFIRMED -- redundant pre-backoff abort check

**Files:** `providers/cloudflare-workers-ai.mjs:103,115`

The backoff promise already rejects on abort. Removed the redundant check.

### F5 -- CONFIRMED -- three-branch message coercion

**Files:** `providers/cloudflare-workers-ai.mjs:44-50`

Collapsed to a simpler shape-preserving coercion.

### F6 -- CONFIRMED -- abort listener leak in retry backoff

**Files:** `providers/cloudflare-workers-ai.mjs:104-114`

The abort listener added inside the retry backoff was never removed on the happy path. The leak was bounded (at most 2 retries) but is now cleaned up.

### F7 -- CONFIRMED -- no payload size cap on tool input

**Files:** `server.mjs:72-77`

A 256 KiB serialized-payload cap was added before provider dispatch.

### F8 -- CONFIRMED -- `__proto__` keys pass `z.record` validation

**Files:** `server.mjs:52-56,73`

`__proto__` keys pass `z.record` own-property enumeration and reach the provider payload. A deep own-property strip of prototype-polluting keys was added.

### F9 -- REFUTED -- claimed indefinite hang without `timeout_ms`

**Files:** `providers/typesafe-api.mjs:62-66`

Inspection of `@typesafe-ai/sdk` 0.6.x `index.mjs` shows the client applies a default timeout of 10 seconds when no explicit `timeout` option is supplied. The `timeout_ms` tool argument (capped at 60000 by `server.mjs:75`) can only lengthen, never remove, this bound. The tool never blocks indefinitely.

### F10 -- REFUTED -- claimed `TYPESAFE_API_KEY` leakage into fallback error strings

**Files:** `providers/cloudflare-workers-ai.mjs`

Review of SDK error construction shows HTTP status and response text are surfaced, never request headers. The API key appears only in the `Authorization` header and is not interpolated into any error message or log line in this repository.

### F11 -- Non-issue -- URL injection via `accountId`

**Files:** `providers/cloudflare-workers-ai.mjs:17,78-80,95`

`accountId` is pre-validated against a 32-hex-character regex both at startup (`server.mjs:43`) and inside `cloudflareJudge` before any URL interpolation.

### F12 -- Non-issue -- secret logging

**Files:** `providers/cloudflare-workers-ai.mjs:24-34,82`

The token value is never logged; every surfaced error string passes through `redactSecrets`, which replaces token and account id values with `[redacted]`.

### F13 -- Non-issue -- `redactSecrets` regex cost

**Files:** `providers/cloudflare-workers-ai.mjs:26-34`

`redactSecrets` runs only on the error path, never on the success hot path; regex construction cost is irrelevant there.

### F14 -- Non-issue -- connection hygiene on 429 retry

**Files:** `providers/cloudflare-workers-ai.mjs:133-139`

The 429 response body is fully consumed (or its stream cancelled) before backoff, avoiding socket leaks across retries.

---

## Security Posture Summary

- **Secrets handling.** `CLOUDFLARE_API_TOKEN` and `TYPESAFE_API_KEY` are read from the environment and used exclusively for authentication. The Cloudflare token and account id are redacted from every surfaced error string via `redactSecrets` (`providers/cloudflare-workers-ai.mjs:26-34`); the Typesafe key never enters any message path.
- **Redaction scope.** Redaction is applied to Cloudflare error-envelope messages and unexpected-envelope errors. It is error-path-only, so there is no hot-path cost, and it is escape-aware (literal matching via `escapeRegExp`).
- **Input validation.** The tool input is fully schema-validated with Zod (`server.mjs:52-77`): `state` must be object, array, or string; `questions` keys are non-empty strings with typed specs; `timeout_ms` is a positive integer capped at 60000. Question criteria shape is validated per type before any provider call, so malformed questions never produce an API request. A 256 KiB payload cap (F7) and a deep `__proto__` strip (F8) were added as hardening.
- **Provider selection.** `JUDGE_PROVIDER` is explicit-only, read once at startup, and validated against a whitelist (`server.mjs:28-35`); required credentials are checked at startup with clear non-empty and format constraints.
- **Annotations.** The tool declares `readOnlyHint: true` and `openWorldHint: true` (`server.mjs:149-153`). Per the MCP specification, annotations are hints from the server and are untrusted; clients must not rely on them for security decisions. This server's declaration is accurate to observed behavior, but consumers should treat it as advisory only.

## MCP 2026-07-28 Alignment

- **Transport.** The server uses `StdioServerTransport` (`server.mjs:158-159`), which remains the appropriate default transport for locally-launched clients (pi, Claude Code, goose). Revision 2026-07-28 of the MCP specification removed protocol-level session management and SSE-based resumability, which makes stateless remote hosting materially simpler: a remote deployment can be a plain request/response HTTP endpoint without session affinity. Streamable HTTP was subsequently landed on main via [#53](https://github.com/clouatre-labs/decisions-judge-mcp/pull/53).
- **Authorization.** Remote deployments require authorization per the specification (OAuth 2.1 with protected-resource metadata). The recommended path for this server is to terminate authentication at an authenticating reverse proxy and keep the server itself credential-agnostic, rather than embedding OAuth machinery in the tool implementation. This remains the design constraint for the Streamable HTTP deployment story.

## Verification

Post-remediation verification (2026-09-22) re-confirmed F1-F8 as addressed against the current tree and F9-F14 as correctly dispositioned; see the Summary Table resolutions.

Commands run from the repository root during this review and remediation:

```sh
node --check server.mjs
node --check providers/typesafe-api.mjs
node --check providers/cloudflare-workers-ai.mjs
node scripts/smoke.mjs
node scripts/smoke-judge.mjs
npx markdownlint-cli2@0.23.1 'docs/audit/**/*.md'
```

Dependency versions verified during validation: `@typesafe-ai/sdk` 0.6.x and `@modelcontextprotocol/server` 2.0.0, as declared in `package.json`.
