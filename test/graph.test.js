import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 必须在动态 import 业务模块之前钉死环境变量：
// dotenv 默认不覆盖已存在的 process.env，测试因此永远走零成本档，且不会上报 trace。
process.env.LANGSMITH_TRACING = "false";
process.env.LLM_PROVIDER = "fake";
process.env.EMBEDDINGS_PROVIDER = "fake";
process.env.STORAGE_BACKEND = "memory";
process.env.CHECKPOINTER = "memory";

const { loadConfig, describeConfig } = await import("../src/config/env.js");
const { deterministicVector } = await import("../src/llm/embeddings.js");
const { createLLM } = await import("../src/llm/factory.js");
const { createEmbeddings } = await import("../src/llm/embeddings.js");
const { createVectorStore } = await import("../src/memory/vectorStore.js");
const { createTools } = await import("../src/agents/tools.js");
const { buildGraph } = await import("../src/graph/buildGraph.js");
const { runSession } = await import("../src/run.js");
const { HumanMessage } = await import("@langchain/core/messages");
const { MemorySaver } = await import("@langchain/langgraph");

function testConfig() {
  return loadConfig({
    provider: "fake",
    storage: "memory",
    checkpointer: "memory",
  });
}

test("配置加载为 fake/memory 档且摘要不含完整密钥", () => {
  const cfg = testConfig();
  assert.equal(cfg.llm.provider, "fake");
  assert.equal(cfg.storage.backend, "memory");
  assert.equal(cfg.storage.checkpointer, "memory");
  assert.equal(cfg.langsmith.enabled, false);
  const summary = describeConfig(cfg);
  assert.ok(!summary.includes("sk-8a53"));
  assert.ok(!summary.includes("lsv2_pt_406"));
});

test("确定性向量：维度固定、L2 归一化、同输入同输出", () => {
  const a = deterministicVector("Supervisor 条件边 Checkpointer", 128);
  const b = deterministicVector("Supervisor 条件边 Checkpointer", 128);
  assert.equal(a.length, 128);
  assert.deepEqual(a, b);
  const norm = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test("内存向量库检索：返回 topK 且分数降序", async () => {
  const cfg = testConfig();
  const { store } = await createVectorStore(cfg, createEmbeddings(cfg));
  const hits = await store.similaritySearchWithScore("LangGraph 条件边和 Checkpointer", 3);
  assert.equal(hits.length, 3);
  assert.ok(hits[0][1] >= hits[1][1] && hits[1][1] >= hits[2][1]);
  assert.ok(typeof hits[0][0].pageContent === "string");
  await store.close();
});

test("工具：calculate 白名单生效、知识检索返回片段", async () => {
  const cfg = testConfig();
  const { store } = await createVectorStore(cfg, createEmbeddings(cfg));
  const tools = createTools(store);
  assert.match(await tools.calculate.invoke({ expression: "(12 + 8) * 3 / 4" }), /= 15/);
  assert.match(await tools.calculate.invoke({ expression: "process.exit(1)" }), /错误/);
  const knowledge = await tools.retrieve_knowledge.invoke({ query: "pgvector 索引", topK: 2 });
  assert.match(knowledge, /score=/);
  await store.close();
});

test("完整链路：Supervisor 依次调度三个 Worker 并收敛到 FINISH", async () => {
  const result = await runSession({
    cfg: testConfig(),
    question: "对比 Supervisor 与 Swarm 的取舍，并给出面试要点",
    threadId: "test-full-graph",
  });
  assert.deepEqual(result.visited, ["researcher", "analyst", "writer"]);
  assert.equal(result.rounds, 4); // 3 次路由 + 1 次 FINISH
  assert.ok(result.finalAnswer.length > 20);
  assert.ok(result.trace.length >= 4);
  assert.ok(result.messages.some((m) => m?.name === "writer"));
  assert.equal(result.backends.vector, "memory");
  assert.equal(result.backends.checkpointer, "memory");
});

test("Checkpointer：按 thread_id 保存图状态快照", async () => {
  const cfg = testConfig();
  const { store } = await createVectorStore(cfg, createEmbeddings(cfg));
  const saver = new MemorySaver();
  const app = buildGraph({
    cfg,
    llm: createLLM(cfg),
    tools: createTools(store),
    checkpointer: saver,
  });
  const config = { configurable: { thread_id: "test-checkpoint" }, recursionLimit: 40 };
  await app.invoke({ messages: [new HumanMessage("路由链路测试")] }, config);
  const snapshot = await app.getState(config);
  assert.ok(snapshot.values.visited.includes("writer"));
  assert.equal(snapshot.values.next, "FINISH");
  assert.ok(snapshot.values.rounds > 0);
  await store.close();
});

test("护栏：MAX_ROUNDS=1 时图仍能终止", async () => {
  const cfg = testConfig();
  cfg.graph.maxRounds = 1;
  const result = await runSession({ cfg, question: "快速终止测试", threadId: "test-guardrail" });
  assert.ok(result.rounds <= 2);
  assert.ok(Array.isArray(result.trace));
});

test("安全：源码与 .env.example 不含 .env 里的任何真实密钥", () => {
  // 密钥只从 .env 动态读取，测试源码里绝不出现密钥字面量
  // （否则「检查泄漏」的代码本身就成了泄漏源）。
  const envContent = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const secrets = envContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD)=/i.test(line))
    .map((line) => line.slice(line.indexOf("=") + 1).trim())
    .filter((value) => value.length >= 8 && !value.includes("xxxx"));
  assert.ok(secrets.length >= 1, "应至少读到一个真实密钥用于扫描");

  const files = [
    ".env.example",
    "package.json",
    "docker-compose.yml",
    "src/config/env.js",
    "src/cli.js",
    "src/run.js",
    "src/llm/factory.js",
    "scripts/selfcheck.js",
    "test/graph.test.js",
  ];
  for (const relative of files) {
    const content = fs.readFileSync(path.join(ROOT, relative), "utf8");
    for (const secret of secrets) {
      assert.ok(!content.includes(secret), `${relative} 含真实密钥`);
    }
  }
});
