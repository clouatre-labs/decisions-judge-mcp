# Audit: Dependency Supply Chain -- September 2026

Date: 2026-09-20  
Commit: 5293085  
Version: v1.0.3  
Toolchain: Node >= 20 / npm / @modelcontextprotocol/sdk 1.30.0 / zod 4.6.5

## See Also

- [developer-setup.md](../developer-setup.md) -- local development and tooling setup

## Purpose

Point-in-time audit of the dependency supply chain for `decisions-judge-mcp` v1.0.3, triggered by a Socket.dev report showing a supply chain score of 71 and a banner reading "Dependencies have 8 high alerts". Establishes whether the flagged alerts reflect real install-time risk for consumers, how large the production dependency surface actually is, and whether any remediation is warranted in this repository.

Scope: lockfile closure analysis, `server.mjs` import surface, lifecycle script inspection, and publish workflow posture. No `package.json` or `package-lock.json` changes in this session.

## Methodology

Direct analysis of the local tree: `package-lock.json` closure counts computed programmatically (95 production packages excluding the root; BFS over `dependencies` and `peerDependencies` edges from `node_modules/@modelcontextprotocol/sdk`), `hasInstallScript` scan across all lockfile entries, `server.mjs` import statements read directly, and `.github/workflows/publish.yml` read end to end. Verdicts:

- **CONFIRMED**: claim fully verified against the local tree.
- **PARTIAL**: partially verifiable; remainder not checkable locally.
- **REFUTED**: local evidence contradicts the claim.

The Socket score (71) and the 8-high-alerts banner are screenshot-sourced facts from the 2026-09-20 report; alert names and per-package scores beyond that banner are not asserted here.

---

## Findings

### F1 -- CONFIRMED -- Oversized MCP SDK transport surface

The lockfile records 95 production packages; 94 of them sit inside the `@modelcontextprotocol/sdk` 1.30.0 closure (verified by BFS over lockfile dependency edges). The SDK pulls in HTTP transport stacks -- `express`, `hono`, `cors`, `express-rate-limit`, `qs`, `body-parser` are all present in the lockfile -- but `server.mjs` imports only `McpServer` and `StdioServerTransport` from the SDK (`server.mjs:16-17`). None of the HTTP transport packages execute in the stdio-only deployment this server ships.

**Files:** `package-lock.json`, `server.mjs`

**Fix:** No change in this repository. File an upstream issue on `modelcontextprotocol/typescript-sdk` proposing that HTTP transport frameworks (`express`, `hono`, `cors`, `express-rate-limit`) and their transitive deps become optional or peer dependencies so stdio-only consumers do not install them. Until upstream moves, the extra packages are inert: they are never imported by `server.mjs` and are excluded from the published tarball surface exercised at runtime.

**Estimate:** upstream issue only; no local code change.

---

### F2 -- CONFIRMED-benign -- Lifecycle-script alerts are install-time false positives

The lockfile contains zero `hasInstallScript` entries (verified by scanning every `packages` entry). Packages such as `path-to-regexp`, `ip-address`, and `express-rate-limit` declare `prepare` scripts, but `prepare` runs only when the package itself is built from a git checkout (i.e., upstream development), never during a consumer `npm ci`. Socket flags script presence without distinguishing lifecycle phases, so these alerts do not represent code that executes on install for consumers of this package.

**Files:** `package-lock.json`

**Fix:** None. Record the rationale here and in future audit reviews: the alerts are false-positive surface. Re-check on each SDK major bump in case upstream adoption changes the closure.

**Estimate:** 0.

---

### F3 -- CONFIRMED -- Clean publish posture

`.github/workflows/publish.yml` has top-level `permissions: {}` (line 19), SHA-pinned actions (`actions/checkout@9c091bb...`, `actions/setup-node@2028fbc5...`), a signed-tag verification gate before publish, job-scoped `id-token: write` for OIDC npm trusted publishing (line 78), and publishes with `npm publish --provenance` (line 116). The workflow also verifies that the package version matches the tag before packing. `npm audit` reports 0 vulnerabilities. This is a strong publishing posture; nothing to remediate.

**Files:** `.github/workflows/publish.yml`

**Fix:** Maintain as-is. Keep actions SHA-pinned and provenance enabled on future changes.

**Estimate:** 0.

---

### F4 -- CONFIRMED -- Minimal direct dependency surface

Direct dependencies are exactly three: `@modelcontextprotocol/sdk` (^1.30.0), `@typesafe-ai/sdk` (^0.6.0), and `zod` (^4.0.0). `@typesafe-ai/sdk` 0.6.0 has no dependencies of its own; `zod` 4.6.5 is a single package with no transitive runtime deps. The direct surface beyond the MCP SDK is two leaf packages -- a minimal trust footprint for a supply-chain audit.

**Files:** `package.json`

**Fix:** Maintain. Prefer keeping direct dependencies at this minimum; evaluate any new direct dep against this baseline.

**Estimate:** 0.

---

## Summary Table

*Table 1: Finding classification.*

| Finding | Verdict | Action |
|---|---|---|
| F1 Oversized MCP SDK transport surface | CONFIRMED | upstream issue; no local change |
| F2 Lifecycle-script alerts | CONFIRMED-benign | none (false positives) |
| F3 Publish posture | CONFIRMED | maintain |
| F4 Direct dependency surface | CONFIRMED | maintain |

**Actionable in this repository:** 0. **Upstream recommendation:** 1 (F1).

## Remediation Plan

No dependency surgery in this repository. The single substantive remediation is the F1 upstream issue to `modelcontextprotocol/typescript-sdk` proposing optional HTTP transport dependencies. F2 alerts are documented as false positives and require no action; re-verify the zero-`hasInstallScript` property after each SDK bump. F3 and F4 are postures to maintain, not defects.

Next audit trigger: any change to direct dependencies, a `@modelcontextprotocol/sdk` major bump, or a new Socket.dev alert on a package in the lockfile.
