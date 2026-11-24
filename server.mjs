#!/usr/bin/env node
// MCP server exposing ONE tool: judge, over stdio.
//
// Transport: newline-delimited JSON-RPC over stdin/stdout, for local MCP
// clients (Claude Code, codex, goose, pi).
//
// The judge tool sends application state (object, string, or array) plus typed
// questions (noul / choice / score) to the TypeSafe System One API in a
// single request and returns the raw typed answers plus model/usage metadata.
// Instructions and criteria values accept strings or arbitrary JSON structure
// (EntryType); an optional model override is honored. Client disconnects abort
// the in-flight request. Question specs are validated before any provider
// call, and {state, questions} payloads exceeding 256 KiB are rejected, both
// via the shared checks in providers/typesafe-api.mjs.
// Retries and timeouts are owned by @typesafe-ai/sdk; default model
// resolution lives in providers/typesafe-api.mjs (DEFAULT_MODEL pin,
// overridable via TYPESAFE_DEFAULT_MODEL, read once at module load).
//
// Auth: TYPESAFE_API_KEY (resolved from the environment by the SDK).
//
// Any failure returns { fallback: true, error: "..." } with exit code 0 --
// never blocks, never prints the token.

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { cloudflareJudge } from "./providers/cloudflare-workers-ai.mjs";
import { REGISTERED_PROMPTS } from "./prompts.mjs";
import {
  envelope,
  fallbackEnvelope,
  fallbackFrom,
  loadImagesFromPaths,
  typesafeJudge,
  validateImages,
} from "./providers/typesafe-api.mjs";

// Startup provider selection: JUDGE_PROVIDER is read exactly once, at server
// startup. Explicit selection only -- the provider is never inferred from
// which credential env vars happen to be set. The judge tool schema,
// description, and server instructions are identical for both backends.
const VALID_PROVIDERS = ["typesafe-api", "cloudflare-workers-ai"];
const provider = process.env.JUDGE_PROVIDER || "typesafe-api";
if (!VALID_PROVIDERS.includes(provider)) {
  console.error(
    `JUDGE_PROVIDER must be one of: ${VALID_PROVIDERS.join(", ")} (got "${provider}")`,
  );
  process.exit(1);
}
if (provider === "cloudflare-workers-ai") {
  if (!process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN.trim() === "") {
    console.error(
      "CLOUDFLARE_API_TOKEN must be set to a non-empty value when JUDGE_PROVIDER=cloudflare-workers-ai",
    );
    process.exit(1);
  }
  if (!/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? "")) {
    console.error(
      "CLOUDFLARE_ACCOUNT_ID must be a 32-character hex account id when JUDGE_PROVIDER=cloudflare-workers-ai",
    );
    process.exit(1);
  }
}

// A keyless typesafe-api startup is a warning, not an exit: the stdio MCP
// handshake must still work (judges will return fallback envelopes) and a
// key can be supplied later via TYPESAFE_API_KEY.
if (provider === "typesafe-api" && !process.env.TYPESAFE_API_KEY) {
  console.error(
    "WARNING: JUDGE_PROVIDER=typesafe-api has no key configured. Set TYPESAFE_API_KEY; " +
      "judge calls will return fallback envelopes until a key is present.",
  );
}

// EntryType: SDK accepts a string or arbitrary JSON structure.
const entryType = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

