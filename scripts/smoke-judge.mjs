// Smoke tests for the judge tool and provider wiring. All offline: stubbed
// fetch for the Cloudflare transport, spawned child processes for server
// startup env validation, and an MCP stdio handshake for the default typesafe
// path. Exits 0 on success, non-zero on any failure or timeout. Does not
// require TYPESAFE_API_KEY.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { spawn } from "node:child_process";
import {
  CF_DEFAULT_MODEL,
  cloudflareJudge,
  resolveCfModel,
} from "../providers/cloudflare-workers-ai.mjs";
import {
  DEFAULT_MODEL,
  fallbackFrom,
  loadImagesFromPaths,
  typesafeJudge,
  validateImages,
} from "../providers/typesafe-api.mjs";

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

// Mirrors the live Clef response verified in issue #160.
const CLEF_BODY = {
  success: true,
  result: {
    model: "clef",
    answers: { is_bug: "yes" },
    usage: { input_tokens: 149, output_tokens: 1 },
  },
  errors: [],
  messages: [],
};

const judgeArgs = {
  state: { ticket: "checkout page blank after Pay" },
  questions: { is_bug: { type: "noul", instructions: "Is this a defect?" } },
};

// Minimal valid PNG encoder for image smoke cases: a WxH RGB image filled
// with one solid color (same approach as scripts/probe-images.mjs).
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodeSolidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const row = Buffer.alloc(width * 3 + 1);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

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
    // Happy path: well-formed Clef envelope -> success mapping, flat body with
    // the selector, and the route in the URL.
    {
      let calls = 0;
      let lastBody = null;
      let lastUrl = null;
      globalThis.fetch = async (url, init) => {
        calls++;
        lastUrl = String(url);
        lastBody = JSON.parse(init?.body ?? "{}");
        return fakeResponse({ body: CLEF_BODY });
      };
      const out = await cloudflareJudge({ ...judgeArgs });
      if (
        out.fallback !== false ||
        out.answers?.is_bug !== "yes" ||
        out.model !== "clef" ||
        out.usage?.input_tokens !== 149
      ) {
        fail(`cloudflare happy path: unexpected result ${JSON.stringify(out)}`);
      }
      if (calls !== 1) fail(`cloudflare happy path: expected 1 fetch call, got ${calls}`);
      if (lastUrl !== `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${CF_DEFAULT_MODEL}`) {
        fail(`cloudflare happy path: unexpected url ${lastUrl}`);
      }
      if (
        JSON.stringify(lastBody) !==
        JSON.stringify({ model: "clef", state: judgeArgs.state, questions: judgeArgs.questions })
      ) {
        fail(`cloudflare happy path: unexpected flat body ${JSON.stringify(lastBody)}`);
      }
      if ("images" in lastBody) fail(`cloudflare happy path: unexpected images key ${JSON.stringify(lastBody)}`);
      ok("cloudflare happy path (no images key in body)");

      // Issue #166: only the Clef family is accepted; every accepted input
      // resolves to a route plus the required body selector.
      if (CF_DEFAULT_MODEL !== "@cf/cloudflare/clef") {
        fail(`cloudflare model pin: CF_DEFAULT_MODEL ${CF_DEFAULT_MODEL}`);
      }
      const resolveCases = [
        [undefined, "@cf/cloudflare/clef", "clef"],
        ["clef", "@cf/cloudflare/clef", "clef"],
        ["@cf/cloudflare/clef", "@cf/cloudflare/clef", "clef"],
        ["clef-flash", "@cf/cloudflare/clef-flash", "clef-flash"],
        ["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef-flash", "clef-flash"],
      ];
      for (const [input, wantRoute, wantSelector] of resolveCases) {
        const got = resolveCfModel(input);
        if (got.route !== wantRoute || got.selector !== wantSelector) {
          fail(`cloudflare model pin: resolveCfModel(${input}) = ${JSON.stringify(got)}, want ${wantRoute}/${wantSelector}`);
        }
      }
      ok(`cloudflare model pin (${CF_DEFAULT_MODEL}, bare clef* prefixed)`);

      // Happy path: a clef-flash override routes to @cf/cloudflare/clef-flash
      // and carries model clef-flash in the body.
      globalThis.fetch = async (url, init) => {
        calls++;
        lastUrl = String(url);
        lastBody = JSON.parse(init?.body ?? "{}");
        return fakeResponse({ body: { ...CLEF_BODY, result: { ...CLEF_BODY.result, model: "clef-flash" } } });
      };
      const flash = await cloudflareJudge({ ...judgeArgs, model: "clef-flash" });
      if (
        flash.model !== "clef-flash" ||
        !lastUrl.endsWith("/ai/run/@cf/cloudflare/clef-flash") ||
        lastBody.model !== "clef-flash"
      ) {
        fail(`cloudflare selector: unexpected clef-flash result ${JSON.stringify(flash)} url=${lastUrl}`);
      }
      ok("cloudflare selector (clef, clef-flash only)");

      // Edge case: a non-Clef override is rejected before any request, both
      // from the resolver and from cloudflareJudge, and no fetch is issued.
      let resolverError;
      try {
        resolveCfModel("some/other-model");
      } catch (err) {
        resolverError = err;
      }
      if (!resolverError || !/must be "clef" or "clef-flash"/.test(resolverError.message)) {
        fail(`cloudflare non-Clef override: resolver did not reject, got ${resolverError?.message}`);
      }
      let nonClefCalls = 0;
      globalThis.fetch = async () => {
        nonClefCalls++;
        return fakeResponse({ body: CLEF_BODY });
      };
      let judgeError;
      try {
        await cloudflareJudge({ ...judgeArgs, model: "some/other-model" });
      } catch (err) {
        judgeError = err;
      }
      if (!judgeError || judgeError.message !== resolverError.message) {
        fail(`cloudflare non-Clef override: unexpected rejection ${judgeError?.message}`);
      }
      if (nonClefCalls !== 0) fail(`cloudflare non-Clef override: expected 0 fetch calls, got ${nonClefCalls}`);
      ok("cloudflare non-Clef override rejected before request");
    }

    // Happy path: only 429 and transport errors are retried; 4xx fail fast.
    {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (calls <= 2) return fakeResponse({ status: 429, body: { success: false, errors: [] } });
        return fakeResponse({ body: CLEF_BODY });
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
    // rejected success envelope both surface as errors rather than crashing.
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
    // Edge case: a success envelope without success:true or with non-object
    // answers is rejected instead of mapped to a result.
    {
      globalThis.fetch = async () => fakeResponse({ body: { success: false, errors: [{ message: 'nope' }] } });
      let caught;
      try {
        await cloudflareJudge({ ...judgeArgs });
      } catch (e) {
        caught = e;
      }
      if (!caught || !/nope/.test(String(caught?.message))) {
        fail(`cloudflare non-success envelope: expected envelope rejection, got ${String(caught)}`);
      }
      globalThis.fetch = async () =>
        fakeResponse({ body: { success: true, result: { model: "clef", answers: ["yes"] } } });
      let caught2;
      try {
        await cloudflareJudge({ ...judgeArgs });
      } catch (e) {
        caught2 = e;
      }
      if (!caught2 || !/unexpected response envelope/.test(String(caught2?.message))) {
        fail(`cloudflare non-object answers: expected envelope rejection, got ${String(caught2)}`);
      }
      ok("cloudflare envelope without success:true or object answers rejected");
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

    // Issue #163: images are forwarded to Clef as an ordered array of
    // {content_type, base64} in map key order, after state and questions.
    for (const [label, png, jpeg] of [
      ["PNG", "iVBORw0KGgo=", null],
      ["JPEG", null, "/9j/4AAQ"],
    ]) {
      let calls = 0;
      let lastBody = null;
      globalThis.fetch = async (_url, init) => {
        calls++;
        lastBody = JSON.parse(init?.body ?? "{}");
        return fakeResponse({ body: CLEF_BODY });
      };
      const images = {};
      if (png) images.shot = png;
      if (jpeg) images.photo = jpeg;
      const out = await cloudflareJudge({ ...judgeArgs, images });
      const wantImages = [
        ...(png ? [{ content_type: "image/png", base64: png }] : []),
        ...(jpeg ? [{ content_type: "image/jpeg", base64: jpeg }] : []),
      ];
      if (out.fallback !== false) fail(`cloudflare images ${label}: unexpected result ${JSON.stringify(out)}`);
      if (calls !== 1) fail(`cloudflare images ${label}: expected 1 fetch call, got ${calls}`);
      if (
        JSON.stringify(lastBody) !==
        JSON.stringify({ model: "clef", state: judgeArgs.state, questions: judgeArgs.questions, images: wantImages })
      ) {
        fail(`cloudflare images ${label}: unexpected body ${JSON.stringify(lastBody)}`);
      }
      ok(`cloudflare images ${label} forwarded as {content_type, base64} array`);
    }

    // Edge case (issue #163): Clef caps a request at 4 images; a larger set is
    // rejected before any fetch, naming the limit.
    {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return fakeResponse({ body: CLEF_BODY });
      };
      let caught;
      try {
        await cloudflareJudge({
          ...judgeArgs,
          images: { a: "iVBORw0KGgo=", b: "iVBORw0KGgo=", c: "iVBORw0KGgo=", d: "iVBORw0KGgo=", e: "iVBORw0KGgo=" },
        });
      } catch (err) {
        caught = err;
      }
      if (!caught || !/4 images/.test(caught.message) || calls !== 0) {
        fail(`cloudflare images cap: expected pre-fetch throw naming 4, got ${String(caught)} calls=${calls}`);
      }
      ok(`cloudflare images cap (${caught.message})`);
    }

  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = savedEnv.token;
    if (savedEnv.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = savedEnv.account;
  }
}

