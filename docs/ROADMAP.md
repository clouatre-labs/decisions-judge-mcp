# Roadmap

Where decisions-judge-mcp has been and where it is going. Shipped work is
grounded in the release history; upcoming direction reflects open issues.

## Released (v1.0.0 – v1.9.0)

- **v1.0.x – v1.1.x** — Core `judge` tool over stdio: one request answers
  typed questions (`noul` yes/no probability, `choice`, `score`) about JSON
  application state, with a fallback envelope that never blocks. Hardening
  patches fixed stdio framing so debug logs cannot corrupt the JSON-RPC wire.
- **v1.2.0** — Richer inputs: `state` accepts arrays, `instructions`/`criteria`
  accept structured content, optional per-request `model` override, and
  client-disconnect cancellation stops abandoned requests.
- **v1.3.0** — Opt-in Cloudflare Workers AI provider (`JUDGE_PROVIDER`),
  fail-fast startup on invalid provider or credentials.
- **v1.4.0 – v1.5.0** — Remote access era: opt-in Streamable HTTP transport
  (later removed in favor of the hosted x402 endpoint at `aptu.dev/v1/judge`),
  multi-key handling on rate limits (removed in v1.7.0), `GET /health`,
  graceful keyless startup.
- **v1.6.0** — Decision-pattern prompt template library and schema-description
  guidance so calling models write better questions.
- **v1.7.0** — Caller ergonomics: validation fix hints, whole-request timeout
  via `AbortSignal.any`, removal of unused surfaces (HTTP transport, key
  rotation) to keep the codebase KISS.
- **v1.8.0** — Preview image-backed `noul`/`choice` questions via an optional
  `images` asset map, with server-side validation and a passing accuracy
  rubric re-run.
- **v1.9.0** — Cloudflare provider repointed at Cloudflare's Clef decision model
  (`clef` | `clef-flash`), judge question schema exported as the
  `decisions-judge-mcp/schema` subpath for aptu.dev, and preview `images`
  accepted on both providers.

## Upcoming

- **Stabilize image-backed questions** — graduate the v1.8.0 preview of the
  `images` asset map out of preview once more real-world usage confirms the
  rubric results.
- **Third judge provider** — evaluate the OpenAI Decisions API as an
  additional backend behind the same provider interface (#96).
- **Supply-chain hygiene** — keep the OpenSSF Best Practices badge
  current.
- **Keep it small** — no new transports or surfaces planned; future work
  favors provider quality, validation clarity, and documentation over scope.
