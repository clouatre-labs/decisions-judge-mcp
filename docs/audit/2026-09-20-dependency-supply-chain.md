# Audit: Dependency Supply Chain -- September 2026

Date: 2026-09-20  
Commit: 5293085  
Version: v1.0.3  
Toolchain: Node >= 20 / npm 11.19.1 / Node v26.9.0 / @modelcontextprotocol/sdk 1.30.0 / zod 4.6.5

## Purpose

Point-in-time audit of the dependency supply chain for `decisions-judge-mcp` v1.0.3, triggered by a Socket.dev report showing a supply chain score of 71 and a banner reading "Dependencies have 8 high alerts". Establishes whether the flagged alerts reflect real install-time risk for consumers, how large the production dependency surface actually is, and whether any remediation is warranted in this repository.

Scope: lockfile closure analysis, `server.mjs` import surface, lifecycle script inspection, and publish workflow posture. No `package.json` or `package-lock.json` changes in this session.

## Methodology

Direct analysis of the local tree: `package-lock.json` closure counts computed programmatically (95 production packages excluding the root; 94 inside the `@modelcontextprotocol/sdk` 1.30.0 closure; both counts computed by BFS over `dependencies` edges keyed by the `packages[]` path string, i.e. the resolved node_modules location, so deduplication is by resolved package path), `hasInstallScript` scan across all lockfile entries, a registry-resolution scan across all lockfile entries, `server.mjs` import statements read directly, an ESM loader trace of server startup, and `.github/workflows/publish.yml` read end to end. Verdicts:

- **CONFIRMED**: claim fully verified against the local tree.
- **PARTIAL**: partially verifiable; remainder not checkable locally.
- **REFUTED**: local evidence contradicts the claim.

The Socket score (71) and the 8-high-alerts banner are screenshot-sourced facts from the 2026-09-20 report; alert names and per-package scores beyond that banner are not asserted here.

## Reproduction

Run from a checkout of this repository at the audited commit, with npm 11.19.1 and Node v26.9.0:

All closure counts below are keyed by the `packages[]` path string -- the resolved node_modules location -- so duplicates across hoisting levels cannot be double-counted, and dev-only, optional-only, and peer-only entries are excluded from the production count. Each command's printed output is stated next to it.

```sh
node -e "const l=require('./package-lock.json'); const prod=new Set(['']); let q=['']; while(q.length){const path=q.shift(); const p=l.packages[path]||{}; for(const d of Object.keys(p.dependencies||{})){let base=path,k;for(;;){k=(base?base+'/':'')+'node_modules/'+d;if(l.packages[k])break;if(!base)break;base=base.slice(0,base.lastIndexOf('/node_modules/'));}if(l.packages[k]&&!prod.has(k)){prod.add(k);q.push(k);}}} const all=Object.keys(l.packages).filter(k=>k!==''); console.log('production:',prod.size-1,'devOnly:',all.filter(k=>l.packages[k].dev&&!prod.has(k)).length,'optionalOnly:',all.filter(k=>l.packages[k].optional&&!l.packages[k].dev&&!prod.has(k)).length,'peerOnly:',all.filter(k=>!prod.has(k)&&!l.packages[k].dev&&!l.packages[k].optional).length)"

node -e "const l=require('./package-lock.json'); const root='node_modules/@modelcontextprotocol/sdk'; const c=new Set([root]); let q=[root]; while(q.length){const path=q.shift(); const p=l.packages[path]||{}; for(const deps of [p.dependencies,p.optionalDependencies]) for(const d of Object.keys(deps||{})){let base=path,k;for(;;){k=(base?base+'/':'')+'node_modules/'+d;if(l.packages[k])break;if(!base)break;base=base.slice(0,base.lastIndexOf('/node_modules/'));}if(l.packages[k]&&!c.has(k)){c.add(k);q.push(k);}}} console.log(c.size)"

node -e "const l=require('./package-lock.json'); console.log(Object.values(l.packages).filter(p => p.hasInstallScript).length)"

node -e "const l=require('./package-lock.json'); const e=Object.entries(l.packages).filter(([k])=>k!==''); console.log('nonRegistry:',e.filter(([k,p])=>p.resolved&&!p.resolved.startsWith('https://registry.npmjs.org/')).length,'missingResolved:',e.filter(([k,p])=>!p.resolved).length,'gitLinkFile:',e.filter(([k,p])=>p.link===true||(p.resolved&&(p.resolved.startsWith('git+')||p.resolved.startsWith('file:')))).length)"

printf 'export async function resolve(s, c, n) { console.error(s); return n(s, c); }\n' > /tmp/trace.mjs

NODE_OPTIONS="--experimental-loader /tmp/trace.mjs" node server.mjs 2>&1 | grep -Ec "express|hono|cors|express-rate-limit|body-parser|qs" || true

npm audit
```

Observed output on npm 11.19.1 and Node v26.9.0, in command order: `production: 95 devOnly: 0 optionalOnly: 0 peerOnly: 0`, `94`, `0`, `nonRegistry: 0 missingResolved: 0 gitLinkFile: 0`, loader-trace grep count `0`, and `npm audit` reporting 0 vulnerabilities. The first command walks the root's production `dependencies` graph over `packages[]` paths, so the 95 count excludes dev-only, optional-only, and peer-only entries by construction; the second command counts the path-keyed closure reachable from `node_modules/@modelcontextprotocol/sdk`.

