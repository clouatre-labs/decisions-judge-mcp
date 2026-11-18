<h1 align="center">decisions-judge-mcp</h1>

<p align="center">
  <a href="https://github.com/clouatre-labs/decisions-judge-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/badge/CI-passing-brightgreen.svg?style=for-the-badge" height="20"></a>
  <a href="https://github.com/clouatre-labs/decisions-judge-mcp/actions/workflows/publish.yml"><img alt="Publish" src="https://img.shields.io/badge/Publish-npm-blue.svg?style=for-the-badge" height="20"></a>
  <a href="https://github.com/clouatre-labs/decisions-judge-mcp/actions/workflows/scorecard.yml"><img alt="Scorecard" src="https://img.shields.io/badge/Scorecard-enabled-blue.svg?style=for-the-badge" height="20"></a>
  <a href="https://github.com/clouatre-labs/decisions-judge-mcp/actions/workflows/security-lint.yml"><img alt="Security" src="https://img.shields.io/badge/Security-lint-blue.svg?style=for-the-badge" height="20"></a>
  <a href="LICENSES/Apache-2.0.txt"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge" height="20"></a>
</p>

**Typed decisions for AI agents, as an MCP tool.** Ask yes/no probability (`noul`), choice among options, or score on ordered levels about any JSON application state — all questions answered in one fast request.

