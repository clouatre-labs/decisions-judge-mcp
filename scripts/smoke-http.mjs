// Smoke test: start the MCP server in HTTP mode (JUDGE_TRANSPORT=http), send
// an MCP initialize JSON-RPC POST to /mcp, and assert a 200 response whose
// result contains serverInfo; then assert GET /mcp is rejected with 405 per
// the MCP 2026-07-28 spec (legacy GET streams removed). Exits 0 on success,
// non-zero on any failure or timeout. Does not require TYPESAFE_API_KEY (the
// key is only needed for actual judge calls).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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

console.log(
  `smoke-http: OK (server ${result.serverInfo.name}@${result.serverInfo.version}, initialize 200, GET 405, oversized 413)`,
);
proc.kill("SIGKILL");
process.exit(0);
