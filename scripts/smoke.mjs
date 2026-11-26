// Smoke test: start the MCP stdio server, perform the MCP initialize
// handshake, then exercise the prompts capability: prompts/list must list all
// three templates, prompts/get must return one user message with a
// version-stamped judge skeleton, and an unknown prompt name must return a
// JSON-RPC error. Exits 0 on success, non-zero on any failure or timeout.
// Does not require TYPESAFE_API_KEY.
import { startServer } from "./lib/stdio-client.mjs";

const PROMPT_NAMES = ["verify-claim", "classify", "route"];

let server;
function fail(msg) {
  console.error(`smoke: FAIL: ${msg}`);
  server?.child.kill("SIGKILL");
  process.exit(1);
}

try {
  server = await startServer();

  // Arrange: initialize handshake.
  const init = await server.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  const result = init.result;
  // 2025-11-25 is the MCP SDK's LATEST_PROTOCOL_VERSION (verified in
  // @modelcontextprotocol/sdk dist/esm/types.js); revisit on SDK upgrades.
  if (!result || !result.serverInfo || result.protocolVersion !== "2025-11-25") {
    fail(`initialize result missing serverInfo or wrong protocolVersion (expected 2025-11-25): ${JSON.stringify(init).slice(0, 300)}`);
  }
  if (result.serverInfo.name !== "decisions-judge-mcp") {
    fail(`unexpected server name: ${result.serverInfo.name}`);
  }
  console.log(`smoke: initialize OK (server ${result.serverInfo.name}@${result.serverInfo.version}, protocol ${result.protocolVersion})`);

  // Act: list prompts.
  const list = await server.request("prompts/list", {});
  const names = (list.result?.prompts ?? []).map((p) => p.name).sort();
  for (const expected of PROMPT_NAMES) {
    if (!names.includes(expected)) {
      fail(`prompts/list missing "${expected}": got ${JSON.stringify(names)}`);
    }
  }
  console.log(`smoke: prompts/list OK (${names.join(", ")})`);

  // Act: render verify-claim.
  const got = await server.request("prompts/get", {
    name: "verify-claim",
    arguments: { state: "{}" },
  });
  const messages = got.result?.messages;
  if (!Array.isArray(messages) || messages.length !== 1) {
    fail(`prompts/get verify-claim expected exactly one message: ${JSON.stringify(got).slice(0, 300)}`);
  }
  const m = messages[0];
  if (m.role !== "user" || m.content?.type !== "text" || typeof m.content.text !== "string") {
    fail(`prompts/get verify-claim wrong message shape: ${JSON.stringify(m).slice(0, 300)}`);
  }
  if (!m.content.text.includes("wording-v1")) {
    fail(`prompts/get verify-claim text missing wording-v1 stamp: ${m.content.text.slice(0, 200)}`);
  }
  if (!m.content.text.includes("judge")) {
    fail(`prompts/get verify-claim text missing judge skeleton: ${m.content.text.slice(0, 200)}`);
  }
  if (!m.content.text.includes('"type": "noul"') && !m.content.text.includes('"type":"noul"')) {
    fail(`prompts/get verify-claim text missing noul question type: ${m.content.text.slice(0, 300)}`);
  }
  if (!m.content.text.includes("claim_supported")) {
    fail(`prompts/get verify-claim text missing claim_supported question key: ${m.content.text.slice(0, 300)}`);
  }
  // The embedded skeleton must parse as JSON whose questions field is an
  // object map (matching the judge tool's questions record schema), not
  // an array of single-key objects.
  const skeletonText = m.content.text.split("\n\n").pop();
  let parsed;
  try {
    parsed = JSON.parse(skeletonText);
  } catch (err) {
    fail(`prompts/get verify-claim skeleton is not parseable JSON: ${err.message}`);
  }
  if (
    typeof parsed?.arguments?.questions !== "object" ||
    parsed.arguments.questions === null ||
    Array.isArray(parsed.arguments.questions) ||
    !("claim_supported" in parsed.arguments.questions)
  ) {
    fail(`prompts/get verify-claim questions must be an object map with claim_supported: ${skeletonText.slice(0, 200)}`);
  }
  console.log("smoke: prompts/get verify-claim OK (user text message, wording-v1, questions rendered as object map)");

  // Act: render classify. Same shape contract as verify-claim; the question
  // map must contain the choice question with its criteria as an object.
  const classify = await server.request("prompts/get", {
    name: "classify",
    arguments: { state: "{}" },
  });
  const classifyMessages = classify.result?.messages;
  if (!Array.isArray(classifyMessages) || classifyMessages.length !== 1) {
    fail(`prompts/get classify expected exactly one message: ${JSON.stringify(classify).slice(0, 300)}`);
  }
  const classifyMessage = classifyMessages[0];
  if (classifyMessage.role !== "user" || classifyMessage.content?.type !== "text" || typeof classifyMessage.content.text !== "string") {
    fail(`prompts/get classify wrong message shape: ${JSON.stringify(classifyMessage).slice(0, 300)}`);
  }
  if (!classifyMessage.content.text.includes("wording-v1")) {
    fail(`prompts/get classify text missing wording-v1 stamp: ${classifyMessage.content.text.slice(0, 200)}`);
  }
  const classifySkeletonText = classifyMessage.content.text.split("\n\n").pop();
  let classifySkeleton;
  try {
    classifySkeleton = JSON.parse(classifySkeletonText);
  } catch (err) {
    fail(`prompts/get classify skeleton is not parseable JSON: ${err.message}`);
  }
  const classifyQuestions = classifySkeleton?.arguments?.questions;
  if (typeof classifyQuestions !== "object" || classifyQuestions === null || Array.isArray(classifyQuestions) || Object.keys(classifyQuestions).length === 0) {
    fail(`prompts/get classify questions must be a non-empty object map: ${classifySkeletonText.slice(0, 200)}`);
  }
  if (typeof classifyQuestions.best_option?.criteria !== "object" || Array.isArray(classifyQuestions.best_option.criteria)) {
    fail(`prompts/get classify expected best_option criteria rendered as an object: ${classifySkeletonText.slice(0, 300)}`);
  }
  console.log("smoke: prompts/get classify OK (user text message, wording-v1, questions rendered as object map)");

  // Act: render route. Same shape contract; the question map must contain the
  // next_route choice question with criteria rendered as an object.
  const route = await server.request("prompts/get", {
    name: "route",
    arguments: { state: "{}" },
  });
  const routeMessages = route.result?.messages;
  if (!Array.isArray(routeMessages) || routeMessages.length !== 1) {
    fail(`prompts/get route expected exactly one message: ${JSON.stringify(route).slice(0, 300)}`);
  }
  const routeMessage = routeMessages[0];
  if (routeMessage.role !== "user" || routeMessage.content?.type !== "text" || typeof routeMessage.content.text !== "string") {
    fail(`prompts/get route wrong message shape: ${JSON.stringify(routeMessage).slice(0, 300)}`);
  }
  if (!routeMessage.content.text.includes("wording-v1")) {
    fail(`prompts/get route text missing wording-v1 stamp: ${routeMessage.content.text.slice(0, 200)}`);
  }
  const routeSkeletonText = routeMessage.content.text.split("\n\n").pop();
  let routeSkeleton;
  try {
    routeSkeleton = JSON.parse(routeSkeletonText);
  } catch (err) {
    fail(`prompts/get route skeleton is not parseable JSON: ${err.message}`);
  }
  const routeQuestions = routeSkeleton?.arguments?.questions;
  if (typeof routeQuestions !== "object" || routeQuestions === null || Array.isArray(routeQuestions) || Object.keys(routeQuestions).length === 0) {
    fail(`prompts/get route questions must be a non-empty object map: ${routeSkeletonText.slice(0, 200)}`);
  }
  if (typeof routeQuestions.next_route?.criteria !== "object" || Array.isArray(routeQuestions.next_route.criteria)) {
    fail(`prompts/get route expected next_route criteria rendered as an object: ${routeSkeletonText.slice(0, 300)}`);
  }
  console.log("smoke: prompts/get route OK (user text message, wording-v1, questions rendered as object map)");

  // Act: an unknown prompt name must return a JSON-RPC error.
  const unknown = await server.request("prompts/get", { name: "no-such-prompt", arguments: {} });
  if (!unknown.error || typeof unknown.error.code !== "number") {
    fail(`prompts/get unknown name expected a JSON-RPC error: ${JSON.stringify(unknown).slice(0, 300)}`);
  }
  console.log(`smoke: prompts/get unknown OK (JSON-RPC error ${unknown.error.code})`);

  // Assert: graceful shutdown; exit 0 only once the server exited 0.
  const exitCode = await server.close();
  if (exitCode !== 0) fail(`server exited with code ${exitCode}`);
  process.exit(0);
} catch (err) {
  fail(err.message);
}
