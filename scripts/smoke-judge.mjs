// Smoke test (edge case): start the MCP stdio server, perform the initialize
// handshake, then call the judge tool with a choice question missing criteria
// and assert the offline fallback envelope ({fallback: true, error}) comes
// back. Also asserts that provider: "cloudflare" with credentials unset
// returns a fallback envelope naming the missing variable (no network). If
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are both set, a live
// happy-path call against Cloudflare Workers AI runs in a second server;
// otherwise that case is skipped (auth failures 401/403 are also skipped,
// since env presence cannot guarantee credential validity). Exits 0 on
// success, non-zero on any failure or timeout. Does not require
// TYPESAFE_API_KEY.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 10_000;

const childEnv = { ...process.env };
delete childEnv.CLOUDFLARE_API_TOKEN;
delete childEnv.CLOUDFLARE_ACCOUNT_ID;

const proc = spawn(process.execPath, ["server.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: childEnv,
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
      // Arrange: widened schema acceptance -- structured (object) instructions,
      // a JSON criteria value, array state, and a model override. Offline the
      // call falls back, but the input must NOT be rejected by zod.
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "judge",
          arguments: {
            state: ["alpha", { beta: true }],
            model: "jev-latest",
            questions: {
              q: {
                type: "noul",
                instructions: { text: "is the feature healthy?", locale: "en" },
                criteria: { true: { detail: "yes" }, false: "no" },
              },
            },
          },
        },
      });
      timer = setTimeout(
        () => fail(`no response within ${TIMEOUT_MS}ms`),
        TIMEOUT_MS,
      );
    } else if (msg.id === 3) {
      clearTimeout(timer);
      const text3 = msg.result?.content?.[0]?.text;
      if (!text3) {
        fail(`tools/call result missing content: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      if (msg.error || /input validation|invalid_input|Invalid arguments/i.test(text3)) {
        fail(`widened input rejected by schema: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      let payload3;
      try {
        payload3 = JSON.parse(text3);
      } catch {
        fail(`content is not a JSON payload: ${String(text3).slice(0, 200)}`);
      }
      if (typeof payload3.fallback !== "boolean") {
        fail(`expected fallback boolean, got: ${text3.slice(0, 200)}`);
      }
      if (payload3.error && /criteria/i.test(payload3.error)) {
        fail(`unexpected criteria error for structured input: ${text3.slice(0, 200)}`);
      }
      console.log(`smoke-judge: OK (widened inputs accepted, fallback=${payload3.fallback})`);
      // Arrange: opt-in cloudflare provider with credentials stripped from the
      // child env. Must pass zod validation offline and fall back naming the
      // missing variable -- never throw, never hit the network.
      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "judge",
          arguments: {
            provider: "cloudflare",
            state: { ticket: "checkout page blank after Pay" },
            questions: {
              is_bug: { type: "noul", instructions: "Is this a defect?" },
            },
          },
        },
      });
      timer = setTimeout(
        () => fail(`no response within ${TIMEOUT_MS}ms`),
        TIMEOUT_MS,
      );
    } else if (msg.id === 4) {
      clearTimeout(timer);
      const text4 = msg.result?.content?.[0]?.text;
      if (!text4) {
        fail(`tools/call result missing content: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      if (msg.error || /input validation|invalid_input|Invalid arguments/i.test(text4)) {
        fail(`provider cloudflare rejected by schema: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      let payload4;
      try {
        payload4 = JSON.parse(text4);
      } catch {
        fail(`content is not a JSON payload: ${String(text4).slice(0, 200)}`);
      }
      if (payload4.fallback !== true) {
        fail(`expected fallback === true for cloudflare without credentials, got: ${text4.slice(0, 200)}`);
      }
      if (!payload4.error || !/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)/.test(payload4.error)) {
        fail(`expected missing-env-var error naming CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID, got: ${text4.slice(0, 200)}`);
      }
      console.log(`smoke-judge: OK (cloudflare offline fallback: ${payload4.error})`);
      done = true;
      proc.kill("SIGKILL");
      const liveToken = process.env.CLOUDFLARE_API_TOKEN;
      const liveAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
      if (!liveToken || !liveAccount) {
        console.log("smoke-judge: SKIP (live cloudflare happy path: CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not both set)");
        process.exit(0);
      }
      runLiveCase(liveToken, liveAccount);
    }
  }
});

function runLiveCase(token, account) {
  const childEnvLive = { ...process.env };
  const live = spawn(process.execPath, ["server.mjs"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnvLive,
  });
  let liveBuffer = "";
  const liveFail = (msg) => {
    console.error(`smoke-judge: FAIL: ${msg}`);
    live.kill("SIGKILL");
    process.exit(1);
  };
  const liveSend = (msg) => live.stdin.write(JSON.stringify(msg) + "\n");
  const liveTimer = setTimeout(
    () => liveFail(`no live response within ${TIMEOUT_MS}ms`),
    TIMEOUT_MS,
  );
  live.stdout.on("data", (chunk) => {
    liveBuffer += chunk;
    const lines = liveBuffer.split("\n");
    liveBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        liveFail(`non-JSON output on live stdout: ${line.slice(0, 200)}`);
      }
      if (msg.id === 1) {
        if (!msg.result || !msg.result.protocolVersion) {
          liveFail(`live initialize failed: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        liveSend({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "judge",
            arguments: {
              provider: "cloudflare",
              state: { ticket: "checkout page blank after Pay" },
              questions: {
                is_bug: { type: "noul", instructions: "Is this a defect?" },
              },
            },
          },
        });
      } else if (msg.id === 5) {
        clearTimeout(liveTimer);
        const text5 = msg.result?.content?.[0]?.text;
        if (!text5) {
          liveFail(`live tools/call result missing content: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        let payload5;
        try {
          payload5 = JSON.parse(text5);
        } catch {
          liveFail(`content is not a JSON payload: ${String(text5).slice(0, 200)}`);
        }
        if (payload5.fallback !== false) {
          if (/\(HTTP 40[13]\)/.test(String(payload5.error))) {
            console.log(`smoke-judge: SKIP (live cloudflare: invalid credentials: ${payload5.error})`);
            live.kill("SIGKILL");
            process.exit(0);
          }
          liveFail(`expected live fallback === false, got: ${text5.slice(0, 200)}`);
        }
        if (!payload5.answers || typeof payload5.answers !== "object") {
          liveFail(`expected answers object on live success, got: ${text5.slice(0, 200)}`);
        }
        console.log(`smoke-judge: OK (live cloudflare: model=${payload5.model})`);
        live.kill("SIGKILL");
        process.exit(0);
      }
    }
  });
  live.on("error", (err) => liveFail(`failed to spawn live server: ${err.message}`));
  live.on("exit", (code) => liveFail(`live server exited early with code ${code}`));
  liveSend({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "smoke-judge-test", version: "0.0.0" },
    },
  });
}

let timer = setTimeout(
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

let done = false;

proc.on("error", (err) => fail(`failed to spawn server: ${err.message}`));
proc.on("exit", (code) => {
  if (!done) fail(`server exited early with code ${code}`);
});
