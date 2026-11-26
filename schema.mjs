// Judge question schema, shared with aptu.dev (/v1/judge and /mcp)
// through the "decisions-judge-mcp/schema" subpath. server.mjs imports it;
// the zod specs and their caller-visible fix hints live here only.

import { z } from "zod";

// EntryType: SDK accepts a string or arbitrary JSON structure.
export const entryType = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

// Field descriptions follow TypeSafe question-design guidance so calling
// models learn question construction from the schema itself.
export const questionSpec = z
  .strictObject(
    {
    // type is schema-optional; the superRefine below rejects a missing type
    // with a caller-visible fix hint instead of a bare zod "required" error.
    type: z
      .enum(["noul", "choice", "score"])
      .optional()
      .describe(
        "noul = yes/no probability; choice = pick an option; score = ordered rating.",
      ),
    instructions: entryType
      .nullable()
      .optional()
      .describe(
        "Narrow, self-contained, predicate-positive question text; one trait per question.",
      ),
    // noul: {true, false} descriptions (optional). choice: {option: description|null}.
    // score: [level descriptions] (>= 2).
    criteria: z
      .union([
        z.record(
          z.string(),
          z.union([
            z.string().min(1),
            z.record(z.string(), z.unknown()),
            z.array(z.unknown()),
            z.null(),
          ]),
        ),
        z
          .array(z.unknown())
          .min(2),
      ])
      .optional()
      .describe(
        "choice: {option: description|null}; score: ordered level descriptions (2-10); omit for noul.",
      ),
    },
    // Unknown keys (e.g. a "choice": true shorthand) must reject, not be
    // stripped -- with a caller-visible fix hint naming the offending field.
    {
      error: (iss) => {
        const key = iss.keys?.[0] ?? iss.path?.at(-1);
        if (key === "choice" || key === "choices") {
          return `use "criteria", not "${key}"`;
        }
        return `unrecognized field "${key}"; use "type", "instructions", "criteria"`;
      },
    },
  )
  .superRefine((spec, ctx) => {
    // Zod-strict-layer fix hint for a missing type: names the expected shape
    // and fix instead of a bare "required" error.
    if (spec.type === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: 'missing "type" (noul|choice|score)',
      });
    }
    // API limit: choice questions accept at most 255 options.
    if (
      spec.type === "choice" &&
      spec.criteria &&
      !Array.isArray(spec.criteria) &&
      Object.keys(spec.criteria).length > 255
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message:
          "choice criteria supports at most 255 options; reduce options or split into multiple choice questions",
      });
    }
    // API limit: score questions accept at most 10 levels (kept out of the
    // zod .max() so the union still parses and this hint names the limit).
    if (Array.isArray(spec.criteria) && spec.criteria.length > 10) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message:
          "score criteria supports at most 10 levels; reduce levels or split into multiple score questions",
      });
    }
  });

// Questions map with pre-parse fix hints: an array (or other non-map) reaches
// the caller as a named hint rather than a bare zod "expected object" error.
export const questionsSchema = z
  .union([z.record(z.string().min(1), questionSpec), z.array(z.unknown()), z.null()])
  .superRefine((qs, ctx) => {
    if (Array.isArray(qs)) {
      ctx.addIssue({
        code: "custom",
        message: 'expected a map of named question specs, got an array; use {name: {type: "noul", instructions: "..."}}',
      });
      return;
    }
    if (qs === null || qs === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'expected a map of named question specs; use {name: {type: "noul", instructions: "..."}}',
      });
    }
  });
