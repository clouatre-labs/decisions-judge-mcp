// Typesafe API provider for the judge tool (default backend).
//
// Sends application state plus typed questions (noul / choice / score) to the
// TypeSafe System One API in a single request and returns the raw typed
// answers plus model/usage metadata. Retries, timeouts, and model resolution
// (pinned by DEFAULT_MODEL) are owned by @typesafe-ai/sdk. Client disconnects abort the
// in-flight request. Auth: TYPESAFE_API_KEYS (CSV, first) or TYPESAFE_API_KEY
// plus TYPESAFE_API_KEY_2..9. Keys are tried in order; on a rate limit
// (429/529) the judge rotates to the next key. 429 is excluded from each
// client's SDK retry policy so rotation owns rate-limit handling.
//
// Any failure returns { fallback: true, error: "..." } -- never blocks.

import { Image, RateLimitError, TypeSafeClient, box, choice, noul, score } from "@typesafe-ai/sdk";

// Default model for the TypeSafe path, pinned so upgrades are explicit and
// reviewable (a Renovate custom manager opens the bump PR). Caller model
// overrides always win. The Cloudflare path keeps its own typesafe/jev default.
// Default model for the TypeSafe path when the caller passes no `model`.
// Bumping is a manual responsibility. Automated Renovate upgrades were
// investigated and rejected: GET /v1/models requires Bearer auth (Renovate
// custom datasources can authenticate via hostRules, but the hosted Renovate
// app cannot receive that secret), and the public docs page
// https://docs.typesafe.ai/models.md lists model versions only in prose,
// which Renovate custom datasource formats cannot parse. If TypeSafe
// publishes a JSON model-version endpoint, a customDatasources rule makes
// this automatic.
export const DEFAULT_MODEL = "jev-1.14.0";

