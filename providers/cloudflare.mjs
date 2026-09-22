// Opt-in Cloudflare Workers AI provider for the judge tool.
//
// Explicit selection only: never inferred from which env vars happen to be
// set. Minimal retry policy: only 429 and transport errors are retried; auth
// (401/403) and other 4xx (including 402 AI Gateway prepaid-credit errors)
// fail fast. Abort-aware via an AbortController combining timeout_ms and the
// caller's signal.
//
// Any surfaced error string is scrubbed of the token and account id values
// before reaching the caller.

const CF_RETRY_LIMIT = 2;
const CF_BACKOFF_MS = 500;

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

function cfErrorEnvelopeMessage(body, redact) {
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const messages = body.errors
      .map((e) =>
        e && typeof e === "object" && e.message ? redact(e.message) : redact(String(e)),
      )
      .filter(Boolean);
    if (messages.length > 0) return messages.join("; ");
  }
  return null;
}

// A usable answers payload is a plain (non-null, non-array) object; arrays and
// other exotic objects fail the check and fall into the fallback envelope.
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

export async function cloudflareJudge({ state, questions, model, timeout_ms, signal }) {
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
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
    const body = JSON.stringify({
      model: model ?? "typesafe/jev",
      input: { state, questions },
    });
    let lastErr = null;
    for (let attempt = 0; attempt <= CF_RETRY_LIMIT; attempt++) {
      if (attempt > 0) {
        if (controller.signal.aborted) throw new Error("request aborted");
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, CF_BACKOFF_MS * attempt);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("request aborted"));
            },
            { once: true },
          );
        });
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
      // Defensive unwrap of Cloudflare's REST envelope; unexpected shapes are
      // errors, never crashes.
      const outer = parsed && typeof parsed === "object" ? parsed.result : undefined;
      const evaluation = outer && typeof outer === "object" ? outer.result : undefined;
      if (
        parsed?.success !== true ||
        !isPlainObject(outer) ||
        outer.state !== "Completed" ||
        !isPlainObject(evaluation) ||
        !isPlainObject(evaluation.answers)
      ) {
        const err = new Error(
          cfErrorEnvelopeMessage(parsed, redact) ??
            "cloudflare returned an unexpected response envelope",
        );
        err.status = res.status;
        throw err;
      }
      return {
        answers: evaluation.answers,
        model: evaluation.model ?? model ?? "typesafe/jev",
        usage: evaluation.usage,
        fallback: false,
      };
    }
    throw lastErr ?? new Error("cloudflare request failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
