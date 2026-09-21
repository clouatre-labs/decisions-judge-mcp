# Audit: MCP Server Review (Best Practice, Performance, Supply Chain, Security) -- September 2026

Date: 2026-09-21  
Commit: dd2eb9f  
Version: v1.1.2  
Toolchain: Node v26.9.0 / npm 11.19.1 / @modelcontextprotocol/server 2.0.0 / @typesafe-ai/sdk 0.6.0 / zod 4.6.5

## See Also

- [2026-09-20-dependency-supply-chain.md](2026-09-20-dependency-supply-chain.md) -- prior supply-chain audit (F1 remediation re-verified here as F4)

## Purpose

Point-in-time review of `decisions-judge-mcp` v1.1.2 covering best practice, performance, supply chain, and security, superseding and re-verifying the 2026-09-20 dependency-supply-chain audit's F1-F4 against the current tree.

Scope: `server.mjs` (the entire tool surface), `package.json`/`package-lock.json`, `scripts/*.mjs`, `README.md`'s documented contract, and the installed `@modelcontextprotocol/server` and `@typesafe-ai/sdk` packages' own type definitions and source. No file changes made in this session.

## Methodology

Direct analysis of the local tree and installed packages: `server.mjs` read end to end; `@typesafe-ai/sdk` and `@modelcontextprotocol/server` inspected via their installed `dist/*.d.mts` type definitions and `dist/index.mjs` source (ground truth over training data, per project standards); `npm audit`, `npm view`, and `npm outdated` run against the live registry; a standalone reproduction script constructed a `TypeSafeClient` with a stubbed `fetch` to empirically verify logging behavior without requiring `TYPESAFE_API_KEY`; `node scripts/smoke.mjs` and `node scripts/smoke-judge.mjs` run to confirm current passing state. Verdicts:

- **CONFIRMED**: verified against the local tree or by direct reproduction.
- **RE-CONFIRMED**: a prior audit's finding re-verified against the current tree.

