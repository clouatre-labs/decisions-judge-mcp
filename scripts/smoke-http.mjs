// Smoke test: start the MCP server in HTTP mode (JUDGE_TRANSPORT=http), send
// an MCP initialize JSON-RPC POST to /mcp, and assert a 200 response whose
// result contains serverInfo; then assert GET /mcp is rejected with 405 per
// the MCP 2026-07-28 spec (legacy GET streams removed). Exits 0 on success,
// non-zero on any failure or timeout. Does not require TYPESAFE_API_KEY (the
// key is only needed for actual judge calls).
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";

const TIMEOUT_MS = 10_000;

// Grab a random free port by binding port 0 and reading the assigned port.
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
probe.close();
await once(probe, "close");

const proc = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, JUDGE_TRANSPORT: "http", HTTP_PORT: String(port) },
  stdio: ["ignore", "ignore", "pipe"],
});

function fail(msg) {
  console.error(`smoke-http: FAIL: ${msg}`);
  proc.kill("SIGKILL");
  process.exit(1);
}

const timer = setTimeout(
  () => fail(`no initialize response within ${TIMEOUT_MS}ms`),
  TIMEOUT_MS,
);

// Wait until the server accepts connections (it prints a listen line on
// stderr, but polling keeps this independent of log formatting).
for (let attempt = 0; attempt < 50; attempt++) {
  const ok = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "OPTIONS" })
    .then(() => true)
    .catch(() => false);
  if (ok) break;
  if (attempt === 49) fail("server did not start listening within timeout");
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const request = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "smoke-http-test", version: "0.0.0" },
  },
};

const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify(request),
}).catch((err) => fail(`POST /mcp failed: ${err.message}`));

if (response.status !== 200) {
  fail(`POST /mcp returned status ${response.status}, expected 200`);
}

const contentType = response.headers.get("content-type") ?? "";
let result;
if (contentType.includes("text/event-stream")) {
  // The SSE stream stays open (keep-alive), so read incrementally until the
  // initialize response frame arrives rather than draining to EOF.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const dataLines = buffer
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (const dataLine of dataLines) {
      try {
        const msg = JSON.parse(dataLine);
        if (msg.id === 1) {
          result = msg.result;
          break outer;
        }
      } catch {
        // partial frame; keep reading
      }
    }
  }
  clearTimeout(timer);
} else {
  let msg;
  try {
    msg = await response.json();
  } catch {
    fail("POST /mcp response was neither JSON nor SSE");
  }
  result = msg.result;
  clearTimeout(timer);
}
if (!result || !result.serverInfo) {
  fail(`initialize result missing serverInfo: ${JSON.stringify(result).slice(0, 300)}`);
}
if (result.serverInfo.name !== "decisions-judge-mcp") {
  fail(`unexpected server name: ${result.serverInfo.name}`);
}

// Prompts over HTTP: prompts/list and one prompts/get against /mcp. Responses
// may arrive as plain JSON or as an SSE stream; parse incrementally until the
// frame with the expected id arrives, then cancel the stream.
async function postRpc(id, method, params) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }).catch((err) => fail(`POST /mcp failed: ${err.message}`));
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      fail(`POST /mcp response is not JSON: ${text.slice(0, 200)}`);
    }
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const dataLines = buffer
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (const dataLine of dataLines) {
      let msg;
      try {
        msg = JSON.parse(dataLine);
      } catch {
        continue; // partial frame; keep reading
      }
      if (msg.id === id) {
        await reader.cancel().catch(() => {});
        return msg;
      }
    }
  }
  return fail(`POST /mcp SSE stream ended without a response for id ${id}`);
}

const listMsg = await postRpc(2, "prompts/list", {});
const promptNames = (listMsg.result?.prompts ?? []).map((p) => p.name).sort();
for (const expected of ["verify-claim", "classify", "route"]) {
  if (!promptNames.includes(expected)) {
    fail(`prompts/list missing "${expected}": got ${JSON.stringify(promptNames)}`);
  }
}

