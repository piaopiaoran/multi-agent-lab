/**
 * Web 控制台与 Agent 链路之间的「事件协议」。
 *
 * 设计原则：可观测性是横切关注点，不应该污染图的状态定义。
 * 因此这里只提供一个可选的 onEvent 回调，由节点主动 emit 语义事件；
 * 不传回调时节点行为与纯 CLI 模式完全一致（零回归）。
 *
 * 事件不是 state：state 是「决策依据」，会被 Checkpointer 持久化并喂给模型；
 * 事件是「给人看的轨迹」，允许包含工具参数、耗时、中间失败等展示信息，
 * 但绝不会回流进 LLM 上下文 —— 这是面试里常被追问的一条边界。
 */
export const EVT = Object.freeze({
  META: "meta", // 运行配置、thread_id、开始时间
  NODE: "node", // 节点开始 / 结束
  ROUTE: "route", // Supervisor 的结构化路由决策
  TOOL: "tool", // Worker 的工具调用（参数 / 结果 / 耗时）
  WORKER: "worker", // Worker 的最终产出
  STATE: "state", // 每个节点写回的状态增量
  FINAL: "final", // 最终答案与统计
  ERROR: "error", // 运行异常
  DONE: "done", // 流关闭信号
});

/** 事件通道异常绝不能让整张图崩掉，所以这里吞掉回调自身的错误。 */
export function emit(onEvent, type, payload = {}) {
  if (typeof onEvent !== "function") return;
  try {
    onEvent({ type, ...payload });
  } catch {
    // 例如浏览器已断开、序列化失败：只影响展示，不影响 Agent 执行
  }
}
