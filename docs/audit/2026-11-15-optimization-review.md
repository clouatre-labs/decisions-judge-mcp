# Audit: Optimization and KISS Review -- November 2026

Date: 2026-11-15  
Commit: 2ff7ac4 (main, unreleased changes since v1.6.1)  
Version: v1.6.1 (released) / main  
Toolchain: Node v26.13.1 / npm 11.20.0 / @modelcontextprotocol/server 2.4.0 (lockfile) / @typesafe-ai/sdk 0.7.0 / zod 4.x / model jev-1.14.0

## See Also

- [2026-10-23-image-noul-accuracy.md](2026-10-23-image-noul-accuracy.md) -- image/noul probe (box PASS, noul-on-image FAIL)
- [2026-09-22-code-review.md](2026-09-22-code-review.md) -- full code review of v1.3.0
- Issues #86 (Scorecard), #96 (OpenAI Decisions API provider), #98 (re-run image probe)

## Purpose

Find what moves the needle for decisions-judge-mcp under KISS: what to remove, what to fix, which TypeSafe SDK / Jev / Cloudflare / MCP spec features are unused, and whether real-world usage supports each surface. Usage is grounded in local agent logs (Claude Code, pi, vibe) and the coder skill JSONL logs.

## Methodology

Three independent read-only reviews, each grounding claims in file:line, command output, live API calls, or vendor docs fetched on 2026-11-15:

1. **Usage logs**: 1,572 `judge` calls extracted from `~/.claude/projects/*/*.jsonl`, `~/.pi/agent/sessions/**/*.jsonl`, `~/.vibe/logs/session/`, plus the coder classify log (`~/.local/state/var/coder-log/*.jsonl`, 378 lines) and outcome telemetry (`~/.local/share/coder-metrics.jsonl`, 41 lines). Aggregates only.
2. **SDK / model gap**: installed `node_modules/@typesafe-ai/sdk` 0.7.0 sources and types, docs.typesafe.ai, live TypeSafe and Cloudflare Workers AI calls.
3. **Code / MCP spec**: `server.mjs`, `providers/`, `scripts/`, CI workflows against MCP spec 2026-07-28 and the installed MCP SDK; test suite run on a fresh `npm ci`.

KISS/YAGNI calls on contested items were stress-tested with the `judge` tool (jev-1.14.0); probabilities are quoted inline.

Verdicts:

- **CONFIRMED**: reproduced against the live tree, installed packages, or a live call.
- **PARTIAL**: the claim holds in part, or its impact is unmeasured.
- **REFUTED**: the suspected issue does not reproduce.

## Usage Baseline

- **Volume**: 1,572 calls (Sep 203, Oct 537, Nov 1-15 811); pi 1,468 (93%), Claude Code 103, vibe 1.
- **Reliability**: server fallback rate 7.7%. Of 230 failures, 213 (93%) are malformed question specs (125 rejected by the harness schema, 88 by server validation); 12 provider failures, all on 2026-11-01 16:00-21:00 UTC. 78% of failures are followed by a successful retry.
- **Latency**: p50 314 ms, p95 865 ms; 3 calls above 5 s.
- **Shape**: 2 questions p50 (5 p95); state 859 B p50, 2.3 KB p95 (cap 256 KiB never approached). Kinds: noul 1,634, choice 1,623, score 231, **box 0**. **Images 0, Cloudflare 0, HTTP transport 0.** `timeout_ms` on 7 calls.
- **String state**: 1,397 of 1,468 pi calls send `state` as a JSON-encoded string, which reaches the model as an escaped blob.

## Findings

### 1. Caller errors are the dominant failure mode (CONFIRMED, high)

Most common mistakes: missing `type`, a single flat question instead of a named map, `choice`/`choices` instead of `criteria`. Validation errors do not say how to fix the spec. Judge: `error_hints` is the top lever at 0.96 versus removals 0.01 and spec upgrade 0.03.

