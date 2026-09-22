// Demo transcript for docs/demo.tape (VHS). Spawns node server.mjs over
// newline-delimited JSON-RPC stdio and runs two judge scenes:
//   Scene 1: the README Example tools/call, pretty-printed result.
//   Scene 2: server spawned with TYPESAFE_API_KEY explicitly absent, showing
//            the guaranteed {fallback: true, error} envelope.
// Scene 1 always prints the checked-in README Example response fixture
// (deterministic, offline, no cost). A live API call runs only when both
// DEMO_LIVE=1 and TYPESAFE_API_KEY are set in the environment.
//   Scene 2: server spawned with TYPESAFE_API_KEY explicitly absent and other
//            provider credentials scrubbed, showing the guaranteed
//            {fallback: true, error} envelope.
// Never echoes environment values. Node >= 20, no dependencies.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 15_000;

// README Example input, verbatim.
const JUDGE_ARGS = {
  state: { tests: "passing", lint: "clean", filesChanged: 3 },
  questions: {
    ready_to_merge: {
      type: "noul",
      instructions: "Is this change safe to merge?",
    },
    next_step: {
      type: "choice",
      instructions: "What should the agent do next?",
      criteria: {
        merge: "create the merge commit",
        iterate: "keep refining the change",
        escalate: "hand back to the human",
      },
    },
  },
};

// README Example response, verbatim (offline fixture for Scene 1).
const README_EXAMPLE_RESPONSE = {
  answers: {
    ready_to_merge: { type: "noul", noul: 0.93 },
    next_step: {
      type: "choice",
      choice: "merge",
      confidence: 0.97,
      probabilities: { merge: 0.97, iterate: 0.02, escalate: 0.01 },
    },
  },
  model: "jev-latest",
  usage: { input_tokens: 214, output_tokens: 18 },
  fallback: false,
};

function pretty(label, obj) {
  console.log(`\n== ${label} ==`);
  console.log(JSON.stringify(obj, null, 2));
}

// Environment variables unrelated to the typesafe-api default provider.
// Scrubbed from the child env so the outage scene is deterministic.
const PROVIDER_ENV_KEYS = [
  "JUDGE_PROVIDER",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
];

// Spawn server.mjs and run one judge tools/call over MCP stdio, returning the
// parsed JSON payload from the tool's text content.
function runJudge({ omitApiKey }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of PROVIDER_ENV_KEYS) delete env[key];
    if (omitApiKey) delete env.TYPESAFE_API_KEY;
    const child = spawn(process.execPath, ["server.mjs"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not respond in time"));
    }, TIMEOUT_MS);
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
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
          continue;
        }
        if (msg.id === 1 && msg.result) {
          // MCP protocol: notify the server that initialization finished.
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }) + "\n",
          );
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "judge", arguments: JUDGE_ARGS },
            }) + "\n",
          );
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          let payload;
          try {
            payload = JSON.parse(msg.result.content[0].text);
          } catch {
            reject(new Error("unexpected tool output"));
            return;
          }
          resolve(payload);
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0 && code !== 137) {
        clearTimeout(timer);
        reject(new Error(`server exited early (${code}): ${stderr.trim()}`));
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "demo", version: "0.0.0" },
        },
      }) + "\n",
    );
  });
}

console.log("$ node scripts/demo.mjs");

// Scene 1: fixture-first. Live call only on explicit DEMO_LIVE=1 opt-in.
if (process.env.DEMO_LIVE === "1" && process.env.TYPESAFE_API_KEY) {
  pretty("judge: success (live)", await runJudge({ omitApiKey: false }));
} else {
  // Deterministic checked-in fixture: no cost, no network.
  pretty(
    "judge: success (fixture, README Example; set DEMO_LIVE=1 for a live call)",
    README_EXAMPLE_RESPONSE,
  );
}

// Scene 2: deliberate outage -- no TYPESAFE_API_KEY in the child env.
const outage = await runJudge({ omitApiKey: true });
if (outage.fallback !== true) {
  console.error("outage scene failed: expected fallback envelope");
  process.exit(1);
}
if (typeof outage.error !== "string") {
  console.error(
    "outage scene failed: expected error field to be a string, got: " +
      JSON.stringify(outage.error),
  );
  process.exit(1);
}
pretty("judge: fallback envelope (no API key)", outage);
console.log("\ndone.");
