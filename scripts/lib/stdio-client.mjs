// Minimal MCP stdio test client. Spawns server.mjs as a child process with
// newline-delimited JSON-RPC framing, resolves one request() promise per
// pending id, and offers a graceful close() that ends stdin (the server exits
// when stdin ends, flushing V8 coverage) and resolves with the exit code.
// The helper never exits the process or writes to stderr: it throws, and the
// caller decides how to report.
import { spawn } from "node:child_process";

export async function startServer({
  env = process.env,
  args = ["server.mjs"],
  timeoutMs = 10_000,
} = {}) {
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const pending = new Map();
  let nextId = 1;
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => {
      const exitCode = code ?? null;
      for (const { reject, method } of pending.values()) {
        reject(new Error(`server exited with code ${exitCode} while awaiting ${method}`));
      }
      pending.clear();
      resolve(exitCode);
    });
  });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    // MCP stdio framing: newline-delimited JSON messages.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        const err = new Error(`non-JSON output on stdout: ${line.slice(0, 200)}`);
        for (const { reject } of pending.values()) reject(err);
        pending.clear();
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    }
  });

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no ${method} response within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function close() {
    child.stdin.end();
    return exited;
  }

  return { request, notify, child, close };
}