**Action** (#120): return field-level fix hints in validation errors (e.g. `questions.foo: missing "type" (noul|choice|score)`); add one minimal example to the `questions` description.

### 2. JSON-string state is forwarded escaped (PARTIAL, med)

`server.mjs:16` accepts string state and forwards it unchanged. Answer-quality impact is unmeasured.

**Action** (#120): if a string state parses to an object or array, parse before forwarding. Measure the answer delta on a small replay set first.

### 3. box/images is unreleased, unused, beta, and buggy (CONFIRMED, med)

`box` is on main (`server.mjs`) but absent from the v1.6.1 tag. Zero calls use it. Images still require `TypeSafe-Danger-Zone-Images`; Cloudflare labels images and box beta; noul-on-image failed 6/10 (2026-10-23 audit). The asset map at `providers/typesafe-api.mjs:190` is keyed by the bare name (`img`) rather than the delimited reference (`<img>`); the API matches references as literal text (SDK `index.d.mts:198`, docs.typesafe.ai/images.md), so a live call with "img" in state injected the image 4 times (1,268 vs 536 input tokens) and degraded the box. Judge: remove 0.95, fix-and-ship 0.05.

**Action** (#119): revert box/images from main before the next release; keep `scripts/probe-images.mjs` and #98 to re-add once images leave beta. If kept instead, key assets as `` `<${name}>` ``.

### 4. HTTP transport lacks the spec-required Origin check (CONFIRMED, high)

MCP 2026-07-28 Streamable HTTP requires servers to validate `Origin` (DNS rebinding). A POST with `Origin: http://evil.example` returned 200 (`server.mjs:308-446`). No client config (Claude Code, goose, pi) uses HTTP. Judge: remove 0.74, fix 0.26.

**Action** (#119): remove the HTTP transport, `scripts/smoke-http.mjs`, the routing test in `smoke-judge.mjs`, and the README section (about 540 lines). If kept, call the SDK's exported origin and host validation helpers before `handler.fetch`.

### 5. Key rotation removes rate-limit retry for single-key users (CONFIRMED, med)

`providers/typesafe-api.mjs:56` sets `httpStatuses: [408, 500, 502, 503, 504]` and `respectRetryAfter: false`, so 429 and 529 get one attempt (SDK default: 408, 429, 500-599 with backoff). TypeSafe rate limits are per organization, so rotating keys within one organization does not help. All observed configs use one key. The `server.mjs:28` comment calling `TYPESAFE_API_KEY_2..9` "SDK standard" is wrong. Judge: remove 0.78.

**Action** (#119): drop `parseKeys`, the client cache, and rotation (about 120 lines); one `TypeSafeClient({ logLevel: "off" })` with SDK default retry.

### 6. stdio does not negotiate MCP 2026-07-28 (CONFIRMED, high)

`server/discover` returns "Method not found" on stdio (`server.mjs:446-450`); the installed SDK's `serveStdio(factory)` handles it and keeps older clients working.

**Action** (#121): replace the manual `StdioServerTransport` wiring with `serveStdio(() => buildServer())`; add one smoke check for `server/discover`.

### 7. `timeout_ms` is per attempt, not per request (CONFIRMED, med)

Described as a per-request cap (`server.mjs:166`) but passed as the SDK per-attempt timeout (`index.d.mts:231`: no total budget). Probe: `timeout_ms=200` took 1,900 ms over 3 attempts; 60,000 can reach about 181 s.

**Action** (#121): pass `signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout_ms)])`.

### 8. Failures never set `isError` (CONFIRMED, med)

The spec expects tool execution errors to set `isError: true`; the fallback envelope never does (`providers/typesafe-api.mjs:70-95`).

**Action** (#121): set `isError: true` in the fallback envelope, keeping the `{fallback, error}` payload.

### 9. Cloudflare provider is unused and drifted (PARTIAL, low, owner decision)

`providers/cloudflare-workers-ai.mjs:104` defaults to `typesafe/jev`, which resolved to jev-1.13.0 live; `typesafe/jev-1.14.0` exists. A bare `jev-1.14.0` override fails there ("No such model"). Pricing $0.042 per million input tokens, 32k context (64k direct). Cloudflare also lists its own Jev-compatible Clef models (not evaluated). Judge was split: remove 0.52, keep-and-pin 0.46, auto-failover 0.02.

**Action** (#121): owner decision. Recommended: keep and pin `typesafe/jev-1.14.0`, prefix bare `jev-*` overrides with `typesafe/`. Do not build failover.

### 10. Regressions and drift (CONFIRMED, low)

- 2026-09-22 F1/F3 regressed: question validation runs twice (`server.mjs:223`, `providers/typesafe-api.mjs:148`); request options built conditionally again (`providers/typesafe-api.mjs:206`).
- Output schema descriptions misstate noul and score answer shapes (`server.mjs:181`).
- `TYPESAFE_DEFAULT_MODEL` is silently ignored; zod does not enforce the API limits (score up to 10 levels, choice up to 255 options).
- `tools/list` is 4,506 B (about 1,127 tokens per session); the 510 B server instructions repeat the tool description.
- Local `node_modules` has MCP server 2.3.1 while the lockfile pins 2.4.0; run `npm ci`.

**Action** (#122): one cleanup PR after findings 3-5 land; trim descriptions once box is gone.

### 11. Model and performance status (REFUTED as gaps)

- jev-1.14.0 is current: `jev-latest` and `jev-preview` resolve to it; `jev-1.15.0` and `jev-2` return 400. The pin is correct.
- Connection reuse and zstd compression already work (first call 182 ms, then about 90 ms). Per-call server overhead is under 1 ms; stdio handshake about 80 ms.
- The upstream WAF 403 on "curl" in state (typesafe-sdk-js#15) did not reproduce.

### 12. Coder skill logs (CONFIRMED, out of repo)

The classify log is valid JSON (2 field violations in 378 lines) but has no timestamps, 19 undocumented stages (103 `plan_completeness`), margin disagreeing with probabilities in 32 of 164 tier lines, and `consistent` logged as a boolean in 50 of 83 premise lines. The judge changed the proposed tier in 18 of 164 cases (11%). coder-metrics has `gate_pass` null in 25 of 41 lines, 11 `role` spellings, and 6 task ids matching the classify log.

**Action** (coder skill, not this repo): add `ts` and `harness`; compute `margin` from `probabilities`; log `consistent` as the noul probability; normalize `role` and `task_ref`.

## Summary Table

| # | Finding | Verdict | Impact | Effort | Action |
| --- | --- | --- | --- | --- | --- |
| 1 | Caller spec errors dominate failures | CONFIRMED | high | S | Field-level fix hints |
| 2 | JSON-string state forwarded escaped | PARTIAL | med | S | Parse, measure first |
| 3 | box/images unreleased, unused, buggy | CONFIRMED | med | S | Revert before release |
| 4 | HTTP lacks Origin check, unused | CONFIRMED | high | S | Remove HTTP |
| 5 | Rotation disables 429/529 retry | CONFIRMED | med | S | Remove rotation |
| 6 | stdio lacks MCP 2026-07-28 | CONFIRMED | high | S | `serveStdio` |
| 7 | `timeout_ms` per attempt | CONFIRMED | med | S | `AbortSignal.any` |
| 8 | No `isError` on failures | CONFIRMED | med | S | Set in envelope |
| 9 | Cloudflare drifted to jev-1.13.0 | PARTIAL | low | S | Owner: pin or remove |
| 10 | Regressions and doc drift | CONFIRMED | low | S | One cleanup PR |
| 11 | Model, latency, WAF | REFUTED | -- | -- | None |
| 12 | Coder log hygiene | CONFIRMED | med | S | Coder skill fix |

## Recommended Order

1. **Subtract** (one PR each): revert box/images (#119), remove HTTP (#119), remove rotation (#119). Net about 800 fewer lines; resolves the Origin and retry findings by deletion.
2. **Caller ergonomics**: fix hints (#120), then string-state parsing behind a measured replay (#120).
3. **Spec and correctness**: `serveStdio`, total timeout, `isError` (#121), cleanup (#122).
4. **Release v1.7.0**, then decide Cloudflare (#121) and fix coder logging (12).

Not recommended: image-backed noul/choice/score (still beta, failed probe), Cloudflare failover, long-context header (p95 state is 2.3 KB), a second model pin.

## Reproduction

```sh
# Tests (fresh install)
npm ci && node --check server.mjs && node scripts/smoke.mjs && node scripts/smoke-judge.mjs && node scripts/smoke-http.mjs

# box absent from the release, present on main
git grep -c box v1.6.1 -- server.mjs; git grep -c box origin/main -- server.mjs

# Retry policy and asset key
sed -n 50,60p providers/typesafe-api.mjs; sed -n 187,192p providers/typesafe-api.mjs

# Origin check (HTTP transport)
JUDGE_TRANSPORT=http node server.mjs &
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/mcp \
  -H 'Origin: http://evil.example' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"a","version":"0"}}}'

# Judge call counts (Claude Code)
rg -c '"name":"mcp__decisions-judge__judge"' ~/.claude/projects --glob '*.jsonl' | awk -F: '{s+=$2} END {print s}'
```
