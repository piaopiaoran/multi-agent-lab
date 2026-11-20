import { StateGraph, START, END, Command } from "@langchain/langgraph";
import { AgentState, AGENT_NAMES } from "./state.js";
import { createWorkerNode } from "../agents/workers.js";
import { createHandoffRouter } from "../agents/supervisor.js";
import { recordEvent } from "../memory/observability.js";

/**
 * 拓扑 B：Swarm 去中心化 handoff
 *
 *   START → researcher ──handoff──→ analyst ──handoff──→ writer ──→ END
 *
 * 每个 Agent 自己决定「下一棒交给谁」，用 Command({ goto, update })
 * 在一次返回里同时更新状态并跳转，省掉回到中心的往返。
 * 代价：没有全局视角，容易形成 A→B→A 的环，因此必须靠
 *       completedAgents 去重 + iteration 上限 + recursionLimit 三重护栏。
 */
function buildHandoffNode(name, { outputMode }) {
  const worker = createWorkerNode(name, { outputMode, traceGraph: "swarm" });
  const decide = createHandoffRouter(name);

  return async (state, config) => {
    const update = await worker(state, config);
    const done = Array.from(new Set([...(state.completedAgents ?? []), ...(update.completedAgents ?? [])]));
    const decision = await decide(state, done);
    const goto = decision.next === "FINISH" ? END : decision.next;

    await recordEvent({
      threadId: config?.configurable?.thread_id ?? "default",
      graph: "swarm", node: name, event: "handoff",
      payload: { from: name, to: String(goto), reason: decision.reason, done },
    });

    return new Command({
      goto,
      update: { ...update, next: decision.next, reason: decision.reason },
    });
  };
}

export function buildSwarmGraph({ checkpointer, outputMode = "summary" } = {}) {
  const graph = new StateGraph(AgentState);
  for (const name of AGENT_NAMES) {
    // LangGraph 1.x 会在编译期做可达性校验：用 Command.goto 动态跳转时，
    // 必须通过 ends 声明「这个节点可能跳到谁」，否则报 UnreachableNodeError。
    // 这一步同时也把 handoff 的合法目标收敛成白名单，属于有益的约束。
    graph.addNode(name, buildHandoffNode(name, { outputMode }), {
      ends: AGENT_NAMES.filter((n) => n !== name),
    });
  }
  graph.addEdge(START, AGENT_NAMES[0]);
  // 节点之间不建静态边：运行期完全由 Command.goto 决定，这正是「去中心化」
  return graph.compile({ checkpointer });
}

export const SWARM_META = {
  name: "swarm",
  label: "去中心化 Swarm handoff",
  control: "Agent 自行移交控制权",
  callsPerTask: "≈ 2N（N 次执行 + N 次 handoff 决策），无中心往返",
  strength: "交接快、单点故障少、更贴近对话式协作",
  weakness: "无全局视角、易成环，护栏必须硬编码",
};
