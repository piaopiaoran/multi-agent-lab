import { StateGraph, START, END, Send } from "@langchain/langgraph";
import { AgentState } from "./state.js";
import { createWorkerNode } from "../agents/workers.js";
import { recordEvent } from "../memory/observability.js";

/**
 * 拓扑 C：Send 并行扇出（map-reduce）
 *
 *              ┌→ researcher ┐
 *   START → planner            → writer → END
 *              └→ analyst    ┘
 *
 * Send(node, stateSnapshot) 把状态复制分发，两个分支在不同超步内并发执行；
 * 各自的 messages 通过 messagesStateReducer 合并，writer 读到的是汇聚后的状态。
 * 适用：子任务互不依赖（如多来源检索）；用 token 成本换端到端延迟。
 *
 * 注意：并行分支写同一个「last-write-wins」字段会互相覆盖，
 * 需要聚合的字段必须定义合并 reducer（本项目 completedAgents / iteration 就是）。
 */
export function buildParallelGraph({ checkpointer, outputMode = "summary" } = {}) {
  const graph = new StateGraph(AgentState)
    .addNode("planner", async (state, config) => {
      await recordEvent({
        threadId: config?.configurable?.thread_id ?? "default",
        graph: "parallel", node: "planner", event: "fanout",
        payload: { branches: ["researcher", "analyst"] },
      });
      return { next: "fanout", reason: "并行扇出，无需 LLM 路由", activeAgent: "planner", task: state.task || "多 Agent 架构对比" };
    })
    .addNode("researcher", createWorkerNode("researcher", { outputMode, traceGraph: "parallel" }))
    .addNode("analyst", createWorkerNode("analyst", { outputMode, traceGraph: "parallel" }))
    .addNode("writer", createWorkerNode("writer", { outputMode, traceGraph: "parallel" }))
    .addEdge(START, "planner")
    .addConditionalEdges(
      "planner",
      (state) => [
        new Send("researcher", { ...state, task: "从知识库检索事实依据" }),
        new Send("analyst", { ...state, task: "做结构化对比与量化评估" }),
      ],
      ["researcher", "analyst"],
    )
    .addEdge("researcher", "writer")
    .addEdge("analyst", "writer")
    .addEdge("writer", END);

  return graph.compile({ checkpointer });
}

export const PARALLEL_META = {
  name: "parallel",
  label: "Send 并行扇出 + 汇聚",
  control: "静态编排，无 LLM 路由",
  callsPerTask: "≈ N+1（无路由开销），但并发产生峰值 token",
  strength: "端到端延迟最低、拓扑确定、最易压测",
  weakness: "不够灵活；分支写冲突要靠 reducer 显式处理",
};
