# Architecture

decisions-judge-mcp is a small MCP server exposing exactly one tool, `judge`,
over stdio. It answers typed questions about JSON application state using the
TypeSafe System One decision model (Jev).

## Module map

| Module | Role |
| --- | --- |
| `server.mjs` | Entry point (`bin`). MCP server over stdio (newline-delimited JSON-RPC via `serveStdio`); registers the `judge` tool and the prompt templates; validates question specs with zod before any provider call; enforces the 256 KiB payload limit; reads `JUDGE_PROVIDER` exactly once at startup. |
| `prompts.mjs` | Static, version-stamped decision-pattern prompt templates. Pure text builders — no execution, no network at resolution time. |
| `providers/typesafe-api.mjs` | Default backend. Sends state + typed questions to the TypeSafe API in one request via `@typesafe-ai/sdk`; owns image loading/validation, default model pin, and shared validation checks. |
| `providers/cloudflare-workers-ai.mjs` | Opt-in backend (`JUDGE_PROVIDER=cloudflare-workers-ai`). Runs Cloudflare's Clef decision model (default `@cf/cloudflare/clef`, a rolling alias with no version pin; a `clef` or `clef-flash` `model` override selects the same family) through Cloudflare Workers AI; minimal retry (429/transport only), fail-fast on auth errors, secret redaction in error strings. |
| `schema.mjs` | Zod question specs (`noul`/`choice`/`score`) and their caller-visible fix hints; shared with aptu.dev via the `decisions-judge-mcp/schema` package subpath. |
| `scripts/smoke.mjs`, `scripts/smoke-judge.mjs`, `scripts/smoke-server.mjs`, `scripts/e2e.mjs` | Smoke (MCP stdio initialize handshake), judge-contract (fallback envelope, no API key needed), server (stdio handshake, keyless fallback, schema subpath), and end-to-end tests against the real providers. |

## Data flow

1. **MCP client** (Claude Code, codex, goose, pi) sends a `judge` tool call
   over stdio with `{state, questions}` (plus optional `model`, `timeout_ms`,
   preview `images`).
2. **Validation** — zod schemas in `schema.mjs` check question specs
   (`noul`/`choice`/`score`) and emit caller-visible fix hints on malformed
   input; `server.mjs` enforces the payload cap — all before any network call.
3. **Provider** — the selected provider sends one request to the backend
   (TypeSafe API or Cloudflare Workers AI). Retries and timeouts are owned by
   the SDK or the provider's abort-aware policy; client disconnects abort
   in-flight requests.
4. **Response** — raw typed answers plus model/usage metadata are returned to
   the client. Any failure returns `{ fallback: true, error: "..." }` with
   exit code 0 — the judge never blocks the caller.

## Trust boundaries

- **No filesystem writes** — the server never writes to disk. The only file
  access is read-only loading of caller-supplied image paths, validated for
  PNG/JPEG magic bytes, dimensions, and size before upload.
- **No process execution** — no child processes are spawned at request time;
  prompts are pure text builders.
- **Credentials via environment only** — `TYPESAFE_API_KEY` (or Cloudflare's
  `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`) is read from the
  environment at startup; keys are never logged, and Cloudflare error strings
  are scrubbed of token and account-id values.
- **Stdio only** — the transport is local stdio; there is no network listener.
  The hosted remote endpoint (`aptu.dev/v1/judge`) is a separate deployment.
