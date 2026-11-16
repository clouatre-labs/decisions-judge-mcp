// Typesafe API provider for the judge tool (default backend).
//
// Sends application state plus typed questions (noul / choice / score) to the
// TypeSafe System One API in a single request and returns the raw typed
// answers plus model/usage metadata. Retries, timeouts, and model resolution
// (pinned by DEFAULT_MODEL) are owned by @typesafe-ai/sdk. Client disconnects abort the
// in-flight request. Auth: the SDK resolves TYPESAFE_API_KEY from the
// environment.
//
// Any failure returns { fallback: true, error: "..." } -- never blocks.

import { RateLimitError, TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

// Default model for the TypeSafe path when the caller passes no `model`.
// Bumping is a manual responsibility. Automated Renovate upgrades were
// investigated and rejected: GET /v1/models is account-scoped and
// Bearer-authed (it answers "what can this account use", not "what versions
// exist"), and docs.typesafe.ai/models.md lists versions only in prose,
// which no Renovate custom datasource format parses. If TypeSafe publishes
// a machine-readable version feed (typesafe-ai/typesafe-sdk-js#22), a
// customDatasources rule makes this automatic.
// Caller model overrides always win.
export const DEFAULT_MODEL = "jev-1.14.0";

// Single lazily-created client for the process lifetime, relying on the SDK's
// default retry policy (408/429/5xx with Retry-After respected). logLevel
// "off" keeps stdout clean for stdio MCP framing.
let client;
function getClient() {
  if (!client) client = new TypeSafeClient({ logLevel: "off" });
  return client;
}

// Rate-limit test used by fallbackFrom: only 429 maps to RateLimitError in
// the SDK; 529 arrives as a generic error with .status, so the status checks
// are load-bearing.
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
export function validateQuestionSpec(spec, name) {
  // Caller-visible hint prefix: names the offending question so a multi-question
  // request can be fixed in one round-trip. Aggregates only -- never echoes
  // spec content (instructions/criteria values) back to the caller.
  const hint = name ? `questions.${name}: ` : "";
  if (spec.type === "choice") {
    if (!spec.criteria || Array.isArray(spec.criteria) || typeof spec.criteria !== "object") {
      throw new Error(`${hint}choice question requires "criteria" as an object of {option: description}; add criteria mapping each option name to a description`);
    }
  } else if (spec.type === "score") {
    if (!Array.isArray(spec.criteria) || spec.criteria.length < 2) {
      throw new Error(`${hint}score question requires "criteria" as an ordered array of at least two level descriptions; add criteria like ["low", "high"]`);
    }
  }
}

function buildQuestion(spec, name) {
  validateQuestionSpec(spec, name);
  if (spec.type === "choice") {
    return choice(spec.instructions, spec.criteria);
  }
  if (spec.type === "score") {
    return score(spec.instructions, spec.criteria);
  }
  return noul(spec.instructions, spec.criteria);
}

// Typesafe path (default): validateQuestionSpec (via buildQuestion) guards the
// question specs, then the SDK question objects are constructed. Any failure
// lands in the fallback envelope.
export async function typesafeJudge({ state, questions, timeout_ms, model }, ctx) {
  let qmap;
  try {
    qmap = Object.fromEntries(
      Object.entries(questions).map(([name, spec]) => [name, buildQuestion(spec, name)]),
    );
  } catch (err) {
    return fallbackFrom(err, "question construction failed");
  }
  const request = { state, questions: qmap, model: model ?? DEFAULT_MODEL };
  const options = {};
  if (timeout_ms) options.timeout = timeout_ms;
  if (ctx?.signal) options.signal = ctx.signal;
  try {
    const result = await getClient().systemOne(
      request,
      Object.keys(options).length > 0 ? options : undefined,
    );
    return envelope({
      answers: result.answers,
      model: result.model,
      usage: result.usage,
      fallback: false,
    });
  } catch (err) {
    return fallbackFrom(err, "typesafe request failed");
  }
}
