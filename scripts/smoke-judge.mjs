// Smoke test (edge case): start the MCP stdio server, perform the initialize
// handshake, then call the judge tool with a choice question missing criteria
// and assert the offline fallback envelope ({fallback: true, error}) comes
// back. Exits 0 on success, non-zero on any failure or timeout. Does not
// require TYPESAFE_API_KEY.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 10_000;

const proc = spawn(process.execPath, ["server.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
});

function fail(msg) {
  console.error(`smoke-judge: FAIL: ${msg}`);
  proc.kill("SIGKILL");
  process.exit(1);
}

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

let buffer = "";
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
      fail(`non-JSON output on stdout: ${line.slice(0, 200)}`);
    }
    if (msg.id === 1) {
      if (!msg.result || !msg.result.protocolVersion) {
        fail(`initialize failed: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      // Arrange: choice question with no criteria must fail construction.
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "judge",
          arguments: {
            state: {},
            questions: { q: { type: "choice", instructions: "pick one" } },
          },
        },
      });
    } else if (msg.id === 2) {
      clearTimeout(timer);
      const text = msg.result?.content?.[0]?.text;
      if (!text) {
        fail(`tools/call result missing content: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        fail(`content is not a JSON payload: ${String(text).slice(0, 200)}`);
      }
      // Assert: fallback envelope with an error about choice criteria.
      if (payload.fallback !== true) {
        fail(`expected fallback === true, got: ${text.slice(0, 200)}`);
      }
      if (!payload.error || !/criteria/i.test(payload.error)) {
        fail(`expected criteria error, got: ${text.slice(0, 200)}`);
      }
      console.log(`smoke-judge: OK (fallback envelope: ${payload.error})`);
      proc.kill("SIGKILL");
      process.exit(0);
    }
  }
});

const timer = setTimeout(
  () => fail(`no response within ${TIMEOUT_MS}ms`),
  TIMEOUT_MS,
);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke-judge-test", version: "0.0.0" },
  },
});

proc.on("error", (err) => fail(`failed to spawn server: ${err.message}`));
proc.on("exit", (code) => fail(`server exited early with code ${code}`));
