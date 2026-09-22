# Code Review Audit Record

- **Repository:** decisions-judge-mcp
- **Version reviewed:** 1.3.0
- **Review type:** Full static code review
- **Date:** 2026
- **Status:** Complete

## 1. Scope and Methodology

This record documents a formal code review of decisions-judge-mcp v1.3.0, an MCP stdio server exposing a single `judge` tool backed by `@typesafe-ai/sdk`, with an opt-in Cloudflare Workers AI provider.

Files in scope for the static review:

- `server.mjs` (159 lines): MCP server bootstrap, provider selection, tool registration, Zod input/output schemas, question-spec validation.
- `providers/typesafe-api.mjs` (80 lines): default TypeSafe backend, envelope helpers, question construction.
- `providers/cloudflare-workers-ai.mjs` (185 lines): opt-in Cloudflare backend, retry policy, secret redaction, abort handling.
- `scripts/` (`demo.mjs`, `e2e.mjs`, `smoke.mjs`, `smoke-judge.mjs`) and `package.json`: reviewed for consistency with the shipped surface.

Findings were validated against the installed dependency sources rather than only public documentation:

- `@typesafe-ai/sdk` 0.6.x source (timeout default in `index.mjs`, error construction, key handling).
- `@modelcontextprotocol/server` 2.0.0 typings (transport and tool registration surface).
- MCP specification revision 2026-07-28 (transport, authorization, annotations guidance).

Each finding received one of three verdicts: CONFIRMED (the issue is real), REJECTED (the claim does not hold against the installed code), or REVISED (the issue is real but its severity or scope was corrected during validation).

## 2. Findings

| ID | Severity | Category | Location | Verdict | Disposition |
|----|----------|----------|----------|---------|-------------|
| F-01 | Low | Duplication | `server.mjs:82-92`, `providers/typesafe-api.mjs:24-38` | CONFIRMED | Fixed: question-spec validation consolidated into one shared check path |
| F-02 | Low | Duplication | `server.mjs:117-136`, `providers/typesafe-api.mjs:54-58,74-79` | CONFIRMED | Fixed: triplicated fallback-envelope ternary collapsed into `fallbackEnvelope` usage with a single message-normalization helper |
| F-03 | Low | Simplification | `providers/typesafe-api.mjs:62-66` | CONFIRMED | Fixed: three-branch options ternary collapsed; the SDK accepts `timeout: undefined` and falls back to its built-in 10 second default, so `{ timeout: timeout_ms, signal }` is always safe |
| F-04 | Low | Simplification | `providers/cloudflare-workers-ai.mjs:103,115` | CONFIRMED | Fixed: redundant pre-backoff abort check removed; the backoff promise already rejects on abort |
| F-05 | Low | Duplication | `providers/cloudflare-workers-ai.mjs:44-50` | CONFIRMED | Fixed: three-branch message coercion collapsed to a simpler shape-preserving coercion |
| F-06 | Medium | Resource leak | `providers/cloudflare-workers-ai.mjs:104-114` | CONFIRMED | Fixed: abort listener added inside the retry backoff was never removed on the happy path; leak is bounded (at most 2 retries) but is now cleaned up |
| F-07 | Medium | Input hardening | `server.mjs:72-77` | CONFIRMED | Fixed: no payload size cap on `state` or `questions`; a 256 KiB serialized-payload cap was added before provider dispatch |
| F-08 | Medium | Input hardening | `server.mjs:52-56,73` | CONFIRMED | Fixed: `__proto__` keys pass `z.record` own-property enumeration and reach the provider payload; deep own-property strip of prototype-polluting keys was added |
| F-09 | Medium | Reliability (claimed) | `providers/typesafe-api.mjs:62-66` | REJECTED | The claim that omitting `timeout_ms` causes an indefinite hang is false: the SDK has a built-in 10 second default timeout (`index.mjs`, timeout configuration), so the tool never blocks indefinitely |
| F-10 | High (claimed) | Secret leakage (claimed) | `providers/cloudflare-workers-ai.mjs` | REJECTED | The claim that `TYPESAFE_API_KEY` can leak into fallback error strings is false: SDK errors never embed the key value, and the key is only ever placed in the `Authorization` header |
| F-11 | Info | URL injection | `providers/cloudflare-workers-ai.mjs:17,78-80,95` | Confirmed non-issue | `accountId` is pre-validated against a 32-hex-character regex both at startup (`server.mjs:43`) and inside `cloudflareJudge` before any URL interpolation |
| F-12 | Info | Secret logging | `providers/cloudflare-workers-ai.mjs:24-34,82` | Confirmed non-issue | The token value is never logged; every surfaced error string passes through `redactSecrets`, which replaces token and account id values with `[redacted]` |
| F-13 | Info | Performance | `providers/cloudflare-workers-ai.mjs:26-34` | Confirmed non-issue | `redactSecrets` runs only on the error path, never on the success hot path; regex construction cost is irrelevant there |
| F-14 | Info | Connection hygiene | `providers/cloudflare-workers-ai.mjs:133-139` | Confirmed non-issue | The 429 response body is fully consumed (or its stream cancelled) before backoff, avoiding socket leaks across retries |

