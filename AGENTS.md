# AGENTS.md

## Project overview

decisions-judge-mcp is an MCP stdio server (Node >= 20, ESM, single `server.mjs`) exposing one `judge` tool backed by the @typesafe-ai/sdk: it sends application state plus typed questions (noul, choice, score) to the TypeSafe System One model and returns structured answers; failures return a `{fallback: true, error}` envelope instead of blocking.

## Stack & Commands

npm on Node 24; MCP SDK + zod for schema validation.

```sh
# test:   node --check server.mjs && node scripts/smoke.mjs && node scripts/smoke-judge.mjs
# lint:   npx markdownlint-cli2 "**/*.md"
# format: npx markdownlint-cli2 --fix "**/*.md"
```

## Development standards

- GPG sign and DCO sign-off: `git commit -S --signoff` (every commit)
- Treat all repositories as public; no secrets, API keys, credentials, or PII
- Actions pinned to SHA (not tags); actionlint recommended for local workflow validation
- Training data is stale: verify APIs and versions against installed packages or docs

## Testing

- One happy path and one edge case per behavior; no redundant variations
- AAA pattern (Arrange, Act, Assert); keep each test focused and short

## Releases

- Release via signed, annotated tag on `main` HEAD (`git tag -s vX.Y.Z`); the `publish` workflow verifies the signature, creates a GitHub Release with generated notes, and publishes to npm with provenance.
- The "Bypassed rule violations" audit event on tag push is expected: the Release Tag Protection ruleset grants admins a deliberate `always` bypass; the audit event is the trail. See CONTRIBUTING.md.

## Design references

- CONTRIBUTING.md

## Do not

- Add dependencies without justification in the PR description
- Implement features not specified in the assigned issue
- Modify files outside the scope of the assigned issue
