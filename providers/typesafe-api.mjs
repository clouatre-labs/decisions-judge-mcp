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

import {
  Image,
  RateLimitError,
  TypeSafeClient,
  choice,
  noul,
  score,
} from "@typesafe-ai/sdk";
import { readFileSync, statSync } from "node:fs";

// Default model for the TypeSafe path when the caller passes no `model`.
// Bumping is a manual responsibility. Automated Renovate upgrades were
// investigated and rejected: GET /v1/models is account-scoped and
// Bearer-authed (it answers "what can this account use", not "what versions
// exist"), and docs.typesafe.ai/models.md lists versions only in prose,
// which no Renovate custom datasource format parses. If TypeSafe publishes
// a machine-readable version feed (typesafe-ai/typesafe-sdk-js#22), a
// customDatasources rule makes this automatic.
// Caller model overrides always win over the default; TYPESAFE_DEFAULT_MODEL
// (read once at module load) overrides the pinned default on this typesafe
// path only -- the Cloudflare CF_DEFAULT_MODEL pin is unaffected, and there
// is deliberately no floor check on the env value.
export const DEFAULT_MODEL = process.env.TYPESAFE_DEFAULT_MODEL || "jev-1.14.0";

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
  // MCP spec: tool execution errors are reported inside the CallToolResult
  // with isError:true, not as protocol-level JSON-RPC errors.
  return { ...envelope({ fallback: true, error }), isError: true };
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

// Validates every question spec once, before provider dispatch, so both
// providers return the same fix-hint fallback. Returns the first error's
// message, or null when all specs are well formed.
export function validateQuestions(questions) {
  for (const [name, spec] of Object.entries(questions ?? {})) {
    try {
      validateQuestionSpec(spec, name);
    } catch (err) {
      return err && err.message ? err.message : "question validation failed";
    }
  }
  return null;
}

// Image asset limits (TypeSafe images API): PNG/JPEG only, 256-1568 px per
// side, 16 MiB per file. Enforced by loadImagesFromPaths before any request.
const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const IMAGE_MIN_DIM = 256;
const IMAGE_MAX_DIM = 1568;

