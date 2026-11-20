import { Annotation, MessagesAnnotation, END } from "@langchain/langgraph";

export const AGENT_NAMES = Object.freeze(["researcher", "analyst", "writer"]);

/**
 * 全局共享状态 = 多 Agent 的「黑板」。
 *
 * 关键设计点（面试重点）：
 * 1. ...MessagesAnnotation.spec 展开后得到 messages 字段，其 reducer 是
 *    messagesStateReducer（内部按 message id 去重合并，不是简单 append）。
 *    因此子图/并行分支回传重复历史消息是安全的。
 * 2. 「last-write-wins」型字段（next / activeAgent）用 (_l, r) => r；
 *    「累加」型字段（completedAgents / iteration）用合并 reducer。
 *    reducer 决定了并行写冲突时怎么收敛 —— 这是 StateGraph 的灵魂。
 * 3. completedAgents 与 iteration 不是给模型看的，是给代码用的「硬护栏」：
 *    模型再怎么幻觉，也不能无限调度自己。
 */
export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,

  next: Annotation({
    reducer: (left, right) => right ?? left ?? "FINISH",
    default: () => "researcher",
  }),
  reason: Annotation({
    reducer: (left, right) => right ?? left ?? "",
    default: () => "",
  }),
  activeAgent: Annotation({
    reducer: (left, right) => right ?? left ?? "",
    default: () => "",
  }),
  completedAgents: Annotation({
    reducer: (left = [], right = []) => Array.from(new Set([...left, ...right])),
    default: () => [],
  }),
  iteration: Annotation({
    reducer: (left = 0, right = 0) => left + right,
    default: () => 0,
  }),
  namespace: Annotation({
    reducer: (left, right) => right ?? left ?? "default",
    default: () => "default",
  }),
  task: Annotation({
    reducer: (left, right) => right ?? left ?? "",
    default: () => "",
  }),
});

/**
 * 从 supervisor 出来的路由函数：纯函数，可单测。
 * 只相信白名单与硬护栏，不把模型输出直接当作节点名 goto。
 */
export function routeFromSupervisor() {
  return (state) => {
    const next = state?.next;
    if (!next || next === "FINISH" || next === "END") return END;
    if (!AGENT_NAMES.includes(next)) return END;
    if ((state.completedAgents ?? []).includes(next)) return END;
    return next;
  };
}

/** 从消息里取最后一个用户输入，用于记忆召回的 query */
export function lastUserText(messages = []) {
  const hit = [...messages].reverse().find(
    (m) => m?._getType?.() === "human" || m?.type === "human",
  );
  return typeof hit?.content === "string" ? hit.content : "";
}