// Field descriptions follow TypeSafe question-design guidance so calling
// models learn question construction from the schema itself.
const questionSpec = z
  .strictObject(
    {
    // type is schema-optional; the superRefine below rejects a missing type
    // with a caller-visible fix hint instead of a bare zod "required" error.
    type: z
      .enum(["noul", "choice", "score"])
      .optional()
      .describe(
        "noul = yes/no probability; choice = pick an option; score = ordered rating.",
      ),
    instructions: entryType
      .nullable()
      .optional()
      .describe(
        "Narrow, self-contained, predicate-positive question text; one trait per question.",
      ),
    // noul: {true, false} descriptions (optional). choice: {option: description|null}.
    // score: [level descriptions] (>= 2).
    criteria: z
      .union([
        z.record(
          z.string(),
          z.union([
            z.string().min(1),
            z.record(z.string(), z.unknown()),
            z.array(z.unknown()),
            z.null(),
          ]),
        ),
        z
          .array(z.unknown())
          .min(2),
      ])
      .optional()
      .describe(
        "choice: {option: description|null}; score: ordered level descriptions (2-10); omit for noul.",
      ),
    },
    // Unknown keys (e.g. a "choice": true shorthand) must reject, not be
    // stripped -- with a caller-visible fix hint naming the offending field.
    {
      error: (iss) => {
        const key = iss.keys?.[0] ?? iss.path?.at(-1);
        if (key === "choice" || key === "choices") {
          return `use "criteria", not "${key}"`;
        }
        return `unrecognized field "${key}"; use "type", "instructions", "criteria"`;
      },
    },
  )
  .superRefine((spec, ctx) => {
    // Zod-strict-layer fix hint for a missing type: names the expected shape
    // and fix instead of a bare "required" error.
    if (spec.type === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: 'missing "type" (noul|choice|score)',
      });
    }
    // API limit: choice questions accept at most 255 options.
    if (
      spec.type === "choice" &&
      spec.criteria &&
      !Array.isArray(spec.criteria) &&
      Object.keys(spec.criteria).length > 255
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message:
          "choice criteria supports at most 255 options; reduce options or split into multiple choice questions",
      });
    }
    // API limit: score questions accept at most 10 levels (kept out of the
    // zod .max() so the union still parses and this hint names the limit).
    if (Array.isArray(spec.criteria) && spec.criteria.length > 10) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message:
          "score criteria supports at most 10 levels; reduce levels or split into multiple score questions",
      });
    }
  });

// Questions map with pre-parse fix hints: an array (or other non-map) reaches
// the caller as a named hint rather than a bare zod "expected object" error.
const questionsSchema = z
  .union([z.record(z.string().min(1), questionSpec), z.array(z.unknown()), z.null()])
  .superRefine((qs, ctx) => {
    if (Array.isArray(qs)) {
      ctx.addIssue({
        code: "custom",
        message: 'expected a map of named question specs, got an array; use {name: {type: "noul", instructions: "..."}}',
      });
      return;
    }
    if (qs === null || qs === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'expected a map of named question specs; use {name: {type: "noul", instructions: "..."}}',
      });
    }
  });

const inputSchema = z.object({
  state: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()])
    .describe(
      "Application state the questions judge.",
    ),
  questions: questionsSchema.describe(
    'Map of name to question spec (type: noul|choice|score). Example: {is_bug: {type: "noul", instructions: "Is this a defect?"}}.',
  ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(60000)
    .optional()
    .describe("Optional per-request timeout cap in ms (max 60000)."),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional model override.",
    ),
  images: z
    .record(z.string().min(1), z.string().min(1))
    .optional()
    .describe(
      'Optional map of asset name to local PNG/JPEG file path (256-1568 px, max 16 MiB); path must be accessible from the server filesystem. Reference as <name> in noul/choice instructions. Preview, typesafe-api provider only.',
    ),
});

const outputSchema = z.object({
  answers: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Map of name to typed answer: noul -> {type: "noul", noul: number}; choice -> winning option name; score -> {type: "score", score, confidence, legend, probabilities}.',
    ),
  model: z.string().optional().describe("Producing model id."),
  usage: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Token usage metadata for the request."),
  fallback: z
    .boolean()
    .describe(
      "True when the judge failed; the request never blocks.",
    ),
  error: z.string().optional().describe("Present only when fallback is true."),
});

const { name, version } = createRequire(import.meta.url)("./package.json");

// Deep copy of a JSON-like value keeping only own enumerable keys except
// "__proto__" (prototype-pollution guard). Strings pass through; arrays and
// plain objects are rebuilt recursively.
function stripProtoKeys(value) {
  if (Array.isArray(value)) return value.map(stripProtoKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key !== "__proto__") out[key] = stripProtoKeys(value[key]);
    }
    return out;
  }
  return value;
}

