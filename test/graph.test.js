import test from "node:test";
import assert from "node:assert/strict";

// 集成测试强制离线：mock 模型 + 内存 checkpointer + 内存向量库，零外部依赖
process.env.AGENT_MODE = "mock";
process.env.DATABASE_URL = "";

const { HumanMessage } = await import("@langchain/core/messages");
const { createApp, invokeGraph } = await import("../src/graphs/factory.js");
const { addDocuments, similaritySearch } = await import("../src/memory/vector-store.js");
const { SEED_DOCUMENTS } = await import("../src/data/knowledge.js");
const { closePool } = await import("../src/memory/pg-pool.js");

const QUESTION = "Supervisor 与 Swarm 拓扑如何取舍？";
const input = () => ({ messages: [new HumanMessage({ content: QUESTION })], namespace: "test" });

test("启动前置：知识库灌入后能语义召回", async () => {
  await addDocuments(SEED_DOCUMENTS);
  const hits = await similaritySearch("Swarm handoff Command", { k: 2 });
  assert.ok(hits.length > 0);
  assert.ok(typeof hits[0].score === "number");
});

for (const graphName of ["supervisor", "swarm", "parallel"]) {
  test(`拓扑 ${graphName}：完整跑通三个 Agent 并产出 writer 答复`, async () => {
    const app = await createApp();
    const result = await invokeGraph(app, graphName, input(), {
      threadId: `test-${graphName}`, namespace: "test",
    });

    assert.deepEqual([...result.completedAgents].sort(), ["analyst", "researcher", "writer"]);
    const writer = result.messages.find((m) => m.name === "writer");
    assert.ok(writer, "应存在 writer 署名的消息（supervisor 靠它判断进度）");
    assert.match(writer.content, /【最终答复】/);
    assert.ok(result.messages.length >= 4, "用户消息 + 三个 worker 产出");
  });
}

test("checkpointer：同一 thread_id 的第二轮能读到上一轮状态", async () => {
  const app = await createApp();
  const options = { threadId: "test-resume", namespace: "test" };
  await invokeGraph(app, "supervisor", input(), options);
  const snapshot = await app.graphs.supervisor.getState({ configurable: { thread_id: options.threadId } });
  assert.ok(snapshot.values, "checkpoint 应存在");
  assert.ok(snapshot.values.messages.length >= 4);
  assert.deepEqual([...snapshot.values.completedAgents].sort(), ["analyst", "researcher", "writer"]);
});

test.after(async () => { await closePool(); });
