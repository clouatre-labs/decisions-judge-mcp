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

Release is exactly two steps:

1. PR bumping `package.json` to the next semver version (the `publish` workflow fails the tag if the version does not match).
2. After it merges: `git tag -s vX.Y.Z` on `main` HEAD and push the tag. The workflow handles signature verification, GitHub Release, and npm publish with provenance.

- Release tags are **immutable**: never delete, re-push, or move a tag that has already been pushed, even to fix a failed release. Fix forward instead (a new PR, then a new patch tag `vX.Y.Z+1`).
- If the publish run fails: report the failure, lay out options, and stop for a human decision. Do not open CI-fix PRs or take destructive actions (tag delete/re-push, workflow edits) mid-release without approval.
- Never modify the release workflow as part of a release; workflow changes go through their own reviewed PR outside a release window.
- The "Bypassed rule violations" audit event on tag push is expected: the Release Tag Protection ruleset grants admins a deliberate `always` bypass; the audit event is the trail. See CONTRIBUTING.md.

## Audits

Point-in-time audit records live in `docs/audit/`, one document per review, named `YYYY-MM-DD-slug.md` (e.g. `2026-09-22-code-review.md`). Conventions, aligned with `clouatre-labs/aptu-coder`'s `docs/audit/`:

- Header: `# Audit: <Title> -- <Month Year>`, followed by a metadata block with trailing double-spaces: `Date`, `Commit` (audited HEAD short hash), `Version`, `Toolchain` (Node/npm and key dependency versions actually installed).
- Sections: `## See Also` (cross-links to related audits), `## Purpose` (why and scope), `## Methodology` (how findings were verified, with the verdict vocabulary defined inline: **CONFIRMED** / **PARTIAL** / **REFUTED**; extend only with justification, e.g. RE-CONFIRMED, CONFIRMED-benign), `## Findings` (`### F<N> -- <VERDICT> -- <one-line claim>` with Files/Fix per finding), `## Summary Table`, and a verification or reproduction section with exact commands and observed output.
- Verify claims against installed package sources and the live tree, never training data; record line references.
- Historical audit documents are immutable records: never rewrite findings or verdicts retroactively. Formatting/nomenclature normalization and factual follow-up notes (e.g. a dated remediation note) are allowed.
- Every audit-changing commit follows the standard commit rules (GPG + DCO); `npx markdownlint-cli2 "**/*.md"` must pass.

## Design references

- CONTRIBUTING.md

## Do not

- Add dependencies without justification in the PR description
- Implement features not specified in the assigned issue
- Modify files outside the scope of the assigned issue
