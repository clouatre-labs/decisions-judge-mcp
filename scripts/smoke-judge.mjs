// Smoke tests for the judge tool and provider wiring. All offline: stubbed
// fetch for the Cloudflare transport, spawned child processes for server
// startup env validation, and an MCP stdio handshake for the default typesafe
// path. Exits 0 on success, non-zero on any failure or timeout. Does not
// require TYPESAFE_API_KEY.
import { spawn } from "node:child_process";
import { cloudflareJudge } from "../providers/cloudflare-workers-ai.mjs";
import { fallbackFrom, parseKeys, typesafeJudge } from "../providers/typesafe-api.mjs";

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

// Offline typesafe coverage: typesafeJudge reads keys and clients from
// providers/typesafe-api.mjs, whose per-key SDK clients default to the global
// fetch -- so stubbing globalThis.fetch with real Response objects exercises
// rotation and fallback without network access.
async function runOfflineTypesafeTests() {
  const savedEnv = {};
  for (const name of Object.keys(process.env)) {
    if (name === "TYPESAFE_API_KEYS" || /^TYPESAFE_API_KEY(_\d+)?$/.test(name)) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  }
  const savedFetch = globalThis.fetch;
  const json = (body, status) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const SUCCESS = {
    answers: { is_bug: { type: "noul", noul: 0.9 } },
    model: "jev-latest",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  try {
    // Happy path: first key rate-limited (429, no SDK retry), second key
    // succeeds -- no fallback envelope.
    {
      process.env.TYPESAFE_API_KEYS = "k1, k2";
      const calls = [];
      globalThis.fetch = async () => {
        calls.push(1);
        return calls.length === 1
          ? json({ message: "slow down" }, 429)
          : json(SUCCESS, 200);
      };
      const out = (await typesafeJudge({ ...judgeArgs })).structuredContent;
      if (out.fallback !== false || out.answers?.is_bug?.noul !== 0.9) {
        fail(`typesafe rotation: unexpected result ${JSON.stringify(out)}`);
      }
      if (calls.length !== 2) {
        fail(`typesafe rotation: expected 2 fetch calls, got ${calls.length}`);
      }
      ok("typesafe rotation on 429 to second key");
    }

    // Edge case: every key rate-limited -> fallback with actionable text;
    // 429 must not be retried per-client (one call per key).
    {
      process.env.TYPESAFE_API_KEYS = "k1, k2";
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return json({ message: "slow down" }, 429);
      };
      const out = (await typesafeJudge({ ...judgeArgs })).structuredContent;
      if (out.fallback !== true || !/rate limited/i.test(out.error ?? "")) {
        fail(`typesafe all-429: expected rate-limit fallback, got ${JSON.stringify(out)}`);
      }
      if (calls !== 2) {
        fail(`typesafe all-429: expected exactly 2 calls (no SDK 429 retry), got ${calls}`);
      }
      ok(`typesafe all keys rate-limited fallback (${out.error})`);
    }

    // Edge case: single key rate-limited with retryAfterMs -> one call,
    // fallback text includes the retry hint and status.
    {
      delete process.env.TYPESAFE_API_KEYS;
      process.env.TYPESAFE_API_KEY = "solo";
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(JSON.stringify({ message: "slow down" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after-ms": "250" },
        });
      };
      const out = (await typesafeJudge({ ...judgeArgs })).structuredContent;
      if (out.fallback !== true || !/retry after 250ms/.test(out.error ?? "") || !/HTTP 429/.test(out.error ?? "")) {
        fail(`typesafe single-key 429: expected retry-after text, got ${JSON.stringify(out)}`);
      }
      if (calls !== 1) fail(`typesafe single-key 429: expected 1 call, got ${calls}`);
      ok(`typesafe single-key 429 with retryAfterMs (${out.error})`);
    }

    // Edge case: non-429 errors are NOT rotated -- immediate generic fallback.
    {
      process.env.TYPESAFE_API_KEYS = "k1, k2";
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return json({ message: "unauthorized" }, 401);
      };
      const out = (await typesafeJudge({ ...judgeArgs })).structuredContent;
      if (out.fallback !== true || !/HTTP 401/.test(out.error ?? "")) {
        fail(`typesafe 401: expected generic fallback, got ${JSON.stringify(out)}`);
      }
      if (calls !== 1) fail(`typesafe 401: expected 1 call, got ${calls}`);
      ok("typesafe non-429 error returns generic fallback without rotation");
    }

    // Edge case: fallbackFrom mapping -- 429 yields rate-limit text;
    // non-429 APIError keeps the generic (HTTP N) form.
    {
      const rl = fallbackFrom({ status: 429, message: "ignored" }, "d");
      if (rl.structuredContent.error !== "rate limited - retry shortly (HTTP 429)") {
        fail(`fallbackFrom 429: got ${rl.structuredContent.error}`);
      }
      const generic = fallbackFrom({ status: 500, message: "boom" }, "d");
      if (generic.structuredContent.error !== "boom (HTTP 500)") {
        fail(`fallbackFrom generic: got ${generic.structuredContent.error}`);
      }
      const defaultMsg = fallbackFrom({}, "typesafe request failed");
      if (defaultMsg.structuredContent.error !== "typesafe request failed") {
        fail(`fallbackFrom default: got ${defaultMsg.structuredContent.error}`);
      }
      ok("fallbackFrom 429 vs generic mapping");
    }

    // Edge case: key parsing normalizes empty/whitespace CSV segments and
    // dedupes; TYPESAFE_API_KEY_2..9 fill in when the CSV var is unset.
    {
      if (parseKeys({ TYPESAFE_API_KEYS: " a , , b ,, a " }).join(",") !== "a,b") {
        fail(`parseKeys CSV: got ${JSON.stringify(parseKeys({ TYPESAFE_API_KEYS: " a , , b ,, a " }))}`);
      }
      if (parseKeys({ TYPESAFE_API_KEY: " a ", TYPESAFE_API_KEY_3: " c ", TYPESAFE_API_KEY_2: "" }).join(",") !== "a,c") {
        fail("parseKeys fallback vars: unexpected key list");
      }
      if (parseKeys({}).length !== 0) fail("parseKeys empty: expected no keys");
      if (parseKeys({ TYPESAFE_API_KEYS: "   " }).length !== 0) {
        fail("parseKeys whitespace CSV: expected no keys");
      }
      ok("parseKeys normalization and precedence");
    }
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(process.env)) {
      if (name === "TYPESAFE_API_KEYS" || /^TYPESAFE_API_KEY(_\d+)?$/.test(name)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(savedEnv)) process.env[name] = value;
  }
}

