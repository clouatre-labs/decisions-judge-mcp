#!/usr/bin/env node
// MCP server exposing ONE tool: judge, over two opt-in transports.
//
// Transports (JUDGE_TRANSPORT):
// - "stdio" (default): newline-delimited JSON-RPC over stdin/stdout, for
//   local MCP clients (Claude Code, codex, goose, pi).
// - "http": Streamable HTTP per MCP spec revision 2026-07-28. Serves POST
//   /mcp only; GET and DELETE on /mcp are answered 405 (legacy GET streams
//   are removed in that revision) and any other path 404. Stateless: each
//   request is served by a fresh McpServer instance from the same factory
//   via createMcpHandler (the SDK's per-request serving; no protocol-level
//   sessions). NOT authenticated -- production remote deployments must be
//   fronted by an authenticating OAuth 2.1 proxy per the MCP 2026-07-28
//   authorization specification.
//
// The judge tool sends application state (object, string, or array) plus typed
// questions (noul / choice / score) to the TypeSafe System One API in a single
// request and returns the raw typed answers plus model/usage metadata.
// Instructions and criteria values accept strings or arbitrary JSON structure
// (EntryType); an optional model override is honored. Client disconnects abort
// the in-flight request. Question specs are validated before any provider
// call, and {state, questions} payloads exceeding 256 KiB are rejected, both
// via the shared checks in providers/typesafe-api.mjs. Retries, timeouts, and
// model resolution (jev-latest) are owned by @typesafe-ai/sdk.
//
// Auth: TYPESAFE_API_KEY (SDK standard).
//
// Any failure returns { fallback: true, error: "..." } with exit code 0 --
// never blocks, never prints the token.

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { cloudflareJudge } from "./providers/cloudflare-workers-ai.mjs";
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

const outputSchema = z.object({
  answers: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  fallback: z.boolean(),
  error: z.string().optional(),
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

// Provider dispatch: sanitize inputs, enforce the payload cap, then hand off.
// Every error lands in the fallback envelope.
async function judgeHandler({ state, questions, timeout_ms, model }, ctx) {
  const cleanState = stripProtoKeys(state);
  const cleanQuestions = stripProtoKeys(questions);
  try {
    for (const spec of Object.values(cleanQuestions)) validateQuestionSpec(spec);
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

// Build the McpServer with the judge tool registered. Shared by both
// transports: stdio connects one long-lived instance; HTTP calls this once
// per request (stateless serving, no protocol-level sessions).
function buildServer() {
  const server = new McpServer(
    { name, version },
    {
      instructions:
        "MCP server exposing a single 'judge' tool that sends application state plus typed questions (noul yes/no probability, choice among options, or score on ordered levels) to the TypeSafe System One model and returns structured answers with model/usage metadata. All questions are answered in one request; failures return a {fallback: true, error} envelope instead of blocking.",
    },
  );
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
  return server;
}

// Startup transport selection: JUDGE_TRANSPORT is read exactly once, at
// server startup. Explicit selection only -- no inference from other env.
const VALID_TRANSPORTS = ["stdio", "http"];
const transportName = process.env.JUDGE_TRANSPORT || "stdio";
if (!VALID_TRANSPORTS.includes(transportName)) {
  console.error(
    `JUDGE_TRANSPORT must be one of: ${VALID_TRANSPORTS.join(", ")} (got "${transportName}")`,
  );
  process.exit(1);
}

if (transportName === "http") {
  const host = process.env.HTTP_HOST || "127.0.0.1";
  const port = Number(process.env.HTTP_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(
      `HTTP_PORT must be an integer between 1 and 65535 (got "${process.env.HTTP_PORT}")`,
    );
    process.exit(1);
  }
  console.error(
    "WARNING: HTTP transport is UNAUTHENTICATED. Production remote deployments " +
      "must be fronted by an authenticating OAuth 2.1 proxy per the MCP " +
      "2026-07-28 authorization specification.",
  );
  // Stateless modern serving: createMcpHandler builds a per-request McpServer
  // from the factory (equivalent to the sessionIdGenerator: undefined idiom)
  // and answers GET/DELETE on the endpoint with 405 per the 2026-07-28 spec.
  const handler = createMcpHandler(() => buildServer());
  const httpServer = createServer(async (req, res) => {
    if (req.url?.split("?")[0] !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, { allow: "POST" });
      res.end("Method not allowed.");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end("Method not allowed.");
      return;
    }
    try {
      // Convert the node:http exchange to a WHATWG Request (Node >= 18 has
      // global Request/Response); only POSTs reach here, so always read body.
      const url = `http://${req.headers.host ?? `${host}:${port}`}${req.url}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ReadableStream.from(req),
        duplex: "half",
      });
      const response = await handler.fetch(request);
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      res.writeHead(response.status, responseHeaders);
      if (response.body) {
        await ReadableStream.from(response.body).pipeTo(
          new WritableStream({
            write: (chunk) => res.write(chunk),
          }),
        );
      } else {
        res.end();
      }
    } catch (err) {
      console.error(`http request failed: ${err && err.message ? err.message : err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
  httpServer.listen(port, host, () => {
    console.error(`decisions-judge-mcp listening on http://${host}:${port}/mcp`);
  });
} else {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
