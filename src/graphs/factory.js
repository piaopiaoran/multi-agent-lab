import { createCheckpointer } from "../memory/checkpointer.js";
import { config, makeLogger } from "../config.js";
import { traceGraphRun, langsmithInfo } from "../tracing/langsmith.js";
import { lastUserText } from "./state.js";
import { buildSupervisorGraph, SUPERVISOR_META } from "./supervisor.js";
import { buildSwarmGraph, SWARM_META } from "./swarm.js";
import { buildParallelGraph, PARALLEL_META } from "./parallel.js";

const log = makeLogger("graph-factory");

export const GRAPH_META = Object.freeze({
  supervisor: SUPERVISOR_META,
  swarm: SWARM_META,
  parallel: PARALLEL_META,
});
export const GRAPH_NAMES = Object.keys(GRAPH_META);

let cachedApp;

/** 编译一次复用；三个拓扑共享同一个 checkpointer 实例（同一套 thread 状态） */
export async function createApp({ checkpointer, outputMode = "summary", force = false } = {}) {
  if (cachedApp && !force) return cachedApp;

  const cp = checkpointer ?? (await createCheckpointer());
  const saver = cp?.saver ?? cp;
  const opts = { checkpointer: saver, outputMode };

  cachedApp = {
    graphs: {
      supervisor: buildSupervisorGraph(opts),
      swarm: buildSwarmGraph(opts),
      parallel: buildParallelGraph(opts),
    },
    checkpointerKind: cp?.kind ?? "custom",
    outputMode,
    defaultGraph: GRAPH_NAMES.includes(config.defaultGraph) ? config.defaultGraph : "supervisor",
  };
  log.info("graphs compiled", {
    checkpointer: cachedApp.checkpointerKind,
    outputMode,
    langsmith: langsmithInfo(),
  });
  return cachedApp;
}

export function graphConfig({ threadId = "demo-thread", namespace = "default", recursionLimit = 40 } = {}) {
  // thread_id 是 checkpointer 的主键；namespace 是 L3 长期记忆的隔离键
  return { configurable: { thread_id: threadId, namespace }, recursionLimit };
}

/**
 * 同步执行：外层包一条 LangSmith run（顶层 chain + 节点 child runs）。
 * 观测逻辑集中在这一层，节点代码完全不感知 tracing，符合依赖倒置。
 */
export async function invokeGraph(app, graphName, input, options = {}) {
  const graph = app.graphs[graphName];
  if (!graph) throw new Error(`未知拓扑 ${graphName}，可选：${GRAPH_NAMES.join(", ")}`);
  const cfg = graphConfig(options);
  return traceGraphRun({
    graphName,
    threadId: cfg.configurable.thread_id,
    namespace: cfg.configurable.namespace,
    question: lastUserText(input.messages ?? []),
    run: () => graph.invoke(input, cfg),
  });
}

/**
 * 流式执行：为了保持 SSE 的逐节点实时性，这里没有套 traceable。
 * 生产里若要给 /stream 也加 trace，做法是用 traceable 包装 generator
 * （收集结束后再 end run）或挂 LangChainTracer callback，不能简单包一层
 * 同步函数，否则会退化成「全部跑完才返回」。
 */
export async function* streamGraph(app, graphName, input, options = {}) {
  const graph = app.graphs[graphName];
  if (!graph) throw new Error(`未知拓扑 ${graphName}，可选：${GRAPH_NAMES.join(", ")}`);
  // updates 模式：每个节点完成后 yield 一次 { nodeName: stateUpdate }。
  // LangGraph 1.x 的 .stream() 是惰性返回值，用 await + for await 兼容
  // 同步 iterable / async iterable 两种实现；直接 yield* 委托会抛 not async iterable。
  const stream = await graph.stream(input, { ...graphConfig(options), streamMode: "updates" });
  for await (const chunk of stream) yield chunk;
}

export async function readState(app, graphName, options = {}) {
  const graph = app.graphs[graphName];
  return graph.getState(graphConfig(options));
}
