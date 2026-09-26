// Typesafe API provider for the judge tool (default backend).
//
// Sends application state plus typed questions (noul / choice / score) to the
// TypeSafe System One API in a single request and returns the raw typed
// answers plus model/usage metadata. Retries, timeouts, and model resolution
// (jev-latest) are owned by @typesafe-ai/sdk. Client disconnects abort the
// in-flight request. Auth: TYPESAFE_API_KEYS (CSV, first) or TYPESAFE_API_KEY
// plus TYPESAFE_API_KEY_2..9. Keys are tried in order; on a rate limit
// (429/529) the judge rotates to the next key. 429 is excluded from each
// client's SDK retry policy so rotation owns rate-limit handling.
//
// Any failure returns { fallback: true, error: "..." } -- never blocks.

import { RateLimitError, TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

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
  const isRateLimit = err instanceof RateLimitError || err?.status === 429 || err?.status === 529;
  if (isRateLimit) {
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

function buildQuestion(spec) {
  validateQuestionSpec(spec);
  if (spec.type === "choice") {
    return choice(spec.instructions, spec.criteria);
  }
  if (spec.type === "score") {
    return score(spec.instructions, spec.criteria);
  }
  return noul(spec.instructions, spec.criteria);
}

// Typesafe path (default): validateQuestionSpec (via buildQuestion) guards the
// question specs, then the SDK question objects are constructed. On a rate
// limit the request rotates through the remaining configured keys before any
// fallback envelope is returned (no delay per attempt).
export async function typesafeJudge({ state, questions, timeout_ms, model }, ctx) {
  let qmap;
  try {
    qmap = Object.fromEntries(
      Object.entries(questions).map(([name, spec]) => [name, buildQuestion(spec)]),
    );
  } catch (err) {
    return fallbackFrom(err, "question construction failed");
  }
  const request = { state, questions: qmap };
  if (model) request.model = model;
  const options = (timeout_ms || ctx?.signal) ? { timeout: timeout_ms, signal: ctx?.signal } : undefined;
  let lastErr;
  for (const key of parseKeys()) {
    try {
      const result = await getClient(key).systemOne(request, options);
      return envelope({
        answers: result.answers,
        model: result.model,
        usage: result.usage,
        fallback: false,
      });
    } catch (err) {
      lastErr = err;
      const rateLimited = err instanceof RateLimitError || err?.status === 429 || err?.status === 529;
      if (!rateLimited) return fallbackFrom(err, "typesafe request failed");
    }
  }
  return fallbackFrom(lastErr, "typesafe request failed");
}
