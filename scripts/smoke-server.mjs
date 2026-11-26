// Smoke test for the MCP stdio server (no network, no API key): starts
// server.mjs, performs the initialize handshake, lists tools and prompts,
// calls the judge tool expecting a fallback envelope (keyless by design),
// and calls it with invalid input expecting a tool error. Exits 0 on
// success, non-zero on any failure or timeout.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 30_000;

const proc = spawn(process.execPath, ["server.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, TYPESAFE_API_KEY: "" },
});

function fail(msg) {
  console.error(`smoke-server: FAIL: ${msg}`);
  proc.kill("SIGKILL");
  process.exit(1);
}

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

let buffer = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (chunk) => {
  buffer += chunk;
  // MCP stdio framing: newline-delimited JSON messages.
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`unparseable message: ${line.slice(0, 120)}`);
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

proc.on("exit", (code) => {
  if (code !== 0 && code !== null) fail(`server exited with code ${code}`);
});

function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// Arrange: initialize handshake.
const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-server", version: "0.0.0" },
});
if (!init.result?.serverInfo?.name) fail("initialize handshake failed");
send({ jsonrpc: "2.0", method: "notifications/initialized" });

// Act: list tools; the judge tool must be advertised.
const tools = await request("tools/list", {});
const judge = tools.result?.tools?.find((t) => t.name === "judge");
if (!judge) fail("judge tool not advertised");

// Act: judge call without an API key must return a fallback envelope, not hang.
const ok = await request("tools/call", {
  name: "judge",
  arguments: {
    state: { build: "green" },
    questions: { is_bug: { type: "noul", instructions: "Is this a defect?" } },
  },
});
const text = ok.result?.content?.[0]?.text;
if (typeof text !== "string") fail("judge call returned no text content");
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  fail(`judge output is not JSON: ${text.slice(0, 120)}`);
}
if (parsed.fallback !== true || typeof parsed.error !== "string") {
  fail(`expected fallback envelope, got: ${text.slice(0, 120)}`);
}

// Act: invalid input (questions as array) must return a tool error, not crash.
const bad = await request("tools/call", {
  name: "judge",
  arguments: { state: {}, questions: ["not-a-map"] },
});
if (!bad.result?.isError) fail("invalid input did not produce a tool error");

// Assert: the "decisions-judge-mcp/schema" subpath exports the shared
// question specs and keeps their caller-visible fix hints.
const schema = await import("../schema.mjs");
for (const name of ["entryType", "questionSpec", "questionsSchema"]) {
  if (!schema[name]) fail(`schema subpath does not export ${name}`);
}
const missingType = schema.questionsSchema.safeParse({ a: { instructions: "x" } });
if (missingType.success || !missingType.error.issues[0].message.includes('missing "type"')) {
  fail("schema subpath lost the missing-type fix hint");
}

// Assert: graceful shutdown (close stdin; serveStdio exits when stdin ends).
// Wait for the child to exit so it flushes V8 coverage before we do.
proc.stdin.end();
clearTimeout(timer);
const exitCode = await new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
if (exitCode !== 0) fail(`server exited with code ${exitCode}`);
console.log("smoke-server: PASS");
process.exit(0);