// Offline typesafe coverage: typesafeJudge uses the single SDK client from
// providers/typesafe-api.mjs, whose SDK client defaults to the global fetch --
// so stubbing globalThis.fetch with real Response objects exercises retry and
// fallback behavior without network access. The SDK default retry policy
// (maxRetries 2 on 408/429/5xx) means a stubbed 429 can be observed up to
// three times per judge call.
async function runOfflineTypesafeTests() {
  const savedEnv = {};
  for (const name of Object.keys(process.env)) {
    if (/^TYPESAFE_API_KEY$/.test(name)) {
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
    // Happy path: well-formed response -> success envelope, one call.
    {
      process.env.TYPESAFE_API_KEY = "solo";
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return json(SUCCESS, 200);
      };
      const out = (await typesafeJudge({ ...judgeArgs })).structuredContent;
      if (out.fallback !== false || out.answers?.is_bug?.noul !== 0.9) {
        fail(`typesafe happy path: unexpected result ${JSON.stringify(out)}`);
      }
      if (calls !== 1) fail(`typesafe happy path: expected 1 fetch call, got ${calls}`);
      ok("typesafe happy path");
    }

    // Edge case: a single 429 is retried by the SDK default policy and the
    // next attempt succeeds -- no fallback envelope.
    {
      process.env.TYPESAFE_API_KEY = "retry";
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return calls === 1 ? json({ message: "slow down" }, 429) : json(SUCCESS, 200);
      };
      const out = (await typesafeJudge({ ...judgeArgs })).structuredContent;
      if (out.fallback !== false || out.answers?.is_bug?.noul !== 0.9) {
        fail(`typesafe 429 retry: unexpected result ${JSON.stringify(out)}`);
      }
      if (calls !== 2) fail(`typesafe 429 retry: expected 2 fetch calls, got ${calls}`);
      ok("typesafe 429 retried once by SDK default policy");
    }

    // Edge case: every attempt rate-limited -> SDK exhausts default retries
    // (2 retries after the initial call) and the judge returns the fallback
    // envelope with actionable rate-limit text. Issue #121: the fallback
    // envelope carries isError:true per the MCP tool-execution-error rule.
    {
      process.env.TYPESAFE_API_KEY = "limited";
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return json({ message: "slow down" }, 429);
      };
      const result = await typesafeJudge({ ...judgeArgs });
      const out = result.structuredContent;
      if (result.isError !== true || out.fallback !== true || !/rate limited/i.test(out.error ?? "")) {
        fail(`typesafe all-429: expected isError fallback, got isError=${result.isError} ${JSON.stringify(out)}`);
      }
      if (calls !== 3) {
        fail(`typesafe all-429: expected 3 calls (1 + 2 default retries), got ${calls}`);
      }
      ok(`typesafe exhausted 429 retries fall back with isError:true (${out.error})`);
    }

    // Edge case (issue #121): timeout_ms caps the WHOLE request (SDK retries
    // included) via AbortSignal.any -- a hung stub call returns the fallback
    // envelope well within the cap.
    {
      process.env.TYPESAFE_API_KEY = "hung";
      // Stub fetch must honor the abort signal like undici does, otherwise
      // the whole-request cap cannot interrupt it.
      globalThis.fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      const started = Date.now();
      const result = await typesafeJudge({ ...judgeArgs, timeout_ms: 150 });
      const elapsed = Date.now() - started;
      if (result.isError !== true || result.structuredContent?.fallback !== true) {
        fail(`typesafe timeout cap: expected fallback envelope, got ${JSON.stringify(result)}`);
      }
      if (elapsed >= 2000) {
        fail(`typesafe timeout cap: elapsed ${elapsed}ms for timeout_ms=150 -- cap not whole-request`);
      }
      ok(`typesafe timeout_ms caps whole request (fallback after ${elapsed}ms)`);
    }

    // Edge case: non-retryable errors fail fast -- immediate generic fallback,
    // exactly one fetch call.
    {
      process.env.TYPESAFE_API_KEY = "denied";
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
      ok("typesafe non-retryable error returns generic fallback without retry");
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
      // 529 arrives as a generic error with .status (not RateLimitError), so
      // the status checks in isRateLimit are load-bearing -- pin that here.
      const saturated = fallbackFrom({ status: 529, message: "ignored" }, "d");
      if (saturated.structuredContent.error !== "rate limited - retry shortly (HTTP 529)") {
        fail(`fallbackFrom 529: got ${saturated.structuredContent.error}`);
      }
      const defaultMsg = fallbackFrom({}, "typesafe request failed");
      if (defaultMsg.structuredContent.error !== "typesafe request failed") {
        fail(`fallbackFrom default: got ${defaultMsg.structuredContent.error}`);
      }
      ok("fallbackFrom 429/529 vs generic mapping");
    }

    // Happy path: no model override pins DEFAULT_MODEL (jev-1.14.0); a caller
    // override still wins.
    {
      process.env.TYPESAFE_API_KEY = "pin";
      const bodies = [];
      globalThis.fetch = async (...args) => {
        const req = args[0] instanceof Request ? args[0] : new Request(args[0], { ...args[1], duplex: "half" });
        bodies.push(await req.text());
        return json(SUCCESS, 200);
      };
      const pinned = (await typesafeJudge({ ...judgeArgs })).structuredContent;
      if (pinned.fallback !== false) fail(`DEFAULT_MODEL: unexpected result ${JSON.stringify(pinned)}`);
      if (!bodies[0].includes("jev-1.14.0")) fail(`DEFAULT_MODEL: expected jev-1.14.0 in ${bodies[0]}`);
      if (DEFAULT_MODEL !== "jev-1.14.0") fail(`DEFAULT_MODEL export: got ${DEFAULT_MODEL}`);
      const overridden = (
        await typesafeJudge({ ...judgeArgs, model: "jev-9.9.9" })
      ).structuredContent;
      if (overridden.fallback !== false) fail("model override: unexpected fallback");
      if (!bodies[1].includes("jev-9.9.9")) fail(`model override: expected jev-9.9.9 in ${bodies[1]}`);
      ok("DEFAULT_MODEL pin with caller override honored");
    }

    // Happy path (issue #142): a noul question referencing an image builds
    // assets from base64 bytes, sends the danger-zone header, and answers.
    {
      process.env.TYPESAFE_API_KEY = "img";
      const IMG_SUCCESS = {
        answers: { defect: { type: "noul", noul: 0.95 } },
        model: DEFAULT_MODEL,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      let captured;
      globalThis.fetch = async (...args) => {
        const req = args[0] instanceof Request ? args[0] : new Request(args[0], { ...args[1], duplex: "half" });
        captured = { headers: req.headers, body: await req.text() };
        return json(IMG_SUCCESS, 200);
      };
      const out = (
        await typesafeJudge({
          state: { page: "checkout" },
          questions: {
            defect: { type: "noul", instructions: "Does the rendering in <shot> show a defect?" },
          },
          images: { shot: Buffer.from("png-bytes-0").toString("base64") },
        })
      ).structuredContent;
      if (out.fallback !== false || out.answers?.defect?.noul !== 0.95) {
        fail(`typesafe image happy path: unexpected result ${JSON.stringify(out)}`);
      }
      if (captured.headers.get("typesafe-danger-zone-images") !== "true") {
        fail("typesafe image happy path: missing TypeSafe-Danger-Zone-Images header");
      }
      if (!captured.body.includes("png-bytes-0")) fail("typesafe image happy path: image bytes not sent as an asset");
      if (!captured.body.includes("<shot>")) fail("typesafe image happy path: asset reference missing from request");
      ok("typesafe image happy path (assets, danger-zone header, typed answer)");
    }

    // Edge cases (issue #142): validateImages rejections -- score over
    // images, box over images, and an image no noul/choice question
    // references. Each must throw a clear error before any request.
    {
      const images = { shot: "aGk=" };
      const cases = [
        [
          { rate: { type: "score", instructions: "Rate <shot>", criteria: ["low", "high"] } },
          /score questions are not supported with images/,
          "score over images",
        ],
        [
          { locate: { type: "box", instructions: "Locate the button in <shot>" } },
          /box questions are not supported with images/,
          "box over images",
        ],
        [
          { is_bug: { type: "noul", instructions: "Is this a defect?" } },
          /not referenced by any noul or choice question/,
          "unreferenced image",
        ],
      ];
      for (const [questions, pattern, label] of cases) {
        let threw;
        try {
          validateImages(questions, images);
        } catch (err) {
          threw = err;
        }
        if (!threw || !pattern.test(threw.message)) {
          fail(`validateImages ${label}: expected rejection matching ${pattern}, got ${String(threw)}`);
        }
      }
      // And the happy-path cross-check: a noul question referencing the
      // image is accepted without throwing.
      validateImages(
        { is_bug: { type: "noul", instructions: "Is there a defect in <shot>?" } },
        images,
      );
      ok("validateImages rejects score/box over images and unreferenced images, accepts referenced noul");
    }

    // Edge case (issue #142): loadImagesFromPaths rejections -- wrong format,
    // dimensions outside 256-1568 px, missing file, and an invalid asset key;
    // plus the happy path base64 round-trip.
    {
      const dir = mkdtempSync(join(tmpdir(), "judge-smoke-"));
      const tinyPath = join(dir, "tiny.png");
      writeFileSync(tinyPath, encodeSolidPng(128, 128, [255, 0, 0]));
      const textPath = join(dir, "text.png");
      writeFileSync(textPath, "not an image");
      const goodPath = join(dir, "good.png");
      writeFileSync(goodPath, encodeSolidPng(256, 256, [0, 0, 255]));
      const cases = [
        [{ shot: tinyPath }, /256-1568 px/, "undersized dimensions"],
        [{ shot: textPath }, /not a PNG or JPEG/, "wrong format"],
        [{ shot: join(dir, "missing.png") }, /not readable/, "missing file"],
        [{ "bad key!": goodPath }, /outside \[A-Za-z0-9_-\]/, "invalid asset key"],
      ];
      for (const [images, pattern, label] of cases) {
        let threw;
        try {
          loadImagesFromPaths(images);
        } catch (err) {
          threw = err;
        }
        if (!threw || !pattern.test(threw.message)) {
          fail(`loadImagesFromPaths ${label}: expected rejection matching ${pattern}, got ${String(threw)}`);
        }
      }
      const loaded = loadImagesFromPaths({ shot: goodPath });
      if (loaded.shot !== encodeSolidPng(256, 256, [0, 0, 255]).toString("base64")) {
        fail("loadImagesFromPaths happy path: base64 mismatch");
      }
      ok("loadImagesFromPaths rejects invalid images, base64-encodes valid ones");
    }
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(process.env)) {
      if (/^TYPESAFE_API_KEY$/.test(name)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(savedEnv)) process.env[name] = value;
  }
}