// HTTP routing: GET /health returns 200 with provider/transport/keys; GET
// /mcp stays 405; unknown paths stay 404.
function runHttpRoutingTest() {
  const PORT = 18471;
  const env = { ...process.env, JUDGE_TRANSPORT: "http", HTTP_HOST: "127.0.0.1", HTTP_PORT: String(PORT) };
  delete env.TYPESAFE_API_KEYS;
  delete env.TYPESAFE_API_KEY;
  const proc = spawn(process.execPath, ["server.mjs"], {
    stdio: ["ignore", "ignore", "inherit"],
    env,
  });
  const base = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + TIMEOUT_MS;
  async function waitForServer() {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.status === 200) return res;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
  (async () => {
    const health = await waitForServer();
    if (!health) {
      proc.kill("SIGKILL");
      fail("http routing: /health did not come up within timeout");
    }
    const payload = await health.json();
    if (payload.provider !== "typesafe-api" || payload.transport !== "http" || payload.keys !== 0) {
      fail(`http routing: unexpected /health payload ${JSON.stringify(payload)}`);
    }
    const mcpGet = await fetch(`${base}/mcp`, { method: "GET" });
    if (mcpGet.status !== 405) fail(`http routing: GET /mcp expected 405, got ${mcpGet.status}`);
    const unknown = await fetch(`${base}/nope`);
    if (unknown.status !== 404) fail(`http routing: unknown path expected 404, got ${unknown.status}`);
    const mcpPost = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    if (mcpPost.status !== 200) fail(`http routing: POST /mcp expected 200, got ${mcpPost.status}`);
    proc.kill("SIGKILL");
    ok("http routing: /health 200, /mcp GET 405, unknown 404, /mcp POST intact");
    runAuditionSkipTest();
  })().catch((err) => {
    proc.kill("SIGKILL");
    fail(`http routing: ${err.message}`);
  });
}

// Audition script edge case: with no key configured it exits 0 with a skip
// message (never a crash).
function runAuditionSkipTest() {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEYS;
  delete env.TYPESAFE_API_KEY;
  for (let i = 2; i <= 9; i++) delete env[`TYPESAFE_API_KEY_${i}`];
  const child = spawn(process.execPath, ["scripts/audition.mjs"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    fail("audition skip: no exit within timeout");
  }, TIMEOUT_MS);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0 || !/skipped/.test(stdout)) {
      fail(`audition skip: expected exit 0 with skip message, got code=${code} out=${stdout.slice(0, 200)}`);
    }
    ok(`audition skips cleanly without a key (${stdout.trim()})`);
    process.exit(0);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    fail(`audition skip: failed to spawn: ${err.message}`);
  });
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
  delete env.TYPESAFE_API_KEYS;
  delete env.TYPESAFE_API_KEY;
  for (let i = 2; i <= 9; i++) delete env[`TYPESAFE_API_KEY_${i}`];
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

await runOfflineTypesafeTests();

runHttpRoutingTest();

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
