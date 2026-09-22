# decisions-judge-mcp

[![CI](https://github.com/clouatre-labs/decisions-judge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/clouatre-labs/decisions-judge-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/decisions-judge-mcp.svg)](https://www.npmjs.com/package/decisions-judge-mcp)
[![REUSE status](https://api.reuse.software/badge/github.com/clouatre-labs/decisions-judge-mcp)](https://api.reuse.software/info/github.com/clouatre-labs/decisions-judge-mcp)

**Typed decisions for AI agents, as an MCP tool.** Ask yes/no probability (`noul`), choice among options, or score on ordered levels about any JSON application state. All questions answered in one fast request; failures return a `{fallback: true, error}` envelope instead of blocking, so it is safe to compose into agent workflows.

Currently backed by the [TypeSafe System One](https://typesafe.ai) model (Jev) via [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk), with an opt-in [Cloudflare Workers AI](https://developers.cloudflare.com/ai/models/typesafe/jev/) provider (`provider: "cloudflare"`) for users without a TypeSafe invite. The provider-neutral `judge` primitive maps naturally onto related decision APIs such as [OpenRouter alphadecisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request).

Flagship consumer: [`clouatre-labs/agentic-coder-skill`](https://github.com/clouatre-labs/agentic-coder-skill).

## Why

- **Programmable common sense**: judgment as a primitive your code can branch on, not a prompt-and-parse loop
- **Typed answers**: probabilities, options, and ordered levels, validated by schema
- **One request, many questions**: batch an entire decision tree in a single call
- **Never blocks**: fallback envelope on any failure keeps agents running

## Example

```jsonc
// judge tool call
{
  "state": { "tests": "passing", "lint": "clean", "filesChanged": 3 },
  "questions": {
    "ready_to_merge": {
      "type": "noul",
      "instructions": "Is this change safe to merge?"
    },
    "next_step": {
      "type": "choice",
      "instructions": "What should the agent do next?",
      "criteria": {
        "merge": "create the merge commit",
        "iterate": "keep refining the change",
        "escalate": "hand back to the human"
      }
    }
  }
}
```

```jsonc
// response
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

## Quickstart

Requires Node >= 20 and `TYPESAFE_API_KEY` in the environment.

```sh
# run on demand via npx (no global install)
npx -y decisions-judge-mcp

# or pin a version for supply-chain reproducibility
npx -y decisions-judge-mcp@1.0.2

# or install globally
npm i -g decisions-judge-mcp
```

> **Tip:** unpinned `npx -y decisions-judge-mcp` always runs the latest published
> version. For deterministic, supply-chain-hardened setups, pin an exact version
> or install globally and update deliberately.

## MCP client configuration

All examples use `npx -y`, the standard pattern for Node-based MCP servers. Swap in `decisions-judge-mcp@<version>` in the `args` if you prefer pinning.

**pi** (`~/.config/pi/mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "decisions-judge": {
      "command": "npx",
      "args": ["-y", "decisions-judge-mcp"],
      "env": { "TYPESAFE_API_KEY": "..." }
    }
  }
}
```

**Claude Code** (one command):

```sh
claude mcp add --scope user decisions-judge \
  --env TYPESAFE_API_KEY=... -- npx -y decisions-judge-mcp
```

**goose** (`~/.config/goose/config.yaml`):

```yaml
mcp:
  servers:
    decisions-judge:
      command: npx
      args:
        - -y
        - decisions-judge-mcp
      env:
        TYPESAFE_API_KEY: "..."
```

**Windows note:** some clients need `cmd /c npx` on Windows:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "decisions-judge-mcp"]
}
```

## Tool reference: `judge`

| Input | Type | Description |
| --- | --- | --- |
| `state` | object \| string \| array | JSON application state to judge |
| `questions` | map | name → question spec (see below) |
| `timeout_ms` | number, optional | max 60000 |
| `model` | string, optional | override the resolved model (e.g. `jev-latest`; `typesafe/jev` on the Cloudflare path) |
| `provider` | `"typesafe" \| "cloudflare"`, optional | defaults to `"typesafe"`; explicit selection only, never inferred from environment variables |

Instructions and criteria values accept either plain strings or arbitrary JSON
structure (objects/arrays). In-flight requests are cancelled when the client
disconnects.

| Question type | `criteria` | Answer |
| --- | --- | --- |
| `noul` | omit | yes/no probability |
| `choice` | `{option: description\|null}` | winning option name |
| `score` | ordered array of level descriptions | best matching level |

Output: `{answers, model, usage}` on success, `{fallback: true, error}` on failure.

## Providers

The default provider (`typesafe`) is unchanged: it uses `TYPESAFE_API_KEY` and `@typesafe-ai/sdk` exactly as before, and existing callers see no difference.

The opt-in `cloudflare` provider routes the same Jev model through Cloudflare Workers AI, for users who cannot get a TypeSafe invite. Set both `CLOUDFLARE_API_TOKEN` (needs `Account -> Workers AI -> Edit`) and `CLOUDFLARE_ACCOUNT_ID`, then pass `provider: "cloudflare"` on a judge call. Provider selection is explicit only: setting the Cloudflare env vars never switches providers on its own, and a half-set configuration returns the fallback envelope naming the missing variable instead of guessing.

| Channel | Endpoint | Model id | Auth env vars | Price (input tokens) | Notes |
| --- | --- | --- | --- | --- | --- |
| TypeSafe direct (default) | `POST api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` | $0.042/M | Invite-only, gated |
| Cloudflare Workers AI | `POST api.cloudflare.com/client/v4/accounts/{account_id}/ai/run` | `typesafe/jev` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | passes through Cloudflare AI [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) | Question schema identical to TypeSafe; official docs; no invite gate |
| Vercel AI Gateway | `POST ai-gateway.vercel.sh/v1/evaluate` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | $5/mo free credit; card on file required | Renames `noul` to `boolean` (400 otherwise); experimental API |
| OpenRouter (follow-up) | `POST openrouter.ai/api/v1/api/alpha/decisions` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` | $0.042/M | Alpha contract; routes to TypeSafe |

Billing gotcha: `typesafe/jev` is a partner model on Cloudflare, so runs are metered from the **AI Gateway prepaid credit balance**, not the account's payment card, regardless of the gateway's billing setting or whether a gateway is used. Accounts with a valid card but zero credit balance get HTTP 402 (error 2021, "Insufficient balance"); top up AI Gateway prepaid credit before calling.

## Development

```sh
npm ci
node --check server.mjs
node scripts/smoke.mjs         # MCP stdio initialize handshake
node scripts/smoke-judge.mjs   # judge fallback envelope (no API key needed)
node server.mjs                # stdio server; needs TYPESAFE_API_KEY to answer
```

## License

Apache-2.0, see [LICENSE](LICENSE).