// Issue #122: TYPESAFE_DEFAULT_MODEL must override the pinned default on the
// typesafe path. DEFAULT_MODEL is read at module load, so spawn a subprocess
// that sets the env before importing the provider, stubs fetch, and asserts
// the request body model (the caller override still wins is covered
// in-process above).
function runEnvModelOverrideTest() {
  return new Promise((resolve) => {
    const script = [
      "process.env.TYPESAFE_API_KEY = 'smoke';",
      "process.env.TYPESAFE_DEFAULT_MODEL = 'jev-env-override';",
      "const m = await import(new URL('./providers/typesafe-api.mjs', 'file://' + process.cwd() + '/'));",
      "if (m.DEFAULT_MODEL !== 'jev-env-override') { console.error('DEFAULT_MODEL=' + m.DEFAULT_MODEL); process.exit(1); }",
      "let body = '';",
      "globalThis.fetch = async (url, init) => { body = init && typeof init.body === 'string' ? init.body : await new Request(url, { ...init, duplex: 'half' }).text(); return new Response(JSON.stringify({ answers: {}, model: 'x', usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } }); };",
      "const out = await m.typesafeJudge({ state: {}, questions: { q: { instructions: 'Is this a defect?' } } });",
      "if (out.structuredContent.fallback !== false) { console.error('unexpected fallback: ' + JSON.stringify(out.structuredContent)); process.exit(1); }",
      "if (!body.includes('jev-env-override')) { console.error('BODY=' + body); process.exit(1); }",
      "console.log('OK');",
    ].join("\n");
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"], cwd: new URL("..", import.meta.url).pathname },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => fail("env model override: subprocess timed out"), TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(t);
      if (code !== 0 || !out.includes("OK")) {
        fail(`env model override: exit ${code}, output ${out.slice(0, 300)}`);
      }
      ok("TYPESAFE_DEFAULT_MODEL override honored (request body model = jev-env-override)");
      resolve();
    });
    child.on("error", (err) => fail(`env model override: spawn failed: ${err.message}`));
  });
}

