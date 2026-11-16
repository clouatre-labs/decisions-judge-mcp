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
// Retries, timeouts, and default model resolution (pinned to jev-1.14.0 on
// the typesafe-api path) are owned by @typesafe-ai/sdk.
//
// Auth: TYPESAFE_API_KEY (resolved from the environment by the SDK).
//
// Any failure returns { fallback: true, error: "..." } with exit code 0 --
// never blocks, never prints the token.

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { cloudflareJudge } from "./providers/cloudflare-workers-ai.mjs";
import { REGISTERED_PROMPTS } from "./prompts.mjs";
import {
  envelope,
  fallbackEnvelope,
  fallbackFrom,
  typesafeJudge,
  validateQuestionSpec,
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
        "Question primitive: noul = yes/no probability, choice = pick among options, score = rating on ordered levels.",
      ),
    instructions: entryType
      .nullable()
      .optional()
      .describe(
        "Narrow, self-contained question text. Predicate-positive: a yes must affirm the trait, never negate it. One trait per question; no double-barreled or degree-worded noul questions. A flat confidence distribution across many requests means the question is under-specified.",
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
        z.array(z.unknown()).min(2),
      ])
      .optional()
      .describe(
        "Per-option definitions for choice (option name -> description) or ordered level descriptions for score (array, >= 2). Prefer structured levels of the shape {summary, signals[]} over free text. Optional for noul.",
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
  });

// Questions map with pre-parse fix hints: an array (or other non-map) reaches
// the caller as a named hint rather than a bare zod "expected object" error.
const questionsSchema = z
  .union([z.record(z.string().min(1), questionSpec), z.array(z.unknown()), z.null(), z.undefined()])
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
      "Everything the questions need to be answered. Questions judge only what state contains, so include all relevant application state here.",
    ),
  questions: questionsSchema.describe(
    'Map of question name to question spec. Ask many narrow, atomic questions in one request: questions run in parallel in a single fast call, which is far cheaper and faster than one call per question. Ignore answers to questions you do not need. Example: {is_bug: {type: "noul", instructions: "Is this a defect?"}, severity: {type: "score", instructions: "How severe is the defect?", criteria: ["low", "high"]}}.',
  ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(60000)
    .optional()
    .describe("Optional per-request timeout cap in milliseconds; maximum 60000."),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional model override. Pin a specific model id (e.g. jev-1.14.0) rather than jev-latest when answers feed calibration or repeatable decisions.",
    ),
});

const outputSchema = z.object({
  answers: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Map of question name to typed answer: noul answers carry yes/no with a probability, choice answers name the selected option, score answers give the chosen level.",
    ),
  model: z.string().optional().describe("Model id that produced the answers."),
  usage: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Token usage metadata for the request."),
  fallback: z
    .boolean()
    .describe(
      "True when the judge failed and no answers are available; the request never blocks or throws.",
    ),
  error: z.string().optional().describe("Failure reason; present only when fallback is true."),
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

// String-state parsing (issue #120, measure-first): JSON-encoded string state
// is parsed to an object/array before dispatch. GATED OFF pending replay
// measurement of the answer delta -- flip to true to ship in one line.
const ENABLE_STRING_STATE_PARSE = false;

// Parse a JSON-encoded string into an object or array; non-JSON strings (and
// JSON primitives like "42") pass through unchanged.
function parseStringState(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // non-JSON string: pass through unchanged
  }
  return value;
}

// Provider dispatch: sanitize inputs, enforce the payload cap, then hand off.
// Every error lands in the fallback envelope.
async function judgeHandler({ state, questions, timeout_ms, model }, ctx) {
  const cleanState = stripProtoKeys(
    ENABLE_STRING_STATE_PARSE ? parseStringState(state) : state,
  );
  const cleanQuestions = stripProtoKeys(questions);
  try {
    for (const [name, spec] of Object.entries(cleanQuestions)) {
      validateQuestionSpec(spec, name);
    }
  } catch (err) {
    return fallbackEnvelope(
      err && err.message ? err.message : "question construction failed",
    );
  }
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
  return dispatch({ state: cleanState, questions: cleanQuestions, timeout_ms, model }, ctx);
}

// Build the McpServer with the judge tool registered.
function buildServer() {
  const server = new McpServer(
    { name, version },
    {
      instructions:
        "MCP server exposing a single 'judge' tool that sends application state plus typed questions (noul yes/no probability, choice among options, score on ordered levels) to the TypeSafe System One model and returns structured answers with model/usage metadata. Default model is pinned to jev-1.14.0 on the typesafe-api path. All questions are answered in one request; failures return a {fallback: true, error} envelope instead of blocking.",
    },
  );
  server.registerTool(
    "judge",
    {
      description:
        "Ask the TypeSafe System One model (Jev) typed questions (noul yes/no probability, choice among options, score on ordered levels) about JSON application state. Default model is pinned to jev-1.14.0 on the typesafe-api path. All questions are answered in one fast request. Returns {answers, model, usage} on success or {fallback: true, error} on any failure.",
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

const server = buildServer();
const transport = new StdioServerTransport();
await server.connect(transport);
