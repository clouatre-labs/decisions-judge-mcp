// End-to-end test (requires TYPESAFE_API_KEY): starts the MCP stdio server,
// performs the initialize handshake, then calls the judge tool with one noul,
// one choice, and one score question and asserts a successful structured
// answer for each. Exits 0 on success, non-zero on any failure or timeout.
import { spawn } from "node:child_process";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("e2e: SKIP: TYPESAFE_API_KEY not set");
  process.exit(0);
}

const TIMEOUT_MS = 30_000;

const proc = spawn(process.execPath, ["server.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
});

function fail(msg) {
  console.error(`e2e: FAIL: ${msg}`);
  proc.kill("SIGKILL");
  process.exit(1);
}

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

const timer = setTimeout(() => fail("timed out"), TIMEOUT_MS);

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
      // Arrange: the OpenRouter Decisions docs example (noul + choice + score).
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "judge",
          arguments: {
            state: {
              customer_tier: "enterprise",
              ticket:
                "My checkout page shows a blank screen after I click Pay. I have tried two browsers.",
            },
            questions: {
              is_bug: {
                type: "noul",
                instructions: "Is the customer reporting a software defect?",
                criteria: {
                  true: "The customer describes broken or unexpected product behavior.",
                  false: "The customer is asking a question or requesting a feature.",
                },
              },
              team: {
                type: "choice",
                instructions: "Which team should own this ticket?",
                criteria: {
                  account: "Login, permissions, or profile issues.",
                  payments: "Checkout, billing, or payment processing issues.",
                  frontend: "Rendering, layout, or browser compatibility issues.",
                },
              },
              urgency: {
                type: "score",
                instructions: "How urgent is this ticket?",
                criteria: [
                  "Can wait for the next release",
                  "Should be fixed this week",
                  "Blocking revenue right now",
                ],
              },
            },
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
        fail(`content is not JSON: ${text.slice(0, 200)}`);
      }
      // Assert: success envelope with one typed answer per question.
      if (payload.fallback !== false) {
        fail(`expected success envelope, got: ${text.slice(0, 300)}`);
      }
      const { answers, model, usage } = payload;
      if (!model || !usage) fail(`missing model/usage metadata: ${text.slice(0, 300)}`);
      if (typeof answers.is_bug?.noul !== "number") fail(`bad noul answer: ${text.slice(0, 300)}`);
      if (typeof answers.team?.choice !== "string") fail(`bad choice answer: ${text.slice(0, 300)}`);
      if (typeof answers.urgency?.score !== "number") fail(`bad score answer: ${text.slice(0, 300)}`);
      console.log(`e2e: OK (model ${model}, usage ${usage.input_tokens}/${usage.output_tokens} tokens)`);
      proc.kill("SIGKILL");
      process.exit(0);
    }
  }
});

// Act: initialize handshake first.
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0.0.0" },
  },
});
