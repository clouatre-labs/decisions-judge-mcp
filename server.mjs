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
  provider: z.enum(["typesafe", "cloudflare"]).default("typesafe"),
});

// Criteria checks shared by both provider paths. Runs before any provider
// call so malformed questions return the documented fallback error (never an
// API request). Does not couple to the SDK builders.
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

function buildQuestion(spec) {
  validateQuestionSpec(spec);
  if (spec.type === "choice") {
    return choice(spec.instructions, spec.criteria);
  }
  if (spec.type === "score") {
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
      "MCP stdio server exposing a single 'judge' tool that sends application state plus typed questions (noul yes/no probability, choice among options, or score on ordered levels) to the TypeSafe System One model (or, with provider: 'cloudflare', the same Jev model via Cloudflare Workers AI) and returns structured answers with model/usage metadata. All questions are answered in one request; failures return a {fallback: true, error} envelope instead of blocking.",
  },
);

server.registerTool(
  "judge",
  {
    description:
      "Ask the TypeSafe System One model (Jev) typed questions (noul yes/no probability, choice among options, score on ordered levels) about JSON application state. Defaults to the TypeSafe provider; pass provider: 'cloudflare' to route the same Jev model through Cloudflare Workers AI (requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID). All questions are answered in one fast request. Returns {answers, model, usage} on success or {fallback: true, error} on any failure.",
    inputSchema,
    outputSchema,
    annotations: {
      title: "TypeSafe Judge",
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ state, questions, timeout_ms, model, provider }, ctx) => {
    // Opt-in Cloudflare branch: validate question criteria BEFORE any provider
    // call or env check so malformed questions return the same documented
    // fallback error as the typesafe path, never an API request.
    if (provider === "cloudflare") {
      try {
        for (const spec of Object.values(questions)) validateQuestionSpec(spec);
      } catch (err) {
        const payload = {
          fallback: true,
          error: err && err.message ? err.message : "question construction failed",
        };
        return {
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
      }
      try {
        const payload = await cloudflareJudge({
          state,
          questions,
          model,
          timeout_ms,
          signal: ctx?.signal,
        });
        return {
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
      } catch (err) {
        const message = err && err.message ? err.message : "cloudflare request failed";
        const payload = {
          fallback: true,
          error: typeof err?.status === "number" ? `${message} (HTTP ${err.status})` : message,
        };
        return {
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
      }
    }
    let qmap;
    try {
      qmap = Object.fromEntries(
        Object.entries(questions).map(([name, spec]) => [name, buildQuestion(spec)]),
      );
    } catch (err) {
      const payload = {
        fallback: true,
        error: err && err.message ? err.message : "question construction failed",
      };
      return {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
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
      const payload = {
        answers: result.answers,
        model: result.model,
        usage: result.usage,
        fallback: false,
      };
      return {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    } catch (err) {
      const message = err && err.message ? err.message : "typesafe request failed";
      const payload = {
        fallback: true,
        error: typeof err?.status === "number" ? `${message} (HTTP ${err.status})` : message,
      };
      return {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
