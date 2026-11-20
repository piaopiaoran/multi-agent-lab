import { config, describeRuntime, makeLogger } from "../config.js";
import { createApp, invokeGraph, GRAPH_NAMES, GRAPH_META } from "../graphs/factory.js";
import { addDocuments, similaritySearch } from "../memory/vector-store.js";
import { remember } from "../memory/long-term.js";
import { getEvents } from "../memory/observability.js";
import { closePool } from "../memory/pg-pool.js";
import { SEED_DOCUMENTS } from "../data/knowledge.js";
import { HumanMessage } from "@langchain/core/messages";

const log = makeLogger("demo");
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : "true"];
  }),
);

const QUESTION = argv.question ?? "多 Agent 系统里，Supervisor 和 Swarm 两种拓扑该怎么选？请结合状态持久化与长期记忆说明。";
const NAMESPACE = "interview:demo";

async function ensureKnowledge() {
  const probe = await similaritySearch("Supervisor Swarm 拓扑", { k: 1 });
  if (probe.length > 0) return;
  // 离线降级模式下内存库是空的，自动灌一批示例文档，保证 RAG 链路真实命中
  log.info("知识库为空，自动灌入示例文档");
  await addDocuments(SEED_DOCUMENTS);
}

async function run(graphName, { threadId }) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`拓扑: ${GRAPH_META[graphName].label} (${graphName})`);
  console.log(`控制: ${GRAPH_META[graphName].control} | 开销: ${GRAPH_META[graphName].callsPerTask}`);
  console.log("=".repeat(78));

  const app = await createApp();
  const started = Date.now();
  const result = await invokeGraph(
    app,
    graphName,
    { messages: [new HumanMessage({ content: QUESTION })], namespace: NAMESPACE },
    { threadId, namespace: NAMESPACE },
  );
  const elapsed = Date.now() - started;

  console.log("\n--- 节点执行轨迹 ---");
  for (const e of getEvents(threadId).filter((x) => x.graph === graphName)) {
    console.log(`  ${e.node.padEnd(12)} ${e.event.padEnd(8)}`, e.event === "route" || e.event === "handoff" ? e.payload : "");
  }

  console.log("\n--- 最终 State ---");
  console.log({
    completedAgents: result.completedAgents,
    iteration: result.iteration,
    next: result.next,
    messageCount: result.messages.length,
    messages: result.messages.map((m) => ({ role: m._getType?.() ?? m.type, name: m.name ?? "-" })),
  });

  const finalMsg = [...result.messages].reverse().find((m) => m.name === "writer");
  console.log("\n--- 最终答复 ---");
  console.log(finalMsg?.content ?? result.messages.at(-1)?.content ?? "(无输出)");
  console.log(`\n耗时 ${elapsed}ms`);
  return result;
}

console.log("运行配置：", describeRuntime());
await ensureKnowledge();
// 演示 L3 长期记忆：写入一条偏好，researcher 入口会做语义召回并注入 prompt
await remember(NAMESPACE, "用户偏好：讲解架构时要给出取舍对比和适用边界，不要只列概念。", { kind: "preference" });

if (argv.all === "true") {
  for (const name of GRAPH_NAMES) await run(name, { threadId: `demo-${name}` });
  console.log("\n--- 三种拓扑对比 ---");
  console.table(Object.values(GRAPH_META).map(({ label, callsPerTask, strength, weakness }) => ({
    拓扑: label, 开销: callsPerTask, 优势: strength, 代价: weakness,
  })));
} else {
  const name = GRAPH_NAMES.includes(argv.graph) ? argv.graph : config.defaultGraph;
  await run(name, { threadId: argv.thread ?? `demo-${name}` });
}

console.log("\n面试提示：试着回答 —— ① messages 为什么需要 reducer？② checkpointer 和 pgvector 各管哪层记忆？");
console.log("           ③ Agent 死循环靠什么兜底？④ 子图轨迹要不要回传主图？⑤ 什么情况下该换拓扑？");
await closePool();
