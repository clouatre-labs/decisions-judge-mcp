<h1 align="center">decisions-judge-mcp</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/decisions-judge-mcp"><img alt="npm" src="https://img.shields.io/npm/v/decisions-judge-mcp.svg?style=for-the-badge" height="28"></a>
  <a href="LICENSES/Apache-2.0.txt"><img alt="License" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg?style=for-the-badge" height="28"></a>
  <a href="https://api.reuse.software/info/github.com/clouatre-labs/decisions-judge-mcp"><img alt="REUSE" src="https://img.shields.io/reuse/compliance/github.com/clouatre-labs/decisions-judge-mcp?style=for-the-badge" height="28"></a>
  <a href="https://www.bestpractices.dev/projects/17101"><img alt="OpenSSF Best Practices" src="https://img.shields.io/cii/level/17101?style=for-the-badge" height="28"></a>
</p>

**Typed decisions for AI agents, as an MCP tool.** Ask yes/no probability (`noul`), choice among options, or score on ordered levels about any JSON application state — all questions answered in one fast request. [OpenSSF Best Practices silver certified](https://www.bestpractices.dev/projects/17101).

Backed by the [TypeSafe System One](https://typesafe.ai) decision model (Jev) via [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk), with an opt-in [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/clef/) provider running Cloudflare's Clef decision model — see [Providers](#providers). Further reading on decision-model patterns, from the author's [blog](https://clouatre.ca/blog/).

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

The unpaid call returns 402 with an x402 v2 challenge in the `PAYMENT-REQUIRED` header; pay it and retry with the `PAYMENT-SIGNATURE` header to get the answer. The same judge is available to MCP clients as a remote Streamable HTTP server at `https://aptu.dev/mcp`.

## Transport

The server speaks stdio only: newline-delimited JSON-RPC over stdin/stdout, for local MCP clients (Claude Code, codex, goose, pi). It serves no HTTP itself; use [aptu.dev](#zero-setup-remote) for remote access.

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
- **`TYPESAFE_DEFAULT_MODEL`** (optional, `typesafe-api` provider only): overrides the pinned default model (`jev-1.14.0`) when the caller passes no `model` input. A caller `model` input always wins over the env value. The Cloudflare provider's default is unaffected (it runs `@cf/cloudflare/clef`).

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

Inputs: `state` (object \| string \| array — the JSON application state to judge), `questions` (map of name → question spec, see below), `timeout_ms` (optional number, max 60000), `model` (optional override of the resolved model; the TypeSafe path defaults to `DEFAULT_MODEL` (`jev-1.14.0`), overridable via `TYPESAFE_DEFAULT_MODEL` — see [Configuration](#configuration); the Cloudflare path defaults to `@cf/cloudflare/clef` and accepts `clef` or `clef-flash`), and `images` (optional map of asset name → local image file path, see below).

Instructions and criteria values accept either plain strings or arbitrary JSON structure (objects/arrays). In-flight requests are cancelled when the client disconnects.

| Question type | `criteria` | Answer |
| --- | --- | --- |
| `noul` | omit | yes/no probability |
| `choice` | `{option: description\|null}` | winning option name |
| `score` | ordered array of level descriptions | best matching level |

### Image-backed noul and choice questions (preview)

The optional `images` map enables image-backed `noul` and `choice` questions on the `typesafe-api` provider only. Each entry maps an asset name to a local PNG or JPEG file path; the server reads the file and validates it (PNG/JPEG magic bytes, 256-1568 px per side, max 16 MiB) before base64-encoding it for the API. Reference an asset as `<name>` in `noul`/`choice` instructions; every image must be referenced by at least one such question, and `score`/`box` questions over images are rejected. The Cloudflare provider fails closed on images with a fallback envelope. Preview status: the contract may change; the model accuracy rubric it ships behind is recorded in `docs/audit/2026-11-24-image-rubric-rerun.md`.

```jsonc
{
  "state": { "page": "checkout" },
  "images": { "shot1": "/tmp/checkout-screenshot.png" },
  "questions": {
    "layout_defect": {
      "type": "noul",
      "instructions": "Does the rendering in <shot1> show a layout defect?"
    }
  }
}
```

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

Selected once at startup via `JUDGE_PROVIDER` (default `typesafe-api`); the judge tool's schema and behavior are identical under both providers. `typesafe-api` uses `@typesafe-ai/sdk` with one or more TypeSafe API keys (rotation details in [Configuration](#configuration)); `cloudflare-workers-ai` runs Cloudflare's Clef decision model (default `@cf/cloudflare/clef`, a rolling alias with no version pin; a `clef` or `clef-flash` `model` override selects the same family) through Cloudflare Workers AI and requires the two Cloudflare variables above.

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

The judge question schema is importable as `decisions-judge-mcp/schema` (exports `entryType`, `questionSpec`, `questionsSchema`); aptu.dev uses it to keep its paid `/v1/judge` identical to this tool.

## License

Apache-2.0, see [LICENSE](LICENSE).
