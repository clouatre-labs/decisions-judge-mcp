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

// Opt-in Cloudflare Workers AI provider. Explicit selection only: never
// inferred from which env vars happen to be set. Minimal retry policy: only
// 429 and transport errors are retried; auth (401/403) and other 4xx
// (including 402 AI Gateway prepaid-credit errors) fail fast. Abort-aware via
// an AbortController combining timeout_ms and the caller's signal.
const CF_RETRY_LIMIT = 2;
const CF_BACKOFF_MS = 500;

function cfErrorEnvelopeMessage(body) {
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const messages = body.errors
      .map((e) => (e && typeof e === "object" && e.message ? e.message : String(e)))
      .filter(Boolean);
    if (messages.length > 0) return messages.join("; ");
  }
  return null;
}

// Cloudflare account ids are 32 hex chars; reject anything else (empty,
// whitespace, path-unsafe characters) before URL interpolation.
const CF_ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

async function cloudflareJudge({ state, questions, model, timeout_ms, signal }) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) {
    throw new Error("cloudflare provider requires CLOUDFLARE_API_TOKEN in the environment");
  }
  if (!accountId) {
    throw new Error("cloudflare provider requires CLOUDFLARE_ACCOUNT_ID in the environment");
  }
  if (!CF_ACCOUNT_ID_RE.test(accountId)) {
    throw new Error("cloudflare provider requires CLOUDFLARE_ACCOUNT_ID to be a 32-character hex account id");
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeout_ms
    ? setTimeout(() => controller.abort(), timeout_ms)
    : undefined;
  try {
    if (controller.signal.aborted) throw new Error("request aborted");
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
    const body = JSON.stringify({
      model: model ?? "typesafe/jev",
      input: { state, questions },
    });
    let lastErr = null;
    for (let attempt = 0; attempt <= CF_RETRY_LIMIT; attempt++) {
      if (attempt > 0) {
        if (controller.signal.aborted) throw new Error("request aborted");
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, CF_BACKOFF_MS * attempt);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("request aborted"));
            },
            { once: true },
          );
        });
        if (controller.signal.aborted) throw new Error("request aborted");
      }
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw err;
        lastErr = err;
        continue;
      }
      if (res.status === 429 && attempt < CF_RETRY_LIMIT) {
        // Consume/cancel the 429 body before backing off.
        try {
          await res.arrayBuffer();
        } catch {
          res.body?.cancel().catch(() => {});
        }
        lastErr = new Error("cloudflare rate limited");
        lastErr.status = res.status;
        continue;
      }
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        const err = new Error(cfErrorEnvelopeMessage(parsed) ?? "cloudflare request failed");
        err.status = res.status;
        throw err;
      }
      // Defensive unwrap of Cloudflare's REST envelope; unexpected shapes are
      // errors, never crashes.
      const outer = parsed && typeof parsed === "object" ? parsed.result : undefined;
      const evaluation = outer && typeof outer === "object" ? outer.result : undefined;
      if (
        parsed?.success !== true ||
        !outer ||
        typeof outer !== "object" ||
        outer.state !== "Completed" ||
        !evaluation ||
        typeof evaluation !== "object" ||
        !evaluation.answers ||
        typeof evaluation.answers !== "object"
      ) {
        const err = new Error(
          cfErrorEnvelopeMessage(parsed) ??
            "cloudflare returned an unexpected response envelope",
        );
        err.status = res.status;
        throw err;
      }
      return {
        answers: evaluation.answers,
        model: evaluation.model ?? model ?? "typesafe/jev",
        usage: evaluation.usage,
        fallback: false,
      };
    }
    throw lastErr ?? new Error("cloudflare request failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
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
