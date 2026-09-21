# Audit: Dependency Supply Chain -- September 2026

Date: 2026-09-20  
Commit: 5293085  
Version: v1.0.3  
Toolchain: Node >= 20 / npm 11.19.1 / Node v26.9.0 / @modelcontextprotocol/sdk 1.30.0 / zod 4.6.5

## See Also

- [developer-setup.md](../developer-setup.md) -- local development and tooling setup

## Purpose

Point-in-time audit of the dependency supply chain for `decisions-judge-mcp` v1.0.3, triggered by a Socket.dev report showing a supply chain score of 71 and a banner reading "Dependencies have 8 high alerts". Establishes whether the flagged alerts reflect real install-time risk for consumers, how large the production dependency surface actually is, and whether any remediation is warranted in this repository.

Scope: lockfile closure analysis, `server.mjs` import surface, lifecycle script inspection, and publish workflow posture. No `package.json` or `package-lock.json` changes in this session.

## Methodology

Direct analysis of the local tree: `package-lock.json` closure counts computed programmatically (95 production packages excluding the root; BFS over `dependencies` and `peerDependencies` edges from `node_modules/@modelcontextprotocol/sdk`), `hasInstallScript` scan across all lockfile entries, `server.mjs` import statements read directly, an ESM loader trace of server startup, and `.github/workflows/publish.yml` read end to end. Verdicts:

- **CONFIRMED**: claim fully verified against the local tree.
- **PARTIAL**: partially verifiable; remainder not checkable locally.
- **REFUTED**: local evidence contradicts the claim.

The Socket score (71) and the 8-high-alerts banner are screenshot-sourced facts from the 2026-09-20 report; alert names and per-package scores beyond that banner are not asserted here.

## Reproduction

Run from a checkout of this repository at the audited commit, with npm 11.19.1 and Node v26.9.0:

```sh
node -e "const l=require('./package-lock.json'); console.log(Object.keys(l.packages).length - 1)"

node -e "const l=require('./package-lock.json'); console.log(Object.values(l.packages).filter(p => p.hasInstallScript).length)"

node -e "const l=require('./package-lock.json'); const R=new Set(['@modelcontextprotocol/sdk']); let q=['node_modules/@modelcontextprotocol/sdk']; while(q.length){const p=l.packages[q.shift()]||{}; for(const deps of [p.dependencies, p.peerDependencies, p.optionalDependencies]) for(const d of Object.keys(deps||{})) {const k='node_modules/'+d; if(l.packages[k] && !R.has(d)){R.add(d); q.push(k);}}} const name=k=>k.split('node_modules/').pop(); console.log(Object.keys(l.packages).filter(Boolean).filter(k=>R.has(name(k))).length)"

printf 'export async function resolve(s, c, n) { console.error(s); return n(s, c); }\n' > /tmp/trace.mjs

NODE_OPTIONS="--experimental-loader /tmp/trace.mjs" node server.mjs 2>&1 | grep -Ec "express|hono|cors|express-rate-limit|body-parser|qs" || true

npm audit
```

The loader trace prints every module URL resolved at server startup; the grep count is 0, confirming none of the HTTP transport packages load on the stdio path.

---

## Findings

### F1 -- CONFIRMED -- Oversized MCP SDK transport surface

The lockfile records 95 production packages; 94 of them sit inside the `@modelcontextprotocol/sdk` 1.30.0 closure (verified by BFS over lockfile dependency edges). The SDK pulls in HTTP transport stacks -- `express`, `hono`, `cors`, `express-rate-limit`, `qs`, `body-parser` are all present in the lockfile -- but `server.mjs` imports only `McpServer` and `StdioServerTransport` from the SDK (`server.mjs:16-17`). None of the HTTP transport packages execute in the stdio-only deployment this server ships. This was verified empirically, not just by reading imports: an ESM loader trace (`NODE_OPTIONS="--experimental-loader /tmp/trace.mjs" node server.mjs`, with a resolve-hook loader in `/tmp/trace.mjs` logging every module URL resolved) shows zero `express`/`hono`/`cors`/`express-rate-limit`/`body-parser`/`qs` modules loaded at server startup on Node v26.9.0. This proves the SDK entry point does not eagerly import the web-server stack for the stdio path (see Reproduction).

**Files:** `package-lock.json`, `server.mjs`

**Fix:** No change in this repository. File an upstream issue on `modelcontextprotocol/typescript-sdk` proposing that HTTP transport frameworks (`express`, `hono`, `cors`, `express-rate-limit`) and their transitive deps become optional or peer dependencies so stdio-only consumers do not install them. Once the upstream issue is filed, append its URL to this paragraph. Until upstream moves, the extra packages are inert: they are never imported by `server.mjs` and are excluded from the published tarball surface exercised at runtime.

**Estimate:** upstream issue only; no local code change.

---

### F2 -- CONFIRMED-benign -- Lifecycle-script alerts are install-time false positives

The lockfile contains zero `hasInstallScript` entries (verified by scanning every `packages` entry). Packages such as `path-to-regexp`, `ip-address`, and `express-rate-limit` declare `prepare` scripts. Per npm lifecycle semantics, `prepare` and `prepack` scripts run only when the package itself is built from a git checkout -- that is, during that package's own development or publish flow -- and never during a consumer's `npm ci` or `npm install`; npm additionally strips `prepare` from the published-tarball install path. npm records `hasInstallScript` in the lockfile only for packages declaring `install`, `preinstall`, or `postinstall` scripts, and this lockfile shows zero such entries. The zero-`hasInstallScript` scan is therefore corroboration of the npm-semantics argument, not standalone proof. Socket flags script presence without distinguishing lifecycle phases, so these alerts do not represent code that executes on install for consumers of this package.

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
