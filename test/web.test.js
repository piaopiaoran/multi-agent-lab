import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 与 graph.test.js 一致：先钉死零成本档，测试全程不联网、不上报 trace。
process.env.LANGSMITH_TRACING = "false";
process.env.LLM_PROVIDER = "fake";
process.env.EMBEDDINGS_PROVIDER = "fake";
process.env.STORAGE_BACKEND = "memory";
process.env.CHECKPOINTER = "memory";

const { createWebServer } = await import("../src/web/server.js");

let server;
let baseURL;

before(async () => {
  server = createWebServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** 手工解析 SSE：按空行分包，取 data: 行。 */
async function collectEvents(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const packet = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLine = packet.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
    }
  }
  return events;
}

test("Web：/api/config 返回脱敏配置，且不含任何真实密钥", async () => {
  const response = await fetch(`${baseURL}/api/config`);
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.ok(config.defaultQuestion.length > 10);
  assert.ok(config.summary.includes("LLM"));
  assert.ok(config.llm.provider === "fake" || config.llm.provider === "openai");

  const envContent = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const secrets = envContent
    .split("\n")
    .filter((line) => /^[A-Z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD)=/i.test(line.trim()))
    .map((line) => line.slice(line.indexOf("=") + 1).trim())
    .filter((value) => value.length >= 8);
  const serialized = JSON.stringify(config);
  for (const secret of secrets) assert.ok(!serialized.includes(secret));
});

test("Web：静态资源白名单生效，未知路径返回 404", async () => {
  for (const [pathname, needle] of [
    ["/", "Supervisor Console"],
    ["/app.js", "EventSource"],
    ["/style.css", "--accent"],
  ]) {
    const response = await fetch(`${baseURL}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.ok((await response.text()).includes(needle), pathname);
  }
  assert.equal((await fetch(`${baseURL}/../.env`)).status, 404);
});

test("Web：POST /api/run + SSE 回放完整 fake 链路事件", async () => {
  const started = await fetch(`${baseURL}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "对比 Supervisor 与 Swarm 的取舍",
      provider: "fake",
      trace: false,
    }),
  });
  assert.equal(started.status, 200);
  const { runId } = await started.json();
  assert.match(runId, /^[0-9a-f-]{36}$/);

  const events = await collectEvents(`${baseURL}/api/events/${runId}`);
  const types = new Set(events.map((event) => event.type));
  for (const type of ["meta", "route", "tool", "worker", "final", "done"]) {
    assert.ok(types.has(type), `缺少事件类型 ${type}`);
  }

  const routes = events.filter((event) => event.type === "route").map((event) => event.next);
  assert.deepEqual(routes.slice(0, 3), ["researcher", "analyst", "writer"]);
  assert.equal(routes.at(-1), "FINISH");

  const tools = events.filter((event) => event.type === "tool" && event.phase === "start");
  assert.ok(tools.some((event) => event.tool === "retrieve_knowledge"));
  assert.ok(tools.every((event) => event.seq > 0 && event.at > 0));

  const final = events.find((event) => event.type === "final");
  assert.equal(final.rounds, 4);
  assert.deepEqual(final.visited, ["researcher", "analyst", "writer"]);
  assert.ok(final.finalAnswer.length > 20);
  assert.ok(events.at(-1).type === "done");
});
