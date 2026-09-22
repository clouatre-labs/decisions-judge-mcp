#!/usr/bin/env node
// MCP stdio server exposing ONE tool: judge.
//
// The judge tool sends application state (object, string, or array) plus typed
// questions (noul / choice / score) to the TypeSafe System One API in a single
// request and returns the raw typed answers plus model/usage metadata.
// Instructions and criteria values accept strings or arbitrary JSON structure
// (EntryType); an optional model override is honored. Client disconnects abort
// the in-flight request. Retries, timeouts, and model resolution (jev-latest)
// are owned by @typesafe-ai/sdk.
//
// Auth: TYPESAFE_API_KEY (SDK standard).
//
// Any failure returns { fallback: true, error: "..." } with exit code 0 --
// never blocks, never prints the token.

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import { cloudflareJudge } from "./providers/cloudflare.mjs";

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

// EntryType: SDK accepts a string or arbitrary JSON structure.
const entryType = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const questionSpec = z.object({
  type: z.enum(["noul", "choice", "score"]).default("noul"),
  instructions: entryType.nullable().optional(),
  // noul: {true, false} descriptions (optional). choice: {option: description|null}.
  // score: [level descriptions] (>= 2).
  criteria: z.union([
    z.record(
      z.string(),
      z.union([z.string().min(1), z.record(z.string(), z.unknown()), z.array(z.unknown()), z.null()]),
    ),
    z.array(z.unknown()).min(2),
  ]).optional(),
});

const inputSchema = z.object({
  state: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]),
  questions: z.record(z.string().min(1), questionSpec),
  timeout_ms: z.number().int().positive().max(60000).optional(),
  model: z.string().min(1).optional(),
});

// Criteria checks shared by both provider paths. Runs before any provider
// call so malformed questions return the documented fallback error (never an
// API request).
function validateQuestionSpec(spec) {
  if (spec.type === "choice") {
    if (!spec.criteria || Array.isArray(spec.criteria) || typeof spec.criteria !== "object") {
      throw new Error(`choice question requires criteria as an object of {option: description}`);
    }
  } else if (spec.type === "score") {
    if (!Array.isArray(spec.criteria) || spec.criteria.length < 2) {
      throw new Error(`score question requires criteria as an ordered array of at least two level descriptions`);
    }
  }
}

function envelope(payload) {
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function fallbackEnvelope(error) {
  return envelope({ fallback: true, error });
}

function buildQuestion(spec) {
  if (spec.type === "choice") {
    if (!spec.criteria || Array.isArray(spec.criteria) || typeof spec.criteria !== "object") {
      throw new Error(`choice question requires criteria as an object of {option: description}`);
    }
    return choice(spec.instructions, spec.criteria);
  }
  if (spec.type === "score") {
    if (!Array.isArray(spec.criteria) || spec.criteria.length < 2) {
      throw new Error(`score question requires criteria as an ordered array of at least two level descriptions`);
    }
    return score(spec.instructions, spec.criteria);
  }
  return noul(spec.instructions, spec.criteria);
}

const outputSchema = z.object({
  answers: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  fallback: z.boolean(),
  error: z.string().optional(),
});

// Lazily-created client, cached for the process lifetime; auth via TYPESAFE_API_KEY.
let client;
function getClient() {
  return (client ??= new TypeSafeClient({ logLevel: "off" }));
}

const { name, version } = createRequire(import.meta.url)("./package.json");

const server = new McpServer(
  { name, version },
  {
    instructions:
      "MCP stdio server exposing a single 'judge' tool that sends application state plus typed questions (noul yes/no probability, choice among options, or score on ordered levels) to the TypeSafe System One model and returns structured answers with model/usage metadata. All questions are answered in one request; failures return a {fallback: true, error} envelope instead of blocking.",
  },
);

// Typesafe path (default): buildQuestion applies the same criteria checks as
// validateQuestionSpec and constructs the SDK question objects.
async function typesafeJudge({ state, questions, timeout_ms, model }, ctx) {
  let qmap;
  try {
    qmap = Object.fromEntries(
      Object.entries(questions).map(([name, spec]) => [name, buildQuestion(spec)]),
    );
  } catch (err) {
    return fallbackEnvelope(
      err && err.message ? err.message : "question construction failed",
    );
  }
  try {
    const request = { state, questions: qmap };
    if (model) request.model = model;
    const options = timeout_ms
      ? { timeout: timeout_ms, signal: ctx?.signal }
      : ctx?.signal
        ? { signal: ctx.signal }
        : undefined;
    const result = await getClient().systemOne(request, options);
    return envelope({
      answers: result.answers,
      model: result.model,
      usage: result.usage,
      fallback: false,
    });
  } catch (err) {
    const message = err && err.message ? err.message : "typesafe request failed";
    return fallbackEnvelope(
      typeof err?.status === "number" ? `${message} (HTTP ${err.status})` : message,
    );
  }
}

// Cloudflare path: validate the question specs before any provider call, then
// hand off to the provider. Every error lands in the fallback envelope.
async function cloudflareHandler({ state, questions, timeout_ms, model }, ctx) {
  try {
    for (const spec of Object.values(questions)) validateQuestionSpec(spec);
  } catch (err) {
    return fallbackEnvelope(
      err && err.message ? err.message : "question construction failed",
    );
  }
  try {
    const payload = await cloudflareJudge({
      state,
      questions,
      model,
      timeout_ms,
      signal: ctx?.signal,
    });
    return envelope(payload);
  } catch (err) {
    const message = err && err.message ? err.message : "cloudflare request failed";
    return fallbackEnvelope(
      typeof err?.status === "number" ? `${message} (HTTP ${err.status})` : message,
    );
  }
}

const judgeHandler =
  provider === "cloudflare-workers-ai" ? cloudflareHandler : typesafeJudge;

server.registerTool(
  "judge",
  {
    description:
      "Ask the TypeSafe System One model (Jev) typed questions (noul yes/no probability, choice among options, score on ordered levels) about JSON application state. All questions are answered in one fast request. Returns {answers, model, usage} on success or {fallback: true, error} on any failure.",
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

const transport = new StdioServerTransport();
await server.connect(transport);