**Validation:** F1-F3 were independently re-verified post-audit by three separate review delegates, each re-deriving the evidence chain from the tree (server.mjs construction site, SDK/SDK-types line evidence, and a fresh empirical reproduction of the `TYPESAFE_LOG_LEVEL`-only vector for F1; SDK `.d.mts` types cross-checked against `scripts/e2e.mjs` and `scripts/smoke-judge.mjs` for F2; the deprecated overload's JSDoc in the installed `.d.mts` plus passing smoke runs for F3). All three verdicts: CONFIRMED, with minor line-reference corrections incorporated below.

## Findings

### F1 -- CONFIRMED -- SDK debug/info logging writes to stdout, corrupting MCP stdio framing

`server.mjs:64` (`return (client ??= new TypeSafeClient());`) constructs `new TypeSafeClient()` with no `logLevel` or `logger` override, so the SDK's default `consoleLogger` (`node_modules/@typesafe-ai/sdk/dist/index.mjs:259-264`) is used at whatever level `TYPESAFE_LOG_LEVEL` resolves to in the process environment (`ENV.logLevel`, read directly from `process.env`, `index.mjs:61`). `consoleLogger.debug` and `consoleLogger.info` call `console.debug`/`console.info`, which Node.js routes to **stdout**, not stderr (`console.warn`/`console.error` go to stderr). MCP stdio transport requires stdout to carry only newline-delimited JSON-RPC frames -- this repo's own `scripts/smoke.mjs`, `scripts/smoke-judge.mjs`, and `scripts/e2e.mjs` all implement that exact framing assumption (`buffer.split("\n")` + `JSON.parse`).

Reproduced directly: constructing a `TypeSafeClient` with `logLevel: "debug"` and a stubbed `fetch`, then calling `systemOne(...)`, prints a multi-line, non-JSON request/response dump to stdout (verified with output redirected separately to `/tmp/stdout.log` and `/tmp/stderr.log`; the dump appeared in stdout, nothing in stderr). The same occurs at `logLevel: "info"` (one `<- 200 in Nms` line per request). The decisive vector was re-confirmed in validation: setting **only** `TYPESAFE_LOG_LEVEL=debug` in the environment (no explicit option to the constructor) reproduces the full stdout dump, and the default (no env var, no options) is clean. The default level is `"warn"` (`DEFAULT_LOG_LEVEL`, `index.mjs:250`), which is safe (`console.warn`/`console.error` only) -- but that default is not pinned by `server.mjs`; it is inherited from whatever `TYPESAFE_LOG_LEVEL` the MCP host's environment happens to carry (a shared shell profile, a copied `.env`, or a host that sets it for its own debugging).

**Impact:** any environment where `TYPESAFE_LOG_LEVEL=debug` or `=info` is set silently corrupts the MCP stdio channel for every client of this server, not just judge calls -- the extraneous stdout lines interleave with JSON-RPC frames and break parsing for any MCP client using the standard newline-delimited-JSON read loop.

**Files:** `server.mjs:64`

**Fix:** Pin the client's log level or logger explicitly in `getClient()`, independent of `TYPESAFE_LOG_LEVEL`, e.g. `new TypeSafeClient({ logLevel: "off" })` (validation confirmed `"off"` is a supported `LogLevel`, `index.d.mts:194`) or a `logger` override whose `debug`/`info`/`warn`/`error` sinks all write to `process.stderr` (never `console.debug`/`console.info`). This closes the exposure regardless of what the hosting environment sets.

---

### F2 -- CONFIRMED -- README example response does not match the SDK's actual answer/usage shapes

`README.md:44-52` shows this example response for a `noul` question `ready_to_merge` and a `choice` question `next_step`:

```jsonc
{
  "answers": { "ready_to_merge": 0.93, "next_step": "merge" },
  "model": "jev-latest",
  "usage": { "requests": 1 },
  "fallback": false
}
```

This does not match the SDK's actual response types, verified against `node_modules/@typesafe-ai/sdk/dist/index.d.mts`:

- A `noul` answer is `NoulResponse { type: "noul", noul: number }` (`index.d.mts:87-91`), not a bare number. The correct shape is `"ready_to_merge": { "type": "noul", "noul": 0.93 }`.
- A `choice` answer is `ChoiceResponse { type: "choice", choice: string, confidence: number, probabilities: {...} }` (`index.d.mts:93-99`), not a bare string. The correct shape is `"next_step": { "type": "choice", "choice": "merge", "confidence": ..., "probabilities": {...} }`.
- `usage` is `Usage { input_tokens: number, output_tokens: number }` (`index.d.mts:121-124`), not `{ requests: 1 }`.

Validation confirmed the `model` and `fallback` fields in the example **are** correct (server.mjs:112-115 passes SDK answers through unchanged and adds the `fallback` boolean); only `answers` and `usage` are wrong.

This repo's own `scripts/e2e.mjs` asserts the correct shapes (`answers.is_bug?.noul`, `answers.team?.choice`, `usage.input_tokens`/`usage.output_tokens`), confirming the README example is stale relative to both the SDK and this repo's own test.

**Impact:** an integrator who codes against the README literally (e.g. `if (answers.ready_to_merge > 0.5)`) gets `undefined > 0.5` at runtime instead of the intended probability check.

**Files:** `README.md:44-52`

**Fix:** Update the example response to nest each answer under its typed shape and correct `usage`:

```jsonc
{
  "answers": {
    "ready_to_merge": { "type": "noul", "noul": 0.93 },
    "next_step": {
      "type": "choice",
      "choice": "merge",
      "confidence": 0.97,
      "probabilities": { "merge": 0.97, "iterate": 0.02, "escalate": 0.01 }
    }
  },
  "model": "jev-latest",
  "usage": { "input_tokens": 214, "output_tokens": 18 },
  "fallback": false
}
```

---

### F3 -- CONFIRMED -- `registerTool` uses a deprecated overload

The module-level schema objects at `server.mjs:31-35` (`inputSchema`) and `server.mjs:53-59` (`outputSchema`) are plain objects (`{state: ..., questions: ...}`, a `ZodRawShape`), not wrapped in `z.object({...})`, and are passed as-is to the `registerTool` call at `server.mjs:77`. `@modelcontextprotocol/server` 2.0.0's own type definitions (`node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts:3309-3310`) expose two `registerTool` overloads: a current one taking a `StandardSchemaWithJSON` (i.e., a `z.object(...)` instance), and a raw-shape one explicitly marked `/** @deprecated Wrap with z.object({...}) instead. ... */`. `server.mjs` uses the deprecated overload for both schemas.

This works correctly today -- confirmed by running `node scripts/smoke.mjs` and `node scripts/smoke-judge.mjs`, both passing (re-confirmed in validation) -- because the server auto-wraps raw shapes with `z.object()` internally. It is a forward-compatibility risk: the deprecated overload can be removed in a future `@modelcontextprotocol/server` major version. Validation additionally confirmed the fix is behavior-identical: zod 4.6.5 satisfies the non-deprecated `StandardSchemaWithJSON` overload, and `outputSchema` validation of `structuredContent` behaves the same either way.

**Files:** `server.mjs:31-35`, `server.mjs:53-59`

**Fix:** Wrap both schema objects: `z.object({ state: ..., questions: ..., timeout_ms: ... })` and `z.object({ answers: ..., model: ..., usage: ..., fallback: ..., error: ... })`.

---

### F4 -- RE-CONFIRMED -- Supply chain remains minimal and clean

Re-verified against the current lockfile and registry: production dependency closure is 4 packages (`@modelcontextprotocol/core`, `@modelcontextprotocol/server`, `@typesafe-ai/sdk`, `zod`), all resolved from `registry.npmjs.org`, none deprecated, all at the latest published version (`@modelcontextprotocol/server` 2.0.0, `@typesafe-ai/sdk` 0.6.0, `zod` 4.6.5). `npm audit` reports 0 vulnerabilities across all severities. `npm outdated` reports nothing outdated. This confirms the 2026-09-20 audit's F1 remediation (migration off the 95-package `@modelcontextprotocol/sdk` 1.x closure to `@modelcontextprotocol/server` 2.0.0) held, and F2-F4 from that audit (no lifecycle install scripts, clean publish posture, minimal direct-dependency surface) still apply unchanged.

**Files:** `package.json`, `package-lock.json`

**Fix:** None. Maintain current posture.

---

## Summary Table

*Table 1: Finding classification.*

| Finding | Severity | Verdict | Action |
|---|---|---|---|
| F1 SDK debug/info logging corrupts MCP stdio framing | High | CONFIRMED | pin `logLevel`/`logger` in `getClient()` -- [#30](https://github.com/clouatre-labs/decisions-judge-mcp/issues/30) |
| F2 README example response shape is wrong | Medium | CONFIRMED | fix example in `README.md` -- [#29](https://github.com/clouatre-labs/decisions-judge-mcp/issues/29) |
| F3 Deprecated `registerTool` raw-shape overload | Low | CONFIRMED | wrap schemas in `z.object({...})` -- [#28](https://github.com/clouatre-labs/decisions-judge-mcp/issues/28) |
| F4 Supply chain posture | -- | RE-CONFIRMED | maintain |

**Actionable in this repository:** 3 (F1 [#30](https://github.com/clouatre-labs/decisions-judge-mcp/issues/30), F2 [#29](https://github.com/clouatre-labs/decisions-judge-mcp/issues/29), F3 [#28](https://github.com/clouatre-labs/decisions-judge-mcp/issues/28)). **Upstream recommendation:** 0.

## Validation

Post-audit, three independent review delegates re-verified F1-F3 against the tree without access to this document's reasoning, each re-deriving evidence from `server.mjs`, the installed package sources/type definitions, and fresh empirical reproductions. All three findings were returned as CONFIRMED with no material inaccuracies; line-reference corrections (`server.mjs:64`, `index.d.mts` response types, `createMcpHandler-CLhGwQTn.d.mts:3309-3310`) and the clarifications noted inline above were incorporated from their reports. F4's supply-chain posture was not re-delegated (purely mechanical `npm audit`/`npm outdated` checks, already run against the live registry in this session).

## Sources

- Installed packages (ground truth): `node_modules/@typesafe-ai/sdk/dist/index.mjs` and `index.d.mts` (v0.6.0); `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts` (v2.0.0)
- Internal: `server.mjs`, `README.md`, `scripts/smoke.mjs`, `scripts/smoke-judge.mjs`, `scripts/e2e.mjs`, `package.json`, `package-lock.json`
- Live registry: `npm audit`, `npm outdated`, `npm view` (run 2026-09-21)

## Reproduction

```sh
# F1: reproduce stdout pollution at debug log level (from repo root, needs node_modules installed)
node -e '
import("@typesafe-ai/sdk").then(async ({ TypeSafeClient, noul }) => {
  const fakeFetch = async () => new Response(
    JSON.stringify({ model: "jev-latest", answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const client = new TypeSafeClient({ apiKey: "fake-key", logLevel: "debug", fetch: fakeFetch });
  await client.systemOne({ state: {}, questions: { q: noul("test?") } });
});
' 1>/tmp/stdout.log 2>/tmp/stderr.log
cat /tmp/stdout.log   # non-empty: request/response dump on stdout
cat /tmp/stderr.log   # empty

# F4 re-verification
npm audit
npm outdated
npm view @modelcontextprotocol/server version
npm view @typesafe-ai/sdk version
npm view zod version
```

Observed: `/tmp/stdout.log` contains the full request/response dump (headers with redacted `Authorization: Bearer ***`, body, and the parsed response body) across three log lines; `/tmp/stderr.log` is empty. `npm audit` reports 0 vulnerabilities; `npm outdated` prints nothing; all three packages report their latest published version as currently installed.