### Notes on rejected findings

- **F-09 (no-default-timeout hang):** inspection of `@typesafe-ai/sdk` 0.6.x `index.mjs` shows the client applies a default timeout of 10 seconds when no explicit `timeout` option is supplied. The `timeout_ms` tool argument (capped at 60000 by `server.mjs:75`) can only lengthen, never remove, this bound.
- **F-10 (TYPESAFE_API_KEY leakage):** review of SDK error construction shows HTTP status and response text are surfaced, never request headers. The API key appears only in the `Authorization` header and is not interpolated into any error message or log line in this repository.

## 3. Security Posture Summary

- **Secrets handling.** `CLOUDFLARE_API_TOKEN` and `TYPESAFE_API_KEY` are read from the environment and used exclusively for authentication. The Cloudflare token and account id are redacted from every surfaced error string via `redactSecrets` (`providers/cloudflare-workers-ai.mjs:26-34`); the Typesafe key never enters any message path.
- **Redaction scope.** Redaction is applied to Cloudflare error-envelope messages and unexpected-envelope errors. It is error-path-only, so there is no hot-path cost, and it is escape-aware (literal matching via `escapeRegExp`).
- **Input validation.** The tool input is fully schema-validated with Zod (`server.mjs:52-77`): `state` must be object, array, or string; `questions` keys are non-empty strings with typed specs; `timeout_ms` is a positive integer capped at 60000. Question criteria shape is validated per type before any provider call, so malformed questions never produce an API request. A 256 KiB payload cap and a deep `__proto__` strip were added as hardening.
- **Provider selection.** `JUDGE_PROVIDER` is explicit-only, read once at startup, and validated against a whitelist (`server.mjs:28-35`); required credentials are checked at startup with clear non-empty and format constraints.
- **Annotations.** The tool declares `readOnlyHint: true` and `openWorldHint: true` (`server.mjs:149-153`). Per the MCP specification, annotations are hints from the server and are untrusted; clients must not rely on them for security decisions. This server's declaration is accurate to observed behavior, but consumers should treat it as advisory only.

## 4. MCP 2026-07-28 Alignment

- **Transport.** The server uses `StdioServerTransport` (`server.mjs:158-159`), which remains the appropriate default transport for locally-launched clients (pi, Claude Code, goose). Streamable HTTP for remote hosting is tracked as a follow-up. Revision 2026-07-28 of the MCP specification removed protocol-level session management and SSE-based resumability, which makes stateless remote hosting materially simpler: a remote deployment can be a plain request/response HTTP endpoint without session affinity.
- **Authorization.** Remote deployments require authorization per the specification (OAuth 2.1 with protected-resource metadata). The recommended path for this server is to terminate authentication at an authenticating reverse proxy and keep the server itself credential-agnostic, rather than embedding OAuth machinery in the tool implementation. This is noted as the design constraint for the future Streamable HTTP follow-up.

## 5. Verification

Commands run from the repository root during this review and remediation:

```sh
node --check server.mjs
node --check providers/typesafe-api.mjs
node --check providers/cloudflare-workers-ai.mjs
node scripts/smoke.mjs
node scripts/smoke-judge.mjs
npx markdownlint-cli2@0.23.1 'docs/audit/**/*.md'
```

Results:

- `node --check` passed for all three runtime modules (syntax valid, Node 20+ target).
- `scripts/smoke.mjs` passed: server starts, tool list and schema shape are correct.
- `scripts/smoke-judge.mjs` passed: end-to-end judge calls return well-formed envelopes for both providers (mocked network where applicable).
- `markdownlint-cli2` passed with no findings on `docs/audit/**/*.md`.

Dependency versions verified during validation: `@typesafe-ai/sdk` 0.6.x and `@modelcontextprotocol/server` 2.0.0, as declared in `package.json`.
