import { END, START, StateGraph } from "@langchain/langgraph";
import { AgentState, WORKER_NAMES } from "../agents/state.js";
import { makeSupervisorNode } from "../agents/supervisor.js";
import { makeWorkerNode } from "../agents/workers.js";

/**
 * 中心化 Supervisor 拓扑（星形）：
 *
 *            ┌────────────► researcher ─────────┐
 *            │                                  │
 *   START ─► supervisor ───► analyst ───────────┼─► (回到 supervisor)
 *            │                                  │
 *            └────────────► writer ────────────┘
 *                    │
 *                    └──► FINISH ─► END
 *
 * 关键点：所有 Worker 执行完都通过「普通边」回到 Supervisor，
 * 只有 Supervisor 拥有「条件边」。这就是「中心化」在图结构上的体现 ——
 * 没有任何 Worker 能直接把控制权移交给另一个 Worker。
 */
export function buildGraph({ cfg, llm, tools, checkpointer }) {
  const graph = new StateGraph(AgentState)
    .addNode("supervisor", makeSupervisorNode({ llm, routeTool: tools.route, cfg }));

  for (const name of WORKER_NAMES) {
    graph.addNode(name, makeWorkerNode(name, { llm, tools, cfg }));
  }

  graph.addEdge(START, "supervisor");

  const pathMap = Object.fromEntries([
    ...WORKER_NAMES.map((name) => [name, name]),
    ["FINISH", END],
  ]);

  graph.addConditionalEdges(
    "supervisor",
    (state) => state.next ?? "FINISH",
    pathMap,
  );

  for (const name of WORKER_NAMES) {
    graph.addEdge(name, "supervisor");
  }

  return graph.compile({ checkpointer });
}
