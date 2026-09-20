// Smoke test: start the MCP stdio server, perform the MCP initialize
// handshake, and assert a valid initialize result comes back. Exits 0 on
// success, non-zero on any failure or timeout. Does not require
// TYPESAFE_API_KEY (the key is only needed for actual judge calls).
import { spawn } from "node:child_process";
import { once } from "node:events";

const TIMEOUT_MS = 10_000;

const proc = spawn(process.execPath, ["server.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
});

function fail(msg) {
  console.error(`smoke: FAIL: ${msg}`);
  proc.kill("SIGKILL");
  process.exit(1);
}

const timer = setTimeout(
  () => fail(`no initialize response within ${TIMEOUT_MS}ms`),
  TIMEOUT_MS,
);

const request = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  },
};

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
      clearTimeout(timer);
      const result = msg.result;
      if (!result || !result.serverInfo || !result.protocolVersion) {
        fail(`initialize result missing serverInfo/protocolVersion: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      if (result.serverInfo.name !== "decisions-judge-mcp") {
        fail(`unexpected server name: ${result.serverInfo.name}`);
      }
      console.log(`smoke: OK (server ${result.serverInfo.name}@${result.serverInfo.version}, protocol ${result.protocolVersion})`);
      proc.kill("SIGKILL");
      process.exit(0);
    }
  }
});

proc.on("error", (err) => fail(`failed to spawn server: ${err.message}`));
proc.on("exit", (code) => fail(`server exited early with code ${code}`));

proc.stdin.write(JSON.stringify(request) + "\n");

// Keep the event loop alive until a verdict; rethrow on unexpected stdout errors.
await once(proc.stdout, "close").catch(() => {});
