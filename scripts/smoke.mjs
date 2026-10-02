// Smoke test: start the MCP stdio server, perform the MCP initialize
// handshake, then exercise the prompts capability: prompts/list must list all
// three templates, prompts/get must return one user message with a
// version-stamped judge skeleton, and an unknown prompt name must return a
// JSON-RPC error. Exits 0 on success, non-zero on any failure or timeout.
// Does not require TYPESAFE_API_KEY.
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
  () => fail(`no response within ${TIMEOUT_MS}ms`),
  TIMEOUT_MS,
);

const PROMPT_NAMES = ["verify-claim", "classify", "route"];

function rpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
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
      const result = msg.result;
      // 2025-11-25 is the MCP SDK's LATEST_PROTOCOL_VERSION (verified in
      // @modelcontextprotocol/sdk dist/esm/types.js); revisit on SDK upgrades.
      if (!result || !result.serverInfo || result.protocolVersion !== "2025-11-25") {
        fail(`initialize result missing serverInfo or wrong protocolVersion (expected 2025-11-25): ${JSON.stringify(msg).slice(0, 300)}`);
      }
      if (result.serverInfo.name !== "decisions-judge-mcp") {
        fail(`unexpected server name: ${result.serverInfo.name}`);
      }
      console.log(`smoke: initialize OK (server ${result.serverInfo.name}@${result.serverInfo.version}, protocol ${result.protocolVersion})`);
      proc.stdin.write(JSON.stringify(rpc(2, "prompts/list", {})) + "\n");
    } else if (msg.id === 2) {
      const names = (msg.result?.prompts ?? []).map((p) => p.name).sort();
      for (const expected of PROMPT_NAMES) {
        if (!names.includes(expected)) {
          fail(`prompts/list missing "${expected}": got ${JSON.stringify(names)}`);
        }
      }
      console.log(`smoke: prompts/list OK (${names.join(", ")})`);
      proc.stdin.write(JSON.stringify(rpc(3, "prompts/get", { name: "verify-claim", arguments: { state: "{}" } })) + "\n");
    } else if (msg.id === 3) {
      const messages = msg.result?.messages;
      if (!Array.isArray(messages) || messages.length !== 1) {
        fail(`prompts/get verify-claim expected exactly one message: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      const m = messages[0];
      if (m.role !== "user" || m.content?.type !== "text" || typeof m.content.text !== "string") {
        fail(`prompts/get verify-claim wrong message shape: ${JSON.stringify(m).slice(0, 300)}`);
      }
      if (!m.content.text.includes("wording-v1")) {
        fail(`prompts/get verify-claim text missing wording-v1 stamp: ${m.content.text.slice(0, 200)}`);
      }
      if (!m.content.text.includes("judge")) {
        fail(`prompts/get verify-claim text missing judge skeleton: ${m.content.text.slice(0, 200)}`);
      }
      if (!m.content.text.includes('"type": "noul"') && !m.content.text.includes('"type":"noul"')) {
        fail(`prompts/get verify-claim text missing noul question type: ${m.content.text.slice(0, 300)}`);
      }
      if (!m.content.text.includes("claim_supported")) {
        fail(`prompts/get verify-claim text missing claim_supported question key: ${m.content.text.slice(0, 300)}`);
      }
      // The embedded skeleton must parse as JSON whose questions field is an
      // object map (matching the judge tool's questions record schema), not
      // an array of single-key objects.
      const skeletonText = m.content.text.split("\n\n").pop();
      let parsed;
      try {
        parsed = JSON.parse(skeletonText);
      } catch (err) {
        fail(`prompts/get verify-claim skeleton is not parseable JSON: ${err.message}`);
      }
      if (
        typeof parsed?.arguments?.questions !== "object" ||
        parsed.arguments.questions === null ||
        Array.isArray(parsed.arguments.questions) ||
        !("claim_supported" in parsed.arguments.questions)
      ) {
        fail(`prompts/get verify-claim questions must be an object map with claim_supported: ${skeletonText.slice(0, 200)}`);
      }
      console.log("smoke: prompts/get verify-claim OK (user text message, wording-v1, questions rendered as object map)");
      proc.stdin.write(JSON.stringify(rpc(4, "prompts/get", { name: "no-such-prompt", arguments: {} })) + "\n");
    } else if (msg.id === 4) {
      if (!msg.error || typeof msg.error.code !== "number") {
        fail(`prompts/get unknown name expected a JSON-RPC error: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      console.log(`smoke: prompts/get unknown OK (JSON-RPC error ${msg.error.code})`);
      clearTimeout(timer);
      proc.kill("SIGKILL");
      process.exit(0);
    }
  }
});

proc.on("error", (err) => fail(`failed to spawn server: ${err.message}`));
proc.on("exit", (code) => fail(`server exited early with code ${code}`));

proc.stdin.write(
  JSON.stringify(
    rpc(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    }),
  ) + "\n",
);

// Keep the event loop alive until a verdict; rethrow on unexpected stdout errors.
await once(proc.stdout, "close").catch(() => {});
