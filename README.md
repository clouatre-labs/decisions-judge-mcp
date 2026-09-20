# decisions-judge-mcp

A small MCP server exposing a single **`judge`** tool: send natural language plus JSON application state, get back **typed judgments** — yes/no probability (`noul`), choice among options, or score on ordered levels — in one fast request, with model/usage metadata. Failures return a `{fallback: true, error}` envelope instead of blocking, so it is safe to compose into agent workflows.

Currently backed by the [TypeSafe System One](https://typesafe.ai) model (Jev) via [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk). The provider-neutral `judge` primitive maps naturally onto related decision APIs such as [OpenRouter alphadecisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request).

Flagship consumer: [`clouatre-labs/agentic-coder-skill`](https://github.com/clouatre-labs/agentic-coder-skill).

## Tool: `judge`

Input:

- `state` — JSON object or string (application state)
- `questions` — map of name → `{type: "noul"|"choice"|"score", instructions, criteria?}`
  - `noul`: criteria omitted; answer is a yes/no probability
  - `choice`: criteria is `{option: description|null}`
  - `score`: criteria is an ordered array of level descriptions
- `timeout_ms` — optional, max 60000

Output: `{answers, model, usage}` on success, `{fallback: true, error}` on failure.

## Install

Requires Node >= 20 and `TYPESAFE_API_KEY` in the environment (`TYPESAFE_AI_TOKEN` is accepted as a legacy fallback).

```sh
# recommended: run on demand via npx (no global install)
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

All examples use `npx -y`, the standard pattern for Node-based MCP servers
(see Context7 and Brave Search). Swap in `decisions-judge-mcp@<version>` in the
`args` if you prefer pinning.

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

**Claude Code** — one command:

```sh
claude mcp add --scope user decisions-judge \
  --env TYPESAFE_API_KEY=... -- npx -y decisions-judge-mcp
```

Or in `~/.claude.json`:

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

## Development

```sh
npm ci
node --check server.mjs
node scripts/smoke.mjs         # MCP stdio initialize handshake
node bin/decisions-judge-mcp   # stdio server; needs TYPESAFE_API_KEY to answer
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
