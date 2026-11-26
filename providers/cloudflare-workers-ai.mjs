// Opt-in Cloudflare Workers AI provider for the judge tool.
//
// Explicit selection only: never inferred from which env vars happen to be
// set. Minimal retry policy: only 429 and transport errors are retried; auth
// (401/403) and other 4xx fail fast. Abort-aware via an AbortController
// combining timeout_ms and the caller's signal.
//
// Clef contract (issue #160): POST /client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef
// with a flat body {model, state, questions}, where `model` is the input
// selector ("clef" or "clef-flash"). The response is unwrapped from
// result.{answers, model, usage}. Clef is a rolling alias with no version pin.
//
// Any surfaced error string is scrubbed of the token and account id values
// before reaching the caller.

const CF_RETRY_LIMIT = 2;
const CF_BACKOFF_MS = 500;

// Default model; bare clef and clef-flash overrides are prefixed with
// @cf/cloudflare/ so the Workers AI run endpoint accepts them.
export const CF_DEFAULT_MODEL = "@cf/cloudflare/clef";
export function normalizeCfModel(model) {
  if (!model) return CF_DEFAULT_MODEL;
  return /^clef(-flash)?$/.test(model) ? `@cf/cloudflare/${model}` : model;
}

// Body selector for a Clef model id; undefined for anything else, in which
// case the request carries no `model` key.
export function cfModelSelector(model) {
  if (model === "@cf/cloudflare/clef") return "clef";
  if (model === "@cf/cloudflare/clef-flash") return "clef-flash";
  return undefined;
}

// Cloudflare account ids are 32 hex chars; reject anything else (empty,
// whitespace, path-unsafe characters) before URL interpolation.
const CF_ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

// Escape a literal for embedded use in a RegExp.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace any occurrence of the token or account id values in an error string
// with [redacted] so secrets never surface in fallback envelopes.
function redactSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      out = out.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]");
    }
  }
  return out;
}

// Total: never throws, whatever shape `body` takes. Any malformed errors[]
// (non-array, non-object items, non-string message, missing message) degrades
// to a best-effort string or null so the HTTP-status error mapping always has
// a usable fallback.
function cfErrorEnvelopeMessage(body, redact) {
  try {
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const messages = body.errors
        .map((e) => {
          const raw = e && typeof e === "object" && e.message != null ? String(e.message) : String(e);
          return redact(raw);
        })
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
  } catch {
    // Intentionally swallowed: the caller falls back to the HTTP status and
    // generic text.
  }
  return null;
}

// A usable answers payload is a plain (non-null, non-array) object; arrays and
// other exotic objects fail the check and fall into the fallback envelope.
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

export async function cloudflareJudge({ state, questions, images, model, timeout_ms, signal }) {
  // Fail closed on images: image-backed questions are typesafe-api-only (see
  // issue #142). The
  // check runs before any fetch so no image bytes are ever sent.
  const imageNames = images && typeof images === "object" ? Object.keys(images) : [];
  if (imageNames.length > 0) {
    throw new Error(
      "images are not supported by the cloudflare-workers-ai provider; use the typesafe-api provider for image-backed questions",
    );
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) {
    throw new Error("cloudflare provider requires CLOUDFLARE_API_TOKEN in the environment");
  }
  if (!accountId) {
    throw new Error("cloudflare provider requires CLOUDFLARE_ACCOUNT_ID in the environment");
  }
  if (!CF_ACCOUNT_ID_RE.test(accountId)) {
    throw new Error("cloudflare provider requires CLOUDFLARE_ACCOUNT_ID to be a 32-character hex account id");
  }

  const redact = (text) => redactSecrets(text, [token, accountId]);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeout_ms
    ? setTimeout(() => controller.abort(), timeout_ms)
    : undefined;
  try {
    if (controller.signal.aborted) throw new Error("request aborted");
    const runModel = normalizeCfModel(model);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${runModel}`;
    const selector = cfModelSelector(runModel);
    const body = JSON.stringify({
      ...(selector ? { model: selector } : {}),
      state,
      questions,
    });
    let lastErr = null;
    for (let attempt = 0; attempt <= CF_RETRY_LIMIT; attempt++) {
      if (attempt > 0) {
        let t;
        let rejectAbort;
        const onBackoffAbort = () => {
          clearTimeout(t);
          rejectAbort?.(new Error("request aborted"));
        };
        try {
          await new Promise((resolve, reject) => {
            rejectAbort = reject;
            t = setTimeout(resolve, CF_BACKOFF_MS * attempt);
            controller.signal.addEventListener("abort", onBackoffAbort, { once: true });
          });
        } finally {
          controller.signal.removeEventListener("abort", onBackoffAbort);
        }
        if (controller.signal.aborted) throw new Error("request aborted");
      }
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw err;
        lastErr = err;
        continue;
      }
      if (res.status === 429 && attempt < CF_RETRY_LIMIT) {
        // Consume/cancel the 429 body before backing off.
        try {
          await res.arrayBuffer();
        } catch {
          res.body?.cancel().catch(() => {});
        }
        lastErr = new Error("cloudflare rate limited");
        lastErr.status = res.status;
        continue;
      }
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        const err = new Error(cfErrorEnvelopeMessage(parsed, redact) ?? "cloudflare request failed");
        err.status = res.status;
        throw err;
      }
      // Defensive unwrap of Cloudflare's REST envelope (result.{answers,
      // model, usage}); unexpected shapes are errors, never crashes.
      const result = parsed && typeof parsed === "object" ? parsed.result : undefined;
      if (parsed?.success !== true || !isPlainObject(result) || !isPlainObject(result.answers)) {
        const err = new Error(
          cfErrorEnvelopeMessage(parsed, redact) ??
            "cloudflare returned an unexpected response envelope",
        );
        err.status = res.status;
        throw err;
      }
      return {
        answers: result.answers,
        model: result.model ?? runModel,
        usage: result.usage,
        fallback: false,
      };
    }
    throw lastErr ?? new Error("cloudflare request failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