// Parse the configured key list: TYPESAFE_API_KEYS CSV first, else
// TYPESAFE_API_KEY and TYPESAFE_API_KEY_2..9. Segments are trimmed, empty
// segments dropped, and duplicates removed, preserving first-seen order.
export function parseKeys(env = process.env) {
  const raw = [];
  if (env.TYPESAFE_API_KEYS !== undefined && env.TYPESAFE_API_KEYS !== "") {
    raw.push(...env.TYPESAFE_API_KEYS.split(","));
  } else {
    raw.push(env.TYPESAFE_API_KEY ?? "");
    for (let i = 2; i <= 9; i++) raw.push(env[`TYPESAFE_API_KEY_${i}`] ?? "");
  }
  const keys = [];
  for (const segment of raw) {
    const key = segment.trim();
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Lazily-created clients cached per key for the process lifetime. 429 is
// excluded from per-client retries so key rotation owns rate-limit handling;
// the SDK keeps 408/5xx retries.
const clientCache = new Map();
function getClient(key) {
  let client = clientCache.get(key);
  if (!client) {
    client = new TypeSafeClient({
      apiKey: key,
      logLevel: "off",
      retry: { httpStatuses: [408, 500, 502, 503, 504], respectRetryAfter: false },
    });
    clientCache.set(key, client);
  }
  return client;
}

// Rate-limit test shared by fallbackFrom and the rotation loop: only 429 maps
// to RateLimitError in the SDK; 529 arrives as a generic error with .status,
// so the status checks are load-bearing.
export function isRateLimit(err) {
  return err instanceof RateLimitError || err?.status === 429 || err?.status === 529;
}

export function envelope(payload) {
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export function fallbackEnvelope(error) {
  return envelope({ fallback: true, error });
}

// Build a fallback envelope from a thrown value: prefer err.message, else the
// default message; rate limits (RateLimitError or status 429/529) get
// actionable retry-soon text (with the server's retryAfterMs when provided);
// other API errors append " (HTTP N)" when err.status is a number.
export function fallbackFrom(err, defaultMessage) {
  if (isRateLimit(err)) {
    let message = "rate limited - retry shortly";
    if (typeof err?.retryAfterMs === "number") message += ` (retry after ${err.retryAfterMs}ms)`;
    if (typeof err?.status === "number") message += ` (HTTP ${err.status})`;
    return fallbackEnvelope(message);
  }
  let message = err && err.message ? err.message : defaultMessage;
  if (err && typeof err.status === "number") message = `${message} (HTTP ${err.status})`;
  return fallbackEnvelope(message);
}

// Criteria checks shared by both provider paths. Runs before any question
// construction so malformed questions return the documented fallback error
// (never an API request).
export function validateQuestionSpec(spec) {
  if (spec.type === "choice") {
    if (!spec.criteria || Array.isArray(spec.criteria) || typeof spec.criteria !== "object") {
      throw new Error(`choice question requires criteria as an object of {option: description}`);
    }
  } else if (spec.type === "score") {
    if (!Array.isArray(spec.criteria) || spec.criteria.length < 2) {
      throw new Error(`score question requires criteria as an ordered array of at least two level descriptions`);
    }
  }
}

// Cross-checks between box questions and the top-level images map. Runs in
// judgeHandler before any request so malformed box/images combinations return
// the documented fallback error. Each box question must reference at least
// one <name> from the images map, and every images entry must be referenced
// by at least one box question.
export function validateImages(questions, images) {
  const boxSpecs = Object.values(questions ?? {}).filter((spec) => spec?.type === "box");
  const imageNames = images && typeof images === "object" ? Object.keys(images) : [];
  if (boxSpecs.length > 0 && imageNames.length === 0) {
    throw new Error(
      "box questions require the top-level images map (name -> {data})",
    );
  }
  const referenced = new Set();
  for (const spec of boxSpecs) {
    if (typeof spec.instructions !== "string" || spec.instructions === "") {
      throw new Error("box question requires instructions text referencing an image as <name>");
    }
    const refs = [...spec.instructions.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
    for (const r of refs) referenced.add(r);
    if (!refs.some((name) => imageNames.includes(name))) {
      throw new Error(
        `box question instructions must reference at least one image name from the images map as <name> (available: ${imageNames.join(", ")})`,
      );
    }
  }
  for (const name of imageNames) {
    if (!referenced.has(name)) {
      throw new Error(
        `images map entry "${name}" is not referenced by any box question as <name>; images are accepted only for box questions`,
      );
    }
  }
}

function buildQuestion(spec) {
  validateQuestionSpec(spec);
  if (spec.type === "choice") {
    return choice(spec.instructions, spec.criteria);
  }
  if (spec.type === "score") {
    return score(spec.instructions, spec.criteria);
  }
  if (spec.type === "box") {
    return box(spec.instructions);
  }
  return noul(spec.instructions, spec.criteria);
}

// Typesafe path (default): validateQuestionSpec (via buildQuestion) guards the
// question specs, then the SDK question objects are constructed. On a rate
// limit the request rotates through the remaining configured keys before any
// fallback envelope is returned (no delay per attempt).
export async function typesafeJudge({ state, questions, images, timeout_ms, model }, ctx) {
  let qmap;
  try {
    qmap = Object.fromEntries(
      Object.entries(questions).map(([name, spec]) => [name, buildQuestion(spec)]),
    );
  } catch (err) {
    return fallbackFrom(err, "question construction failed");
  }
  const request = { state, questions: qmap, model: model ?? DEFAULT_MODEL };
  // Assets are built only from image names actually referenced by box
  // instructions; every asset sent must appear in the request or the SDK
  // rejects before sending. Image bytes are decoded from the top-level
  // images map only -- never from questions or state.
  const imageNames = images && typeof images === "object" ? Object.keys(images) : [];
  const referenced = new Set();
  for (const spec of Object.values(questions)) {
    if (spec?.type !== "box" || typeof spec.instructions !== "string") continue;
    for (const match of spec.instructions.matchAll(/<([^<>\s]+)>/g)) {
      if (imageNames.includes(match[1])) referenced.add(match[1]);
    }
  }
  if (referenced.size > 0) {
    try {
      request.assets = Object.fromEntries(
        [...referenced].map((name) => [name, Image.fromBase64(images[name].data)]),
      );
    } catch (err) {
      return fallbackFrom(err, "image decoding failed");
    }
  }
  const options = {};
  if (timeout_ms) options.timeout = timeout_ms;
  if (ctx?.signal) options.signal = ctx.signal;
  if (referenced.size > 0) {
    // Required by the API for any request carrying box questions.
    options.headers = { "TypeSafe-Danger-Zone-Images": "true" };
  }
  let lastErr;
  for (const key of parseKeys()) {
    try {
      const result = await getClient(key).systemOne(request, Object.keys(options).length > 0 ? options : undefined);
      return envelope({
        answers: result.answers,
        model: result.model,
        usage: result.usage,
        fallback: false,
      });
    } catch (err) {
      lastErr = err;
      if (!isRateLimit(err)) return fallbackFrom(err, "typesafe request failed");
    }
  }
  return fallbackFrom(lastErr, "typesafe request failed");
}
