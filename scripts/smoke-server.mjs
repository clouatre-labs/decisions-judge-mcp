// Smoke test for the MCP stdio server (no network, no API key): starts
// server.mjs, performs the initialize handshake, lists tools and prompts,
// calls the judge tool expecting a fallback envelope (keyless by design),
// and calls it with invalid input expecting a tool error. Exits 0 on
// success, non-zero on any failure or timeout.
import { startServer } from "./lib/stdio-client.mjs";

let server;
function fail(msg) {
  console.error(`smoke-server: FAIL: ${msg}`);
  server?.child.kill("SIGKILL");
  process.exit(1);
}

try {
  server = await startServer({ env: { ...process.env, TYPESAFE_API_KEY: "" } });

  // Arrange: initialize handshake.
  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-server", version: "0.0.0" },
  });
  if (!init.result?.serverInfo?.name) fail("initialize handshake failed");
  server.notify("notifications/initialized");

  // Act: list tools; the judge tool must be advertised.
  const tools = await server.request("tools/list", {});
  const judge = tools.result?.tools?.find((t) => t.name === "judge");
  if (!judge) fail("judge tool not advertised");

  // Act: judge call without an API key must return a fallback envelope, not hang.
  const ok = await server.request("tools/call", {
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
  const bad = await server.request("tools/call", {
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

  // Assert: graceful shutdown. close() ends stdin (serveStdio exits when stdin
  // ends); wait for the child so it flushes V8 coverage before we do.
  const exitCode = await server.close();
  if (exitCode !== 0) fail(`server exited with code ${exitCode}`);
  console.log("smoke-server: PASS");
  process.exit(0);
} catch (err) {
  fail(err.message);
}