// Issue #122: exactly one validateQuestionSpec call site (inside buildQuestion
// in providers/typesafe-api.mjs); the judgeHandler loop in server.mjs is gone.
function assertSingleValidationSite() {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const provider = readFileSync(
    new URL("../providers/typesafe-api.mjs", import.meta.url),
    "utf8",
  );
  const serverCalls = (server.match(/validateQuestionSpec\(/g) ?? []).length;
  if (serverCalls !== 0) {
    fail(`validateQuestionSpec: expected 0 occurrences in server.mjs, got ${serverCalls}`);
  }
  const providerMatches = provider.match(/validateQuestionSpec\(/g) ?? [];
  // One definition + exactly one call site.
  if (providerMatches.length !== 2) {
    fail(`validateQuestionSpec: expected definition + 1 call in typesafe-api.mjs, got ${providerMatches.length}`);
  }
  if (!/function validateQuestionSpec\(/.test(provider)) {
    fail("validateQuestionSpec definition missing in typesafe-api.mjs");
  }
  ok("exactly one validateQuestionSpec call site");
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

// Issue #121: with serveStdio, a client whose opening message carries a valid
// 2026-07-28 per-request envelope gets pinned to the modern era, where the
// modern-only server/discover handler is answered.
function runStdioDiscoverTest() {
  const env = { ...process.env };
  delete env.JUDGE_PROVIDER;
  delete env.TYPESAFE_API_KEY;
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
        if (msg.error || typeof msg.result !== "object") {
          stdioFail(`server/discover failed: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        ok(`server/discover served on modern era (${JSON.stringify(msg.result).slice(0, 160)})`);
        proc.kill("SIGKILL");
      }
    }
  });
  const timer = setTimeout(() => stdioFail("server/discover test timed out"), TIMEOUT_MS);
  proc.on("exit", () => clearTimeout(timer));
  proc.on("error", (err) => stdioFail(`failed to spawn server: ${err.message}`));
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      // 2026-07-28 per-request envelope: the opening message's valid modern
      // envelope claim is what pins the connection to the modern era.
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

// Stdio smoke: with JUDGE_PROVIDER unset, the judge path behaves exactly as on
// main -- fallback envelope for a malformed question, widened inputs accepted.
function runStdioDefaultPathTest() {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.JUDGE_PROVIDER;
  delete env.TYPESAFE_API_KEY;
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
        if (!payload.error || !/criteria/i.test(payload.error) || !/questions\.q:/.test(payload.error)) {
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
        // Regression (issue #90): omitted `type` must be rejected with
        // INVALID_PARAMS, not silently defaulted to noul.
        send({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "judge",
            arguments: {
              state: {},
              questions: { q: { instructions: "Is this a defect?" } },
            },
          },
        });
      } else if (msg.id === 4) {
        clearTimeout(timer);
        const text4 = msg.result?.content?.[0]?.text;
        if (!msg.result?.isError || !text4) {
          stdioFail(`expected INVALID_PARAMS for omitted type, got: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        if (!/missing "type" \(noul\|choice\|score\)/.test(text4) || !/questions\.q/.test(text4)) {
          stdioFail(`expected error naming "type", got: ${text4}`);
        }
        ok(`omitted type rejected: ${text4.slice(0, 120)}`);
        // Regression (issue #90): unknown keys must be rejected, not stripped.
        send({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "judge",
            arguments: {
              // Secret state value: the hint must never echo caller content.
              state: { secret: "hunter2" },
              questions: {
                q: { choice: true, criteria: { confirm: "yes", demote: "no" } },
              },
            },
          },
        });
      } else if (msg.id === 5) {
        clearTimeout(timer);
        const text5 = msg.result?.content?.[0]?.text;
        if (!msg.result?.isError || !text5) {
          stdioFail(`expected INVALID_PARAMS for unknown key, got: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        if (!/use "criteria", not "choice"/.test(text5) || !/questions\.q/.test(text5)) {
          stdioFail(`expected choices-vs-criteria hint, got: ${text5}`);
        }
        if (text5.includes("hunter2")) {
          stdioFail(`hint leaked state content: ${text5}`);
        }
        ok(`choices-vs-criteria hint: ${text5.slice(0, 200)}`);
        // Explicitly-typed choice and score questions must still parse.
        send({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "judge",
            arguments: {
              state: {},
              questions: {
                tier: {
                  type: "choice",
                  criteria: { confirm: "medium", demote: "simple", promote: "complex" },
                },
              },
            },
          },
        });
      } else if (msg.id === 6) {
        clearTimeout(timer);
        const text6 = msg.result?.content?.[0]?.text;
        if (msg.error || !text6) {
          stdioFail(`valid choice rejected by schema: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        send({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "judge",
            arguments: {
              state: {},
              questions: {
                rating: {
                  type: "score",
                  criteria: ["low", "medium", "high"],
                },
              },
            },
          },
        });
      } else if (msg.id === 7) {
        clearTimeout(timer);
        const text7 = msg.result?.content?.[0]?.text;
        if (msg.error || !text7) {
          stdioFail(`valid score rejected by schema: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        ok("explicitly-typed choice and score questions accepted");
        // Issue #120: array-shaped questions rejected with a fix hint naming
        // the expected map shape.
        send({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "judge",
            arguments: {
              state: {},
              questions: [{ type: "noul", instructions: "flat question" }],
            },
          },
        });
      } else if (msg.id === 8) {
        clearTimeout(timer);
        const text8 = msg.result?.content?.[0]?.text;
        if (!msg.result?.isError || !text8) {
          stdioFail(`expected INVALID_PARAMS for array questions, got: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        if (!/expected a map of named question specs, got an array/.test(text8)) {
          stdioFail(`expected array-questions hint, got: ${text8}`);
        }
        ok(`array-questions hint: ${text8.slice(0, 200)}`);
        // Issue #122 + #142: tools/list must succeed (no -32603) and stay
        // under 4 KiB. The original 3 KiB target left only 44 bytes of
        // headroom; the #142 images schema (asset name -> local file path)
        // adds ~400 bytes of JSON schema, so the cap is 4096.
        send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
      } else if (msg.id === 9) {
        clearTimeout(timer);
        if (msg.error) {
          stdioFail(`tools/list failed: ${JSON.stringify(msg.error).slice(0, 300)}`);
        }
        const toolsJson = JSON.stringify(msg.result);
        const bytes = Buffer.byteLength(toolsJson);
        if (!msg.result?.tools?.length) {
          stdioFail(`tools/list returned no tools: ${toolsJson.slice(0, 200)}`);
        }
        if (bytes >= 4096) {
          stdioFail(`tools/list payload too large: ${bytes} bytes (target < 4096)`);
        }
        ok(`tools/list ok (${bytes} bytes, under 4096)`);
        send({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "judge",
            arguments: {
              state: {},
              questions: {
                rating: {
                  type: "score",
                  instructions: "rate it",
                  criteria: Array.from({ length: 11 }, (_, i) => `level ${i + 1}`),
                },
              },
            },
          },
        });
      } else if (msg.id === 10) {
        clearTimeout(timer);
        const text10 = msg.result?.content?.[0]?.text;
        if (!msg.result?.isError || !text10) {
          stdioFail(`expected INVALID_PARAMS for 11 score levels, got: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        if (!/at most 10 levels/.test(text10)) {
          stdioFail(`expected 10-levels hint, got: ${text10}`);
        }
        ok(`score 11 levels rejected: ${text10.slice(0, 120)}`);
        // Issue #122: API limits enforced in zod -- 256 choice options must be
        // rejected at the schema layer.
        const manyOptions = Object.fromEntries(
          Array.from({ length: 256 }, (_, i) => [`option_${i}`, "description"]),
        );        send({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "judge",
            arguments: {
              state: {},
              questions: {
                pick: { type: "choice", instructions: "pick one", criteria: manyOptions },
              },
            },
          },
        });
      } else if (msg.id === 11) {
        clearTimeout(timer);
        const text11 = msg.result?.content?.[0]?.text;
        if (!msg.result?.isError || !text11) {
          stdioFail(`expected INVALID_PARAMS for 256 choice options, got: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        if (!/at most 255 options/.test(text11)) {
          stdioFail(`expected 255-options hint, got: ${text11}`);
        }
        ok(`choice 256 options rejected: ${text11.slice(0, 120)}`);
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

// Issue #142: live image smoke case -- only when TYPESAFE_API_KEY is set.
// Writes a solid 256x256 PNG to a temp file and calls the SDK directly (as
// scripts/probe-images.mjs does; the in-process typesafeJudge client is
// cached with offline fake keys by earlier cases). Requires a non-fallback
// noul answer.
async function runLiveImageSmokeTest() {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key || key.trim() === "") {
    console.log("smoke-judge: SKIP (live image case; TYPESAFE_API_KEY not set)");
    return;
  }
  const { TypeSafeClient, image, noul } = await import("@typesafe-ai/sdk");
  const dir = mkdtempSync(join(tmpdir(), "judge-smoke-live-"));
  const imagePath = join(dir, "shot.png");
  writeFileSync(imagePath, encodeSolidPng(512, 512, [255, 0, 0]));
  const bytes = readFileSync(imagePath);
  try {
    const client = new TypeSafeClient({ logLevel: "off" });
    const result = await client.systemOne(
      {
        state: image(bytes),
        questions: {
          red_present: {
            type: "noul",
            instructions: "Is there a solid red colored region in the image?",
          },
        },
        model: DEFAULT_MODEL,
      },
      { headers: { "TypeSafe-Danger-Zone-Images": "true" }, timeout: 30000 },
    );
    const p = result.answers?.red_present?.noul;
    if (typeof p !== "number") {
      fail(`live image smoke: unexpected result ${JSON.stringify(result).slice(0, 300)}`);
    }
    ok(`live image smoke (noul=${p})`);
  } catch (err) {
    fail(`live image smoke: request failed: ${err}`);
  }
}
await runOfflineCloudflareTests();

await runOfflineTypesafeTests();
assertSingleValidationSite();
await runEnvModelOverrideTest();
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

runStdioDiscoverTest();
await runLiveImageSmokeTest();
setTimeout(() => runStdioDefaultPathTest(), 500);
