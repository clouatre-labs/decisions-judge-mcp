// Smoke tests for the judge tool and provider wiring. All offline: stubbed
// fetch for the Cloudflare transport, spawned child processes for server
// startup env validation, and an MCP stdio handshake for the default typesafe
// path. Exits 0 on success, non-zero on any failure or timeout. Does not
// require TYPESAFE_API_KEY.
import { spawn } from "node:child_process";
import { cloudflareJudge } from "../providers/cloudflare-workers-ai.mjs";

const TIMEOUT_MS = 10_000;

function fail(msg) {
  console.error(`smoke-judge: FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`smoke-judge: OK (${msg})`);
}

function fakeResponse({ status = 200, body } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    body: null,
  };
}

const COMPLETED_BODY = {
  success: true,
  result: {
    state: "Completed",
    result: {
      answers: { is_bug: "yes" },
      model: "typesafe/jev",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  },
};

const judgeArgs = {
  state: { ticket: "checkout page blank after Pay" },
  questions: { is_bug: { type: "noul", instructions: "Is this a defect?" } },
};

// Deterministic offline coverage: import providers/cloudflare-workers-ai.mjs in-process
// and stub global.fetch. One happy path plus one edge case per behavior.
async function runOfflineCloudflareTests() {
  const savedEnv = {
    token: process.env.CLOUDFLARE_API_TOKEN,
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
  };
  const savedFetch = globalThis.fetch;
  const TOKEN = "offline-test-token";
  const ACCOUNT = "a".repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  try {
    // Happy path: well-formed Completed envelope -> success mapping.
    {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return fakeResponse({ body: COMPLETED_BODY });
      };
      const out = await cloudflareJudge({ ...judgeArgs });
      if (
        out.fallback !== false ||
        out.answers?.is_bug !== "yes" ||
        out.model !== "typesafe/jev" ||
        out.usage?.prompt_tokens !== 1
      ) {
        fail(`cloudflare happy path: unexpected result ${JSON.stringify(out)}`);
      }
      if (calls !== 1) fail(`cloudflare happy path: expected 1 fetch call, got ${calls}`);
      ok("cloudflare happy path");
    }

    // Happy path: only 429 and transport errors are retried; 4xx fail fast.
    {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (calls <= 2) return fakeResponse({ status: 429, body: { success: false, errors: [] } });
        return fakeResponse({ body: COMPLETED_BODY });
      };
      const out = await cloudflareJudge({ ...judgeArgs });
      if (out.fallback !== false || calls !== 3) {
        fail(`cloudflare 429 retry: expected success after 3 calls, got fallback=${out.fallback} calls=${calls}`);
      }
      ok("cloudflare 429 retry then success");
    }
    {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return fakeResponse({
          status: 401,
          body: { success: false, errors: [{ code: 1, message: `unauthorized ${TOKEN}` }] },
        });
      };
      let caught;
      try {
        await cloudflareJudge({ ...judgeArgs });
      } catch (e) {
        caught = e;
      }
      if (!caught || calls !== 1 || caught.status !== 401 || !String(caught.message).includes("[redacted]")) {
        fail(`cloudflare 401 fail-fast: expected single-call redacted error, got ${String(caught)} calls=${calls}`);
      }
      ok("cloudflare 401 fail-fast with redaction");
    }

    // Edge case: malformed error envelope (non-string errors[].message) and a
    // non-Completed state both land in the fallback envelope without throwing.
    {
      globalThis.fetch = async () =>
        fakeResponse({ status: 400, body: { success: false, errors: [{ code: 1, message: 123 }] } });
      let caught;
      try {
        await cloudflareJudge({ ...judgeArgs });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.status !== 400 || typeof caught.message !== "string") {
        fail(`cloudflare malformed envelope: expected status 400 string error, got ${String(caught)}`);
      }
      ok(`cloudflare malformed error envelope (${caught.message})`);
    }
    {
      globalThis.fetch = async () =>
        fakeResponse({
          body: { success: true, result: { state: "Pending", result: { answers: { is_bug: "yes" } } } },
        });
      let caught;
      try {
        await cloudflareJudge({ ...judgeArgs });
      } catch (e) {
        caught = e;
      }
      if (!caught || !/unexpected response envelope/.test(String(caught?.message))) {
        fail(`cloudflare non-Completed state: expected envelope rejection, got ${String(caught)}`);
      }
      ok("cloudflare non-Completed state rejected");
    }

    // Edge case: caller abort between attempts rejects promptly and never
    // leaks the token in the error message.
    {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        throw new Error("transport down");
      };
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      const started = Date.now();
      let caught;
      try {
        await cloudflareJudge({ ...judgeArgs, signal: ac.signal });
      } catch (e) {
        caught = e;
      }
      const elapsed = Date.now() - started;
      if (!caught || calls !== 1 || elapsed > 3000) {
        fail(`cloudflare abort: expected prompt single-call abort, got ${String(caught)} calls=${calls} elapsed=${elapsed}ms`);
      }
      if (String(caught.message).includes(TOKEN)) {
        fail("cloudflare abort: token leaked in error message");
      }
      ok(`cloudflare abort mid-retry (${caught.message}, ${elapsed}ms)`);
    }

    // Edge case: secret redaction on server error envelopes.
    {
      globalThis.fetch = async () =>
        fakeResponse({
          status: 500,
          body: {
            success: false,
            errors: [{ code: 1, message: `bad credentials ${TOKEN} for account ${ACCOUNT}` }],
          },
        });
      let caught;
      try {
        await cloudflareJudge({ ...judgeArgs });
      } catch (e) {
        caught = e;
      }
      if (
        !caught ||
        !caught.message.includes("[redacted]") ||
        caught.message.includes(TOKEN) ||
        caught.message.includes(ACCOUNT)
      ) {
        fail(`cloudflare redaction: secrets leaked: ${String(caught?.message)}`);
      }
      ok("cloudflare secret redaction");
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = savedEnv.token;
    if (savedEnv.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = savedEnv.account;
  }
}

// Startup-failure assertions: spawn node server.mjs with a controlled env and
// require a non-zero exit with the offending variable named on stderr.
function runStartupFailureCase(label, envOverrides, expectPattern) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const child = spawn(process.execPath, ["server.mjs"], {
      stdio: ["ignore", "ignore", "pipe"],
      env,
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(`${label}: no exit within ${TIMEOUT_MS}ms`);
    }, TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(`${label}: failed to spawn server: ${err.message}`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) {
        fail(`${label}: expected non-zero exit, got ${code}`);
      }
      if (!expectPattern.test(stderr)) {
        fail(`${label}: expected ${expectPattern} in stderr, got: ${stderr.slice(0, 300)}`);
      }
      ok(`${label} (exit ${code}: ${stderr.trim().split("\n")[0]})`);
      resolve();
    });
  });
}

// Stdio smoke: with JUDGE_PROVIDER unset, the judge path behaves exactly as on
// main -- fallback envelope for a malformed question, widened inputs accepted.
function runStdioDefaultPathTest() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.JUDGE_PROVIDER;
  const proc = spawn(process.execPath, ["server.mjs"], {
    stdio: ["pipe", "pipe", "inherit"],
    env,
  });

  function stdioFail(msg) {
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
        stdioFail(`non-JSON output on stdout: ${line.slice(0, 200)}`);
      }
      if (msg.id === 1) {
        if (!msg.result || !msg.result.protocolVersion) {
          stdioFail(`initialize failed: ${JSON.stringify(msg).slice(0, 300)}`);
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
          stdioFail(`tools/call result missing content: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          stdioFail(`content is not a JSON payload: ${String(text).slice(0, 200)}`);
        }
        // Assert: fallback envelope with an error about choice criteria.
        if (payload.fallback !== true) {
          stdioFail(`expected fallback === true, got: ${text.slice(0, 200)}`);
        }
        if (!payload.error || !/criteria/i.test(payload.error)) {
          stdioFail(`expected criteria error, got: ${text.slice(0, 200)}`);
        }
        ok(`default path fallback envelope: ${payload.error}`);
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
          () => stdioFail(`no response within ${TIMEOUT_MS}ms`),
          TIMEOUT_MS,
        );
      } else if (msg.id === 3) {
        clearTimeout(timer);
        const text3 = msg.result?.content?.[0]?.text;
        if (!text3) {
          stdioFail(`tools/call result missing content: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        if (msg.error || /input validation|invalid_input|Invalid arguments/i.test(text3)) {
          stdioFail(`widened input rejected by schema: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        let payload3;
        try {
          payload3 = JSON.parse(text3);
        } catch {
          stdioFail(`content is not a JSON payload: ${String(text3).slice(0, 200)}`);
        }
        if (typeof payload3.fallback !== "boolean") {
          stdioFail(`expected fallback boolean, got: ${text3.slice(0, 200)}`);
        }
        if (payload3.error && /criteria/i.test(payload3.error)) {
          stdioFail(`unexpected criteria error for structured input: ${text3.slice(0, 200)}`);
        }
        ok(`widened inputs accepted, fallback=${payload3.fallback}`);
        proc.kill("SIGKILL");
        process.exit(0);
      }
    }
  });

  let timer = setTimeout(
    () => stdioFail(`no response within ${TIMEOUT_MS}ms`),
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

  proc.on("error", (err) => stdioFail(`failed to spawn server: ${err.message}`));
  proc.on("exit", (code) => stdioFail(`server exited early with code ${code}`));
}

await runOfflineCloudflareTests();

await runStartupFailureCase(
  "missing CLOUDFLARE_API_TOKEN",
  { JUDGE_PROVIDER: "cloudflare-workers-ai" },
  /CLOUDFLARE_API_TOKEN/,
);

await runStartupFailureCase(
  "invalid CLOUDFLARE_ACCOUNT_ID",
  {
    JUDGE_PROVIDER: "cloudflare-workers-ai",
    CLOUDFLARE_API_TOKEN: "dummy-token",
    CLOUDFLARE_ACCOUNT_ID: "bad account id",
  },
  /CLOUDFLARE_ACCOUNT_ID/,
);

await runStartupFailureCase(
  "unknown JUDGE_PROVIDER value",
  { JUDGE_PROVIDER: "cloudflare" },
  /JUDGE_PROVIDER must be one of: typesafe-api, cloudflare-workers-ai/,
);

runStdioDefaultPathTest();
