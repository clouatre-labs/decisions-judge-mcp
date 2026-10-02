// Static, version-stamped decision-pattern prompt templates. Each prompt
// returns a ready-to-send judge tool-call skeleton the caller can fill in with
// application state. Prompts are pure text builders: no execution, no network
// calls at prompt-resolution time.
//
// Wording constraints enforced here (mirrors judge question-design guidance):
// - every question is predicate-positive (a yes affirms the trait);
// - one trait per question, no double-barreled questions;
// - no degree wording (e.g. "very", "somewhat") in noul questions.
//
// Each template carries a wording version stamp: bumping it invalidates
// earlier calibration runs that relied on the previous wording.

import { z } from "zod";

const WORDING_VERSION = "wording-v1";

// Shared skeleton shape: a single judge call with atomic questions and
// structured {summary, signals} criteria. `questions` is a plain object map
// keyed by question name, matching the judge tool's questions record schema.
function skeleton(state, questions) {
  return JSON.stringify(
    {
      tool: "judge",
      arguments: {
        state: state ?? "<state JSON goes here>",
        questions,
      },
    },
    null,
    2,
  );
}

const stateArg = {
  state: z
    .string()
    .optional()
    .describe(
      "Application state to judge, serialized as JSON. When omitted, the skeleton keeps a placeholder for the state and you must fill it in before sending. Questions judge only what state contains.",
    ),
};

const verifyClaimPrompt = {
  name: "verify-claim",
  title: "Verify a claim against state",
  description:
    "Build a judge call that checks a factual claim about the provided application state with atomic yes/no questions.",
  argsSchema: stateArg,
  build({ state }) {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Version: ${WORDING_VERSION}. Ready-to-send judge call skeleton that verifies a claim with atomic yes/no (noul) questions. Each question is predicate-positive and covers exactly one trait. Send the skeleton as-is, or replace the embedded state placeholder with your application state if you did not pass one:\n\n${skeleton(
              state,
              {
                claim_supported: {
                  type: "noul",
                  instructions:
                    "The provided state contains evidence that directly supports the claim under review. Does the evidence support the claim?",
                },
                claim_complete: {
                  type: "noul",
                  instructions:
                    "The provided state covers every aspect of the claim under review, with all required inputs present. Is the state complete for this claim?",
                },
              },
            )}`,
          },
        },
      ],
    };
  },
};

const classifyPrompt = {
  name: "classify",
  title: "Classify state into options",
  description:
    "Build a judge call that classifies the provided application state into one of several described options with balanced criteria.",
  argsSchema: stateArg,
  build({ state }) {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Version: ${WORDING_VERSION}. Ready-to-send judge call skeleton that classifies state into one option. Criteria describe each option by its intrinsic properties and trade-offs, never by position or endorsement. Send the skeleton as-is, or replace the embedded state placeholder with your application state if you did not pass one:\n\n${skeleton(
              state,
              {
                best_option: {
                  type: "choice",
                  instructions:
                    "Given the provided state, which option best fits the situation the state describes?",
                  criteria: {
                    option_a: {
                      summary: "First candidate option.",
                      signals: ["describes its intrinsic properties", "lists its genuine trade-offs"],
                    },
                    option_b: {
                      summary: "Second candidate option.",
                      signals: ["describes its intrinsic properties", "lists its genuine trade-offs"],
                    },
                    unclear: {
                      summary: "State lacks the inputs needed to choose between the candidates.",
                      signals: ["use when both candidates fit or neither fits"],
                    },
                  },
                },
              },
            )}`,
          },
        },
      ],
    };
  },
};

const routePrompt = {
  name: "route",
  title: "Route to the next decision",
  description:
    "Build a judge call that decides what the next decision should prepare for, with structured criteria per route.",
  argsSchema: stateArg,
  build({ state }) {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Version: ${WORDING_VERSION}. Ready-to-send judge call skeleton that routes to the next step. The question asks what the next decision should prepare for, one step ahead. Send the skeleton as-is, or replace the embedded state placeholder with your application state if you did not pass one:\n\n${skeleton(
              state,
              {
                next_route: {
                  type: "choice",
                  instructions:
                    "Given the provided state, which route should the next decision prepare for?",
                  criteria: {
                    proceed: {
                      summary: "Move forward with the current plan.",
                      signals: ["state shows the prerequisites for the next step are met"],
                    },
                    iterate: {
                      summary: "Stay on the current step and refine further.",
                      signals: ["state shows open work on the current step"],
                    },
                    escalate: {
                      summary: "Hand the decision back to a human with a state summary.",
                      signals: ["state shows inputs outside the agent's authority"],
                    },
                  },
                },
              },
            )}`,
          },
        },
      ],
    };
  },
};

// Registration order is also the documented order.
export const REGISTERED_PROMPTS = [verifyClaimPrompt, classifyPrompt, routePrompt];