The loader trace prints every module URL resolved at server startup; the grep count is 0, confirming none of the HTTP transport packages load on the stdio path.

---

## Findings

### F1 -- CONFIRMED -- Oversized MCP SDK transport surface

The lockfile records 95 production packages (path-keyed BFS from the root over `dependencies` edges, dev/optional/peer-only entries excluded, 0 of each excluded category reported by the same command); 94 of them sit inside the `@modelcontextprotocol/sdk` 1.30.0 closure (verified by path-keyed BFS over lockfile dependency edges). The SDK pulls in HTTP transport stacks -- `express`, `hono`, `cors`, `express-rate-limit`, `qs`, `body-parser` are all present in the lockfile -- but `server.mjs` imports only `McpServer` and `StdioServerTransport` from the SDK (`server.mjs:16-17`). None of the HTTP transport packages execute in the stdio-only deployment this server ships. This was verified empirically, not just by reading imports: an ESM loader trace (`NODE_OPTIONS="--experimental-loader /tmp/trace.mjs" node server.mjs`, with a resolve-hook loader in `/tmp/trace.mjs` logging every module URL resolved) shows zero `express`/`hono`/`cors`/`express-rate-limit`/`body-parser`/`qs` modules loaded at server startup on Node v26.9.0. This proves the SDK entry point does not eagerly import the web-server stack for the stdio path (see Reproduction).

**Files:** `package-lock.json`, `server.mjs`

**Fix:** Resolved 2026-09-21 by migrating to `@modelcontextprotocol/server` 2.0.0 (#15): SDK v2 moved HTTP transports into opt-in separate packages, so the stdio-only production closure no longer contains them.

**Estimate:** upstream issue only; no local code change.

**Remediation note (2026-09-21):** Resolved by upstream SDK v2 rather than an upstream issue. `@modelcontextprotocol/server` 2.0.0 (stable, implements the 2026-07-28 MCP spec) moved HTTP transports into opt-in separate packages (`@modelcontextprotocol/express`, `@modelcontextprotocol/fastify`); its stdio-only closure is 3 packages total. This repository migrated in #15: production closure dropped from 95 to 4 packages, `express`/`hono`/`cors`/`express-rate-limit`/`qs`/`body-parser` are no longer in the lockfile, `npm audit` reports 0 vulnerabilities, and the stdio smoke check passes (protocol 2025-11-25 negotiated).

---

### F2 -- CONFIRMED-benign -- Lifecycle-script alerts are install-time false positives

The lockfile contains zero `hasInstallScript` entries (verified by scanning every `packages` entry). Packages such as `path-to-regexp`, `ip-address`, and `express-rate-limit` declare `prepare` scripts. Per npm lifecycle semantics, `prepare` and `prepack` scripts run only when the package itself is built from a git checkout -- that is, during that package's own development or publish flow -- and never during a consumer's `npm ci` or `npm install`; npm additionally strips `prepare` from the published-tarball install path. One nuance narrows that conclusion's scope: `prepare` does not run when a dependency is installed from a registry tarball, but it CAN run when a dependency is installed from a git repository or a local directory, since npm then builds the package from source. Every package in this lockfile is registry-resolved -- all 95 `packages[]` entries carry a `resolved` field pointing at `registry.npmjs.org`, with zero git, link, or file sources (verified by the registry-resolution command in Reproduction, printing `nonRegistry: 0 missingResolved: 0 gitLinkFile: 0`) -- so the conclusion holds for every dependency this package can install. npm records `hasInstallScript` in the lockfile only for packages declaring `install`, `preinstall`, or `postinstall` scripts, and this lockfile shows zero such entries. The zero-`hasInstallScript` scan is therefore corroboration of the npm-semantics argument, not standalone proof. Socket flags script presence without distinguishing lifecycle phases, so these alerts do not represent code that executes on install for consumers of this package.

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
| F1 Oversized MCP SDK transport surface | CONFIRMED | resolved by v2 migration (#15) |
| F2 Lifecycle-script alerts | CONFIRMED-benign | none (false positives) |
| F3 Publish posture | CONFIRMED | maintain |
| F4 Direct dependency surface | CONFIRMED | maintain |

**Actionable in this repository:** 0. **Upstream recommendation:** 1 (F1) -- superseded 2026-09-21: resolved by the `@modelcontextprotocol/server` 2.0.0 migration (#15).

## Remediation Plan

F1 is remediated: the repository migrated from `@modelcontextprotocol/sdk` 1.30.0 to `@modelcontextprotocol/server` 2.0.0 (#15), dropping the production closure from 95 to 4 packages and removing all HTTP transport packages from the lockfile; the stdio smoke check negotiates protocol 2025-11-25 unchanged. F2 alerts must be re-verified against the new closure: the zero-`hasInstallScript` property held post-migration (4-package closure, no install scripts). F3 and F4 are postures to maintain, not defects.

Next audit trigger: any change to direct dependencies, a `@modelcontextprotocol/server` major bump, or a new Socket.dev alert on a package in the lockfile.
