import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

/** 中心化拓扑里所有合法的 Worker 节点名，也是 Supervisor 的路由白名单。 */
export const WORKER_NAMES = ["researcher", "analyst", "writer"];

/**
 * LangGraph 状态的每个字段都带 reducer —— 这是面试高频点：
 * reducer 决定了「多个节点并发写同一字段」时如何合并，而不是简单覆盖。
 *
 *  messages     : 复用官方 MessagesAnnotation.spec，追加语义且支持按 message id 覆盖/删除
 *  next         : 标量覆盖，Supervisor 写、条件边读
 *  visited      : 集合并集，用于去重与终止判断
 *  rounds       : 累加，护栏计数
 *  finalAnswer  : 标量覆盖
 *  trace        : 追加，记录每一步路由决策（也便于写进日志）
 */
export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,

  next: Annotation({
    reducer: (_prev, value) => value ?? "FINISH",
    default: () => "researcher",
  }),

  visited: Annotation({
    reducer: (prev = [], incoming = []) => [
      ...new Set([...(prev ?? []), ...(incoming ?? [])]),
    ],
    default: () => [],
  }),

  rounds: Annotation({
    reducer: (prev = 0, incoming = 0) => (prev ?? 0) + (incoming ?? 0),
    default: () => 0,
  }),

  finalAnswer: Annotation({
    reducer: (_prev, value) => value ?? "",
    default: () => "",
  }),

  trace: Annotation({
    reducer: (prev = [], incoming = []) => [...(prev ?? []), ...(incoming ?? [])],
    default: () => [],
  }),
});
