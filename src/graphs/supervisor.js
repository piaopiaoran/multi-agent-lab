import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState, AGENT_NAMES, routeFromSupervisor } from "./state.js";
import { createSupervisorNode } from "../agents/supervisor.js";
import { createWorkerNode } from "../agents/workers.js";

/**
 * 拓扑 A：Supervisor 星型（中心化）
 *
 *   START → supervisor ⇄ researcher / analyst / writer → END
 *                  ↑__________ 每次完成后回到中心 __________|
 *
 * 适用：步骤有依赖、需要统一审批/审计、要能随时插入 human-in-the-loop。
 * 代价：N 个 Worker 至少 2N 次 LLM 调用（N 次路由 + N 次执行），延迟与成本最高。
 */
export function buildSupervisorGraph({ checkpointer, outputMode = "summary" } = {}) {
  const graph = new StateGraph(AgentState)
    .addNode("supervisor", createSupervisorNode({ traceGraph: "supervisor" }))
    .addEdge(START, "supervisor");

  for (const name of AGENT_NAMES) {
    graph.addNode(name, createWorkerNode(name, { outputMode, traceGraph: "supervisor" }));
    graph.addEdge(name, "supervisor"); // 回到中心重新决策
  }

  graph.addConditionalEdges(
    "supervisor",
    routeFromSupervisor(),
    { ...Object.fromEntries(AGENT_NAMES.map((n) => [n, n])), [END]: END },
  );

  // checkpointer 注入到 compile，所有节点共享同一份 thread 状态
  return graph.compile({ checkpointer });
}

export const SUPERVISOR_META = {
  name: "supervisor",
  label: "中心化 Supervisor",
  control: "中心节点统一路由",
  callsPerTask: "≈ 2N（N 次路由 + N 次执行）",
  strength: "可控、可审计、易插入人工审批",
  weakness: "中心节点是延迟/成本瓶颈，串行",
};
