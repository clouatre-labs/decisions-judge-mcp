# AGENTS.md

## Project overview

<!-- One paragraph: what this repo does, who uses it, primary language/framework. -->
<!-- Example: "Rust MCP server for code structure analysis using tree-sitter" -->

## Stack & Commands

<!-- Fill in: language/runtime, package manager, key frameworks -->

```
# build:  <fill in>
# test:   <fill in>
# lint:   <fill in>
# format: <fill in>
```

## Development standards

- GPG sign and DCO sign-off: `git commit -S --signoff` (every commit)
- Treat all repositories as public; no secrets, API keys, credentials, or PII
- Actions pinned to SHA (not tags); actionlint recommended for local workflow validation
- Training data is stale: verify APIs and versions against installed packages or docs

## Testing

- One happy path and one edge case per behavior; no redundant variations
- AAA pattern (Arrange, Act, Assert); keep each test focused and short

## Design references

<!-- Link internal docs the AI agent should read before implementing:
- ARCHITECTURE.md (if it exists)
- Any API spec or data model doc
-->

## Do not

- Add dependencies without justification in the PR description
- Implement features not specified in the assigned issue
- Modify files outside the scope of the assigned issue
<!-- Add project-specific constraints here -->
