#!/usr/bin/env node
// MCP stdio server exposing ONE tool: judge.
//
// The judge tool sends application state plus typed questions (noul / choice /
// score) to the TypeSafe System One API in a single request and returns the
// raw typed answers plus model/usage metadata. Retries, timeouts, and model
// resolution (jev-latest) are owned by @typesafe-ai/sdk.
//
// Auth: TYPESAFE_API_KEY (SDK standard); TYPESAFE_AI_TOKEN is accepted as a
// fallback for backward compatibility with the retired bash script.
//
// Any failure returns { fallback: true, error: "..." } with exit code 0 --
// never blocks, never prints the token.

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

if (!process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_AI_TOKEN) {
  process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_AI_TOKEN;
}

const questionSpec = z.object({
  type: z.enum(["noul", "choice", "score"]).default("noul"),
  instructions: z.string().min(1),
  // noul: null/omitted. choice: {option: description|null}. score: [level descriptions].
  criteria: z.union([z.record(z.string(), z.string().nullable()), z.array(z.string())]).optional(),
});

const inputSchema = {
  state: z.union([z.record(z.string(), z.unknown()), z.string()]),
  questions: z.record(z.string().min(1), questionSpec),
  timeout_ms: z.number().int().positive().max(60000).optional(),
};

function buildQuestion(spec) {
  if (spec.type === "choice") {
    if (!spec.criteria || Array.isArray(spec.criteria) || typeof spec.criteria !== "object") {
      throw new Error(`choice question requires criteria as an object of {option: description}`);
    }
    return choice(spec.instructions, spec.criteria);
  }
  if (spec.type === "score") {
    if (!Array.isArray(spec.criteria) || spec.criteria.length === 0) {
      throw new Error(`score question requires criteria as an ordered array of level descriptions`);
    }
    return score(spec.instructions, spec.criteria);
  }
  return noul(spec.instructions);
}

const outputSchema = {
  answers: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  fallback: z.boolean(),
  error: z.string().optional(),
};

const { name, version } = createRequire(import.meta.url)("./package.json");

const server = new McpServer(
  { name, version },
  {
    instructions:
      "MCP stdio server exposing a single 'judge' tool that sends application state plus typed questions (noul yes/no probability, choice among options, or score on ordered levels) to the TypeSafe System One model and returns structured answers with model/usage metadata. All questions are answered in one request; failures return a {fallback: true, error} envelope instead of blocking.",
  },
);

server.registerTool(
  "judge",
  {
    description:
      "Ask the TypeSafe System One model (Jev) typed questions (noul yes/no probability, choice among options, score on ordered levels) about JSON application state. All questions are answered in one fast request. Returns {answers, model, usage} on success or {fallback: true, error} on any failure.",
    inputSchema,
    outputSchema,
  },
  async ({ state, questions, timeout_ms }) => {
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
      const client = new TypeSafeClient();
      const result = await client.systemOne(
        { state, questions: qmap },
        timeout_ms ? { timeout: timeout_ms } : undefined,
      );
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
      const payload = {
        fallback: true,
        error: err && err.message ? err.message : "typesafe request failed",
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