const getMsg = await postRpc(3, "prompts/get", { name: "verify-claim", arguments: { state: "{}" } });
const promptMessages = getMsg.result?.messages;
if (!Array.isArray(promptMessages) || promptMessages.length !== 1) {
  fail(`prompts/get verify-claim expected exactly one message: ${JSON.stringify(getMsg).slice(0, 300)}`);
}
const pm = promptMessages[0];
if (pm.role !== "user" || pm.content?.type !== "text" || typeof pm.content.text !== "string") {
  fail(`prompts/get verify-claim wrong message shape: ${JSON.stringify(pm).slice(0, 300)}`);
}
if (!pm.content.text.includes("wording-v1") || !pm.content.text.includes("judge")) {
  fail(`prompts/get verify-claim text missing version stamp or judge skeleton: ${pm.content.text.slice(0, 200)}`);
}
if (!pm.content.text.includes('"type": "noul"') && !pm.content.text.includes('"type":"noul"')) {
  fail(`prompts/get verify-claim text missing noul question type: ${pm.content.text.slice(0, 300)}`);
}
if (!pm.content.text.includes("claim_supported")) {
  fail(`prompts/get verify-claim text missing claim_supported question key: ${pm.content.text.slice(0, 300)}`);
}
// The embedded skeleton must parse as JSON whose questions field is an
// object map (matching the judge tool's questions record schema), not
// an array of single-key objects.
const skeletonText = pm.content.text.split("\n\n").pop();
let parsedSkeleton;
try {
  parsedSkeleton = JSON.parse(skeletonText);
} catch (err) {
  fail(`prompts/get verify-claim skeleton is not parseable JSON: ${err.message}`);
}
if (
  typeof parsedSkeleton?.arguments?.questions !== "object" ||
  parsedSkeleton.arguments.questions === null ||
  Array.isArray(parsedSkeleton.arguments.questions) ||
  !("claim_supported" in parsedSkeleton.arguments.questions)
) {
  fail(`prompts/get verify-claim questions must be an object map with claim_supported: ${skeletonText.slice(0, 200)}`);
}
console.log(`smoke-http: prompts OK (${promptNames.join(", ")}); verify-claim wording-v1, questions rendered as object map`);

// prompts/get with an unknown name must return a JSON-RPC error.
const unknownMsg = await postRpc(4, "prompts/get", { name: "no-such-prompt", arguments: {} });
if (!unknownMsg.error || typeof unknownMsg.error.code !== "number") {
  fail(`prompts/get unknown name expected a JSON-RPC error: ${JSON.stringify(unknownMsg).slice(0, 300)}`);
}
console.log(`smoke-http: prompts/get unknown OK (JSON-RPC error ${unknownMsg.error.code})`);

// GET /mcp must be 405: the 2026-07-28 revision removed legacy GET streams.
const getResponse = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" }).catch(
  (err) => fail(`GET /mcp failed: ${err.message}`),
);
if (getResponse.status !== 405) {
  fail(`GET /mcp returned status ${getResponse.status}, expected 405`);
}

// A declared-oversized body must be rejected with 413 before parsing.
const oversizedBody = "x".repeat(400 * 1024);
const oversized = await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: oversizedBody,
}).catch((err) => fail(`oversized POST /mcp failed: ${err.message}`));
if (oversized.status !== 413) {
  fail(`oversized POST /mcp returned status ${oversized.status}, expected 413`);
}

// 1. Mid-request client disconnect: fire a POST and destroy the socket
// before the response arrives. The handler wires an AbortController to the
// response "close" event, so the in-flight work must abort and the server
// must stay healthy for the next request.
await new Promise((resolve) => {
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    },
    (res) => res.resume(),
  );
  req.on("error", () => {}); // expected: socket destroyed client-side
  req.end(JSON.stringify(request), () => req.destroy());
  // The destroy resolves independently of any response; give the server a
  // moment to observe the closed socket, then move on.
  setTimeout(resolve, 250);
});

// 2. Malformed JSON-RPC payload must produce a well-formed JSON-RPC error
// response (jsonrpc field plus error object), never a crash or hang.
const malformed = await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: "{not valid json",
}).catch((err) => fail(`malformed POST /mcp failed: ${err.message}`));
const malformedText = await malformed.text();
let malformedMsg;
try {
  malformedMsg = JSON.parse(malformedText);
} catch {
  fail(`malformed body response is not JSON: ${malformedText.slice(0, 200)}`);
}
if (malformedMsg.jsonrpc !== "2.0" || !malformedMsg.error) {
  fail(
    `malformed body did not yield a JSON-RPC error response: ${malformedText.slice(0, 200)}`,
  );
}

// 3. Failure after response headers are committed: read part of an SSE
// initialize response, then destroy the socket mid-stream. The handler must
// destroy the connection (the #57 fix) rather than append a JSON error body,
// and must stay healthy afterwards.
await new Promise((resolve, reject) => {
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    },
    (res) => {
      // Headers are committed; consume a chunk then tear down the socket.
      res.once("data", () => {
        res.destroy();
        req.destroy();
        resolve();
      });
      res.on("error", () => resolve()); // expected on destroy
    },
  );
  req.on("error", () => resolve()); // expected on destroy
  req.end(JSON.stringify(request));
  setTimeout(() => resolve(), 5000);
}).catch((err) => fail(`mid-stream disconnect case failed: ${err.message}`));

// Liveness check: after all three adversarial exchanges the server must
// still answer a fresh initialize with 200.
const healthy = await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify(request),
}).catch((err) => fail(`post-abuse liveness POST failed: ${err.message}`));
if (healthy.status !== 200) {
  fail(`post-abuse liveness POST returned ${healthy.status}, expected 200`);
}
// Drain the liveness response body so the socket is released.
await healthy.arrayBuffer().catch((err) => fail(`liveness drain failed: ${err.message}`));

console.log(
  `smoke-http: OK (server ${result.serverInfo.name}@${result.serverInfo.version}, initialize 200, GET 405, oversized 413, disconnect survived, malformed JSON-RPC error, mid-stream destroy survived)`,
);
proc.kill("SIGKILL");
process.exit(0);