Backed by the [TypeSafe System One](https://typesafe.ai) decision model (Jev) via [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk), with an opt-in [Cloudflare Workers AI](https://developers.cloudflare.com/ai/models/typesafe/jev/) provider — see [Providers](#providers). Further reading on decision-model patterns, from the author's [blog](https://clouatre.ca/blog/).

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

### Zero-setup remote

Prefer not to run anything locally? The same `judge` tool is served as a paid HTTP endpoint at `https://aptu.dev/v1/judge` over [x402](https://www.x402.org): no signup, no API key, $0.005 per call settled in USDC on Base or Solana.

```sh
curl -X POST https://aptu.dev/v1/judge \
  -H "Content-Type: application/json" \
  -d '{"state": {"build": "green", "tests": 490}, "questions": {"is_bug": {"type": "noul", "instructions": "Is this a defect?"}}}'
```

The unpaid call returns a 402 challenge; pay it and retry with the `X-PAYMENT` header to get the answer.

## Transport

The server speaks stdio only: newline-delimited JSON-RPC over stdin/stdout, for local MCP clients (Claude Code, codex, goose, pi).

**Security warning:** the HTTP endpoint is unauthenticated. Production remote deployments must be fronted by an authenticating OAuth 2.1 proxy per the MCP 2026-07-28 authorization specification.

## Architecture

<p align="center">
  <img alt="Architecture diagram: an MCP client sends typed questions to the judge tool, which asks the TypeSafe Jev decision model and returns noul, choice, or score answers" src="docs/diagrams/architecture.svg" width="560">
</p>

*Figure 1: Typed decisions flow from the MCP client through the judge tool to the TypeSafe decision model.*

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
  "model": "jev-1.14.0",
  "usage": { "input_tokens": 214, "output_tokens": 18 },
  "fallback": false
}
```

## Quickstart

Requires Node >= 22 and at least one TypeSafe API key (see [Configuration](#configuration)).

```sh
npx -y decisions-judge-mcp          # latest
npx -y decisions-judge-mcp@1.3.0    # pinned, for supply-chain reproducibility
```

## Configuration

- **`TYPESAFE_API_KEY`**: required for the default `typesafe-api` provider. Retry on rate limits (429) and transient errors (408/5xx) is owned by the SDK default retry policy.
- **`JUDGE_PROVIDER`** (default `typesafe-api`): provider selector, `typesafe-api` or `cloudflare-workers-ai`; read once at startup.
- **`CLOUDFLARE_API_TOKEN`** / **`CLOUDFLARE_ACCOUNT_ID`** (only for `cloudflare-workers-ai`): a Cloudflare token with `Account -> Workers AI -> Edit` permission, and the 32-character hex Cloudflare account id.
- **`TYPESAFE_DEFAULT_MODEL`** (optional, `typesafe-api` provider only): overrides the pinned default model (`jev-1.14.0`) when the caller passes no `model` input. A caller `model` input always wins over the env value. The Cloudflare path's pinned default (`typesafe/jev-1.14.0`) is unaffected.

Invalid `JUDGE_PROVIDER` values, or `cloudflare-workers-ai` selected with missing Cloudflare credentials, fail fast at startup (non-zero exit naming the offending variable).

Selecting `typesafe-api` with no key configured prints a startup warning (the server still runs; judge calls return fallback envelopes) instead of exiting.

## MCP client configuration

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

**pi** (`~/.config/pi/mcp.json` or equivalent): same JSON shape as [Get started](#get-started), pointing your coding agent's MCP config at the same command and env.

## Tool reference: `judge`

Inputs: `state` (object \| string \| array — the JSON application state to judge), `questions` (map of name → question spec, see below), `timeout_ms` (optional number, max 60000), and `model` (optional override of the resolved model; the TypeSafe path defaults to `DEFAULT_MODEL` (`jev-1.14.0`), overridable via `TYPESAFE_DEFAULT_MODEL` — see [Configuration](#configuration); the Cloudflare path defaults to `typesafe/jev`).

Instructions and criteria values accept either plain strings or arbitrary JSON structure (objects/arrays). In-flight requests are cancelled when the client disconnects.

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

## Prompts

The server exposes three static decision-pattern prompt templates: `verify-claim` (atomic yes/no checks of a claim against state), `classify` (pick one option with balanced criteria), and `route` (decide what the next decision should prepare for). Each template returns a ready-to-send judge call skeleton with atomic questions and structured `{summary, signals}` criteria. Every template is version-stamped (`wording-v1`); rewording bumps the stamp so earlier calibration runs stay comparable. Fetch one with `prompts/get`:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "prompts/get", "params": { "name": "verify-claim", "arguments": { "state": "{}" } } }
```

The response is a single user message whose text embeds a judge skeleton like:

```jsonc
{
  "tool": "judge",
  "arguments": {
    "state": "<state JSON goes here>",
    "questions": {
      "claim_supported": {
        "type": "noul",
        "instructions": "The provided state contains evidence that directly supports the claim under review. Does the evidence support the claim?"
      }
    }
  }
}
```

Fill in the state and send it to the judge tool.

## Providers

Selected once at startup via `JUDGE_PROVIDER` (default `typesafe-api`); the judge tool's schema and behavior are identical under both providers. `typesafe-api` uses `@typesafe-ai/sdk` with one or more TypeSafe API keys (rotation details in [Configuration](#configuration)); `cloudflare-workers-ai` routes the same Jev model through Cloudflare Workers AI and requires the two Cloudflare variables above.

Billing gotcha: `typesafe/jev` is a partner model on Cloudflare, so runs are metered from the **AI Gateway prepaid credit balance**, not the account's payment card. Accounts with a valid card but zero credit balance get HTTP 402 (error 2021, "Insufficient balance"); top up AI Gateway prepaid credit before calling.

## Development

```sh
npm ci
node --check server.mjs
node scripts/smoke.mjs         # MCP stdio initialize handshake
node scripts/smoke-judge.mjs   # judge fallback envelope (no API key needed)
# Image accuracy probe (issue #95; needs TYPESAFE_API_KEY, makes live API calls):
# node scripts/probe-images.mjs [--model jev-1.14.0]
node server.mjs                # stdio server; needs TYPESAFE_API_KEY to answer
```

Flagship consumer: [`clouatre-labs/agentic-coder-skill`](https://github.com/clouatre-labs/agentic-coder-skill), which uses `judge` for subagent orchestration and context-window decisions inside an agent harness.

## License

Apache-2.0, see [LICENSE](LICENSE).
