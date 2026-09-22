// Typesafe API provider for the judge tool (default backend).
//
// Sends application state plus typed questions (noul / choice / score) to the
// TypeSafe System One API in a single request and returns the raw typed
// answers plus model/usage metadata. Retries, timeouts, and model resolution
// (jev-latest) are owned by @typesafe-ai/sdk. Client disconnects abort the
// in-flight request. Auth: TYPESAFE_API_KEY (SDK standard).
//
// Any failure returns { fallback: true, error: "..." } -- never blocks.

import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

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
// default message; append " (HTTP N)" when err.status is a number.
export function fallbackFrom(err, defaultMessage) {
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

// Lazily-created client, cached for the process lifetime; auth via TYPESAFE_API_KEY.
let client;
function getClient() {
  return (client ??= new TypeSafeClient({ logLevel: "off" }));
}

// Typesafe path (default): validateQuestionSpec (via buildQuestion) guards the
// question specs, then the SDK question objects are constructed.
export async function typesafeJudge({ state, questions, timeout_ms, model }, ctx) {
  let qmap;
  try {
    qmap = Object.fromEntries(
      Object.entries(questions).map(([name, spec]) => [name, buildQuestion(spec)]),
    );
  } catch (err) {
    return fallbackFrom(err, "question construction failed");
  }
  try {
    const request = { state, questions: qmap };
    if (model) request.model = model;
    const options = (timeout_ms || ctx?.signal) ? { timeout: timeout_ms, signal: ctx?.signal } : undefined;
    const result = await getClient().systemOne(request, options);
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