// Cross-checks between the top-level images map and the questions that may
// reference it. Runs in judgeHandler before any request so malformed
// images/question combinations return the documented fallback error. Images
// are accepted only for noul/choice questions: each image must be referenced
// by at least one such question as <name> in instructions, and score/box
// questions over images are rejected outright.
export function validateImages(questions, images) {
  const imageNames = images && typeof images === "object" ? Object.keys(images) : [];
  if (imageNames.length === 0) return;
  const specs = Object.values(questions ?? {});
  for (const spec of specs) {
    if (spec?.type === "score" || spec?.type === "box") {
      throw new Error(
        `${spec.type} questions are not supported with images; only noul and choice questions may reference the images map`,
      );
    }
  }
  const referenced = new Set();
  for (const spec of specs) {
    if (spec?.type !== "noul" && spec?.type !== "choice") continue;
    if (typeof spec.instructions !== "string") continue;
    for (const match of spec.instructions.matchAll(/<([^<>"]+)>/g)) {
      referenced.add(match[1]);
    }
  }
  for (const name of imageNames) {
    if (!referenced.has(name)) {
      throw new Error(
        `images map entry "${name}" is not referenced by any noul or choice question as <name>; images are accepted only when referenced`,
      );
    }
  }
}

// PNG: 8-byte magic, IHDR width/height as UInt32BE at offsets 16/20.
function pngDimensions(buf) {
  if (
    buf.length < 24 ||
    !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    buf.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// JPEG: 0xFFD8FF magic, then scan segment markers for an SOF0/SOF1/SOF2
// frame header carrying the dimensions (height/width, 2 bytes each,
// big-endian, after the 1-byte precision).
function jpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let offset = 2;
  while (offset + 9 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

// Read each image file path, enforce the size/format/dimension limits, and
// return {name -> base64 bytes} for the request. Asset keys are sanitized to
// [A-Za-z0-9_-] (anything else, or a sanitized collision, is rejected with a
// caller-visible hint); every failure throws with a clear message so
// judgeHandler lands it in the fallback envelope.
export function loadImagesFromPaths(images) {
  const imageNames = images && typeof images === "object" ? Object.keys(images) : [];
  const out = {};
  for (const name of imageNames) {
    const sanitized = name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (sanitized !== name) {
      throw new Error(
        `images map key "${name}" contains characters outside [A-Za-z0-9_-]; rename the asset key`,
      );
    }
    if (sanitized in out) {
      throw new Error(`images map key "${name}" collides with an existing asset key after sanitization`);
    }
    const path = images[name];
    if (typeof path !== "string" || path === "") {
      throw new Error(`images map entry "${name}" must be a local file path string`);
    }
    let stats;
    try {
      stats = statSync(path);
    } catch {
      throw new Error(`images map entry "${name}": file not readable at the given path`);
    }
    if (!stats.isFile()) {
      throw new Error(`images map entry "${name}": path is not a regular file`);
    }
    if (stats.size > IMAGE_MAX_BYTES) {
      throw new Error(
        `images map entry "${name}" exceeds the 16 MiB file limit (${stats.size} bytes)`,
      );
    }
    let buf;
    try {
      buf = readFileSync(path);
    } catch {
      throw new Error(`images map entry "${name}": file not readable at the given path`);
    }
    const dims = buf[0] === 0x89 ? pngDimensions(buf) : jpegDimensions(buf);
    if (!dims) {
      throw new Error(`images map entry "${name}" is not a PNG or JPEG file`);
    }
    if (
      dims.width < IMAGE_MIN_DIM ||
      dims.height < IMAGE_MIN_DIM ||
      dims.width > IMAGE_MAX_DIM ||
      dims.height > IMAGE_MAX_DIM
    ) {
      throw new Error(
        `images map entry "${name}" is ${dims.width}x${dims.height}; images must be 256-1568 px per side`,
      );
    }
    out[sanitized] = buf.toString("base64");
  }
  return out;
}

// Pure builder: specs are validated upstream by validateQuestions.
function buildQuestion(spec, name) {
  if (spec.type === "choice") {
    return choice(spec.instructions, spec.criteria);
  }
  if (spec.type === "score") {
    return score(spec.instructions, spec.criteria);
  }
  return noul(spec.instructions, spec.criteria);
}

// Typesafe path (default): builds the SDK question objects from specs that
// judgeHandler already validated. Every provided image becomes an asset and
// triggers the danger-zone header. Any failure lands in the fallback envelope.
export async function typesafeJudge({ state, questions, images, timeout_ms, model }, ctx) {
  let qmap;
  try {
    qmap = Object.fromEntries(
      Object.entries(questions).map(([name, spec]) => [name, buildQuestion(spec, name)]),
    );
  } catch (err) {
    return fallbackFrom(err, "question construction failed");
  }
  const request = { state, questions: qmap, model: model ?? DEFAULT_MODEL };
  const imageNames = images && typeof images === "object" ? Object.keys(images) : [];
  if (imageNames.length > 0) {
    try {
      request.assets = Object.fromEntries(
        imageNames.map((name) => [name, Image.fromBase64(images[name])]),
      );
    } catch (err) {
      return fallbackFrom(err, "image decoding failed");
    }
  }
  // timeout_ms caps the WHOLE request (SDK retries included), not each
  // retry attempt: compose it with any caller signal via AbortSignal.any
  // (which tolerates zero or one signals). Single unconditional shape.
  const options = {
    signal: AbortSignal.any(
      [ctx?.signal, timeout_ms ? AbortSignal.timeout(timeout_ms) : undefined].filter(Boolean),
    ),
  };
  if (imageNames.length > 0) {
    // Required by the API for any request carrying image assets.
    options.headers = { "TypeSafe-Danger-Zone-Images": "true" };
  }
  try {
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
