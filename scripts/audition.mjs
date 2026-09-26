// Live audition for the typesafe-api judge path. Sends a fixed question set
// (one per typed question) to the TypeSafe System One API and prints each
// answer with a probability breakdown. Skips cleanly (exit 0) when no key is
// configured. Requires network access; not part of offline smoke tests.
//
// Usage: node scripts/audition.mjs
import { parseKeys, typesafeJudge } from "../providers/typesafe-api.mjs";

const QUESTIONS = {
  is_release_ready: {
    type: "noul",
    instructions: "Given the project state, is it ready to release?",
  },
  next_action: {
    type: "choice",
    instructions: "What should the team do next?",
    criteria: {
      ship: "release as-is",
      fix: "address open defects first",
      hold: "wait for more signal",
    },
  },
  confidence: {
    type: "score",
    instructions: "How confident are you in overall quality?",
    criteria: ["no confidence", "low confidence", "moderate confidence", "high confidence"],
  },
};

const STATE = {
  open_defects: 0,
  tests: "passing",
  lint: "clean",
  coverage: 0.87,
  review_approvals: 2,
};

const keys = parseKeys();
if (keys.length === 0) {
  console.log("audition: skipped (no TYPESAFE_API_KEY configured)");
  process.exit(0);
}

console.log(`audition: ${keys.length} key(s) configured`);
const out = await typesafeJudge({ state: STATE, questions: QUESTIONS, timeout_ms: 30000 });
if (out.fallback) {
  console.error(`audition: FAIL: ${out.error}`);
  process.exit(1);
}
for (const [name, answer] of Object.entries(out.answers)) {
  const probs = answer?.probabilities ?? answer?.choice ?? answer?.noul ?? answer?.score;
  console.log(`${name}: ${JSON.stringify(probs)}`);
}
console.log(`model: ${out.model}`);
console.log("audition: OK");
