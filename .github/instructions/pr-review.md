# PR Review Instructions

## Scope

Review only what the PR changes. Do not flag issues in files the PR does not touch.

## Workflow files

When reviewing `.github/workflows/` changes:

- Evaluate the full job context, not individual steps in isolation.
- Flag `${{ expression }}` interpolation directly inside `run:` scripts as an injection risk;
  inputs should be passed via `env:` blocks.
- Verify action pins and reusable workflow `uses:` refs use commit SHAs, not mutable tags.
- Flag switching FROM SHA pins TO mutable tags (like `@v1` or `@main`) as a security
  regression (see CVE-2025-30066).
- Flag steps that omit `name:`; every step must have a human-readable name for CI logs.
- Check that `permissions:` blocks are present and minimal.

## JavaScript (Node ESM)

- This is a zero-config, dependency-light MCP server; do not flag the absence of a linter,
  formatter, or type checker — CI enforces `node --check server.mjs` and a stdio smoke test.
- Do not propose TypeScript or build-step conversions; plain `.mjs` ESM is intentional
  (published via `npx` with no transpilation).
- Flag any new runtime dependency in `package.json` without a clear justification.
- Flag synchronous blocking calls (`execSync`, `readFileSync`) on the MCP request path;
  the server must stay responsive over stdio.
- Flag unbounded stdout writes outside the MCP JSON-RPC protocol; stdout is the transport
  channel — diagnostics belong on stderr.
- Flag secret leakage: `TYPESAFE_API_KEY` (or the `TYPESAFE_AI_TOKEN` fallback) must never
  be logged, echoed, or included in error payloads or tool responses.
- Flag changes that alter the failure contract: any tool failure must return
  `{ fallback: true, error: "..." }` and never throw past the tool boundary or exit nonzero.

## Testing

- The smoke test lives in `scripts/smoke.mjs` and exercises the MCP stdio handshake.
- Changes to the tool schema or server lifecycle should update the smoke test.
- One happy path and one edge case per behavior; do not flag missing tests for behaviors
  already covered by existing tests.

## Markdown Links

Flag relative links in Markdown files (e.g., `[text](CONTRIBUTING.md)` or `[text](../docs/foo.md)`). All links must be absolute URLs so they resolve correctly in GitHub release notes, forks, and mirrored docs.

## General

- One comment per distinct issue; do not duplicate findings across multiple inline comments.
- Prefer suggesting a fix (suggestion block) over describing the problem when the fix is
  unambiguous.