// Payload size cap: {state, questions} serialized must stay within 256 KiB.
const MAX_PAYLOAD_BYTES = 262144;

// String-state parsing (issue #120): replay-measured 2026-11-16 across noul
// and score calls; answer deltas parsed-vs-unparsed were not material, so the
// parsing is intentionally NOT shipped. JSON-encoded string state is forwarded
// verbatim. See the measurement recorded on issue #120.

// Provider dispatch: sanitize inputs, enforce the payload cap, then hand off.
// Every error lands in the fallback envelope.
async function judgeHandler({ state, questions, images, timeout_ms, model }, ctx) {
  const cleanState = stripProtoKeys(state);
  const cleanQuestions = stripProtoKeys(questions);
  const cleanImages = stripProtoKeys(images);
  // Images are validated before any request: each entry must be referenced
  // by a noul/choice question as <name>, and each file is read, checked for
  // PNG/JPEG magic bytes, 256-1568 px per side, and the 16 MiB cap, then
  // base64-encoded (loadImagesFromPaths in providers/typesafe-api.mjs).
  try {
    validateImages(cleanQuestions, cleanImages);
  } catch (err) {
    return fallbackEnvelope(err && err.message ? err.message : "images validation failed");
  }
  let encodedImages;
  try {
    encodedImages = loadImagesFromPaths(cleanImages);
  } catch (err) {
    return fallbackEnvelope(err && err.message ? err.message : "image loading failed");
  }
  // Question specs are validated exactly once, inside typesafeJudge via
  // buildQuestion (providers/typesafe-api.mjs); per-spec hints flow through
  // fallbackFrom into the envelope. Schema-layer fix hints (missing type,
  // unknown keys, array questions, cardinality limits) fire in zod above.
  // Serialize once and measure UTF-8 bytes (Buffer.byteLength), not UTF-16
  // code units, so non-ASCII payloads cannot slip past the cap.
  const serialized = JSON.stringify({ state: cleanState, questions: cleanQuestions });
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    return fallbackEnvelope("payload exceeds 256 KiB limit");
  }
  const dispatch =
    provider === "cloudflare-workers-ai"
      ? async (args, c) => {
          try {
            const payload = await cloudflareJudge({
              state: args.state,
              questions: args.questions,
              images: args.images,
              model: args.model,
              timeout_ms: args.timeout_ms,
              signal: c?.signal,
            });
            return envelope(payload);
          } catch (err) {
            return fallbackFrom(err, "cloudflare request failed");
          }
        }
      : typesafeJudge;
  return dispatch(
    { state: cleanState, questions: cleanQuestions, images: encodedImages, timeout_ms, model },
    ctx,
  );
}

// Build the McpServer with the judge tool registered.
function buildServer() {
  const server = new McpServer(
    { name, version },
    {
      instructions:
        "Single 'judge' tool: sends application state plus typed questions (noul/choice/score) to the TypeSafe System One model in one request. See the judge tool description for the full contract and question example.",
    },
  );
  server.registerTool(
    "judge",
    {
      description:
        'Ask the TypeSafe System One model typed questions (noul/choice/score) about JSON application state in one fast request. Preview: optional images map of asset name to local PNG/JPEG file path (256-1568 px, max 16 MiB) enables image-backed noul/choice via <name> references in instructions. Default model jev-1.14.0, overridable via TYPESAFE_DEFAULT_MODEL or model. Returns {answers, model, usage} or {fallback: true, error}.',
      inputSchema,
      outputSchema,
      annotations: {
        title: "TypeSafe Judge",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    judgeHandler,
  );
  // Static, version-stamped decision-pattern prompts; resolution never
  // executes code beyond the pure text builders in prompts.mjs.
  for (const def of REGISTERED_PROMPTS) {
    server.registerPrompt(
      def.name,
      { title: def.title, description: def.description, argsSchema: def.argsSchema },
      (args) => def.build(args),
    );
  }
  return server;
}

// serveStdio owns per-connection factory instantiation and MCP era
// negotiation (protocolVersion), including the modern-only server/discover
// handler; legacy-pinned clients keep working (default legacy mode: serve).
await serveStdio(() => buildServer());
