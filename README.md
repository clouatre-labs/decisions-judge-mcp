# decisions-judge-mcp

[![CI](https://github.com/clouatre-labs/decisions-judge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/clouatre-labs/decisions-judge-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/decisions-judge-mcp.svg)](https://www.npmjs.com/package/decisions-judge-mcp)
[![REUSE status](https://api.reuse.software/badge/github.com/clouatre-labs/decisions-judge-mcp)](https://api.reuse.software/info/github.com/clouatre-labs/decisions-judge-mcp)

**Typed decisions for AI agents, as an MCP tool.** Ask yes/no probability (`noul`), choice among options, or score on ordered levels about any JSON application state — all questions answered in one fast request.

Backed by the [TypeSafe System One](https://typesafe.ai) model (Jev) via [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk), with an opt-in [Cloudflare Workers AI](https://developers.cloudflare.com/ai/models/typesafe/jev/) provider — see [Providers](#providers).

## Get started

Add to `claude_desktop_config.json` (`~/Library/Application Support/Claude/`) — the same JSON shape works for codex, goose, and pi:

```json
{
  "mcpServers": {
    "decisions-judge": {
      "command": "npx",
      "args": ["-y", "decisions-judge-mcp"],
      "env": { "TYPESAFE_API_KEY": "your-key-here" }
    }
  }
}
```

Then ask your agent anything answerable with a judgment — it can call the `judge` tool.

## Remote transport (opt-in)

By default the server speaks stdio. Set `JUDGE_TRANSPORT=http` to serve the MCP Streamable HTTP transport (spec revision 2026-07-28) at `POST /mcp` instead:

```sh
JUDGE_TRANSPORT=http HTTP_HOST=127.0.0.1 HTTP_PORT=8080 npx -y decisions-judge-mcp
```

- `JUDGE_TRANSPORT`: `stdio` (default) or `http`. Any other value exits with an error.
- `HTTP_HOST`: bind address, default `127.0.0.1`.
- `HTTP_PORT`: port, default `8080`; must be 1-65535.

Serving is stateless: each request is handled independently, with no protocol-level sessions (`GET`/`DELETE` on `/mcp` return 405).

**Security warning:** the HTTP endpoint is unauthenticated. Production remote deployments must be fronted by an authenticating OAuth 2.1 proxy per the MCP 2026-07-28 authorization specification.

## Demo

![judge demo](docs/demo.gif)

Judge returns typed answers your code can branch on — and a guaranteed fallback envelope when the model is unreachable.

See [CONTRIBUTING.md](CONTRIBUTING.md) to regenerate the demo.

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
npx -y decisions-judge-mcp          # latest
npx -y decisions-judge-mcp@1.3.0    # pinned, for supply-chain reproducibility
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TYPESAFE_API_KEY` | yes for `typesafe-api` | — | TypeSafe API key, used by the default `typesafe-api` provider |
| `JUDGE_PROVIDER` | no | `typesafe-api` | Provider selector: `typesafe-api` or `cloudflare-workers-ai`. Read once at startup |
| `CLOUDFLARE_API_TOKEN` | only for `cloudflare-workers-ai` | — | Cloudflare token with `Account -> Workers AI -> Edit` permission |
| `CLOUDFLARE_ACCOUNT_ID` | only for `cloudflare-workers-ai` | — | 32-character hex Cloudflare account id |

Invalid `JUDGE_PROVIDER` values, or `cloudflare-workers-ai` selected with missing
Cloudflare credentials, fail fast at startup (non-zero exit naming the offending
variable).

## MCP client configuration

All examples use `npx -y`, the standard pattern for Node-based MCP servers. Swap in `decisions-judge-mcp@<version>` in the `args` if you prefer pinning.

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

## Tool reference: `judge`

| Input | Type | Description |
| --- | --- | --- |
| `state` | object \| string \| array | JSON application state to judge |
| `questions` | map | name → question spec (see below) |
| `timeout_ms` | number, optional | max 60000 |
| `model` | string, optional | override the resolved model (e.g. `jev-latest`) |

Instructions and criteria values accept either plain strings or arbitrary JSON
structure (objects/arrays). In-flight requests are cancelled when the client
disconnects.

| Question type | `criteria` | Answer |
| --- | --- | --- |
| `noul` | omit | yes/no probability |
| `choice` | `{option: description\|null}` | winning option name |
| `score` | ordered array of level descriptions | best matching level |

Output: `{answers, model, usage}` on success, `{fallback: true, error}` on failure — failures never block agent workflows. A `noul` answer is a probability, not a verdict: pick your own action threshold in the caller (e.g. proceed only above 0.7).

## Writing good questions

Jev answers short, well-framed questions better than terse ones. A working reference implementation ([LamplighterPaul/jev-piano](https://github.com/LamplighterPaul/jev-piano)) demonstrates the idiom.

Four patterns, all applicable to the three question types (`noul`, `choice`, `score`):

1. **One decision per question ID.** Each entry in `questions` asks exactly one concept. Don't bundle "is it correct and should we ship it" into a single `noul` — ask two questions.
2. **Descriptive criteria strings.** Every choice option is described by its own intrinsic properties and trade-offs, never by position, index, or an endorsement of the desired answer. Describing one option as "lowest risk" and its rivals as problems is a hint; describing each option's genuine trade-off is not. The model should reach the answer from the state plus balanced descriptions.
3. **Inline state framing.** Name the relevant state inside the question text ("It is a G7 chord, moving next to Cm...") rather than relying on the caller to correlate a separate `state` blob. The `state` field is still sent — inline framing just makes each question self-contained.
4. **Distinct framing per role, one step ahead.** The same kind of decision at different points gets differently phrased questions (e.g. opening vs. closing), because the decision's job differs. When sequencing matters, ask what the next decision should *prepare for* — without that, decisions collapse onto the default option.

Concrete example, rewritten from the terse version in [Example](#example) to follow the idiom:

```jsonc
// judge tool call
{
  "state": { "tests": "passing", "lint": "clean", "filesChanged": 3, "reviewComments": 0, "branchAgeDays": 2, "behindMainBy": 7 },
  "questions": {
    "ready_to_merge": {
      "type": "noul",
      "instructions": "CI is green (tests passing, lint clean), 3 files changed, and no review comments are open. Is this change safe to merge to main right now?"
    },
    "next_step": {
      "type": "choice",
      "instructions": "The branch is 2 days old and has drifted 7 commits behind main. What should the agent do next?",
      "criteria": {
        "merge": "rebase onto main and create the merge commit now, while CI is green",
        "iterate": "continue refining on the branch before any integration step",
        "escalate": "hand the decision back to the human with a summary of the state"
      }
    }
  }
}
```

Note what changed: the state is restated inline and consistently, the criteria are balanced, and the framing names the role of this decision — each rule applied once, concretely.

## Providers

Selected once at startup via `JUDGE_PROVIDER` (default `typesafe-api`). The judge tool's schema and behavior are identical under both providers.

- `typesafe-api` (default): uses `TYPESAFE_API_KEY` via `@typesafe-ai/sdk`.
- `cloudflare-workers-ai`: routes the same Jev model through Cloudflare Workers AI; requires the two Cloudflare variables above.

Billing gotcha: `typesafe/jev` is a partner model on Cloudflare, so runs are metered from the **AI Gateway prepaid credit balance**, not the account's payment card. Accounts with a valid card but zero credit balance get HTTP 402 (error 2021, "Insufficient balance"); top up AI Gateway prepaid credit before calling.

## Development

```sh
npm ci
node --check server.mjs
node scripts/smoke.mjs         # MCP stdio initialize handshake
node scripts/smoke-judge.mjs   # judge fallback envelope (no API key needed)
node server.mjs                # stdio server; needs TYPESAFE_API_KEY to answer
```

Flagship consumer: [`clouatre-labs/agentic-coder-skill`](https://github.com/clouatre-labs/agentic-coder-skill).

## License

Apache-2.0, see [LICENSE](LICENSE).
