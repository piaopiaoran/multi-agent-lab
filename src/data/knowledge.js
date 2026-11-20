/**
 * 演示用知识库。内容本身就是面试要点，RAG 命中后输出读起来有意义。
 * 无 PG 时 demo 会把这批数据灌进内存向量库；有 PG 时用 npm run seed 落库。
 */
export const SEED_DOCUMENTS = [
  {
    content: "LangGraph 的 StateGraph 用 Annotation 定义状态，每个字段可以带 reducer。reducer 决定并行分支同时写同一字段时如何合并；messages 字段通常用 messagesStateReducer，按 message id 去重合并。",
    metadata: { topic: "langgraph", source: "state-design-notes" },
  },
  {
    content: "Supervisor 星型拓扑：所有 Worker 完成后都回到中心节点重新路由。优点是可控、易观测、便于加人工审批；缺点是每次交接都要多一次 LLM 调用，中心节点成为延迟与成本瓶颈。",
    metadata: { topic: "topology", source: "multi-agent-patterns" },
  },
  {
    content: "Swarm 去中心化拓扑：Agent 之间通过 handoff 直接移交控制权，LangGraph JS 中用 Command({ goto, update }) 实现，一次调用同时完成状态更新与跳转，省掉回到中心的往返。风险是容易形成环，必须配迭代上限与去重。",
    metadata: { topic: "topology", source: "multi-agent-patterns" },
  },
  {
    content: "并行扇出用 Send API：条件边返回 Send 数组即可把同一状态复制分发给多个节点，各分支状态经 reducer 汇聚。适合互不依赖的子任务，用延迟换 token 成本。",
    metadata: { topic: "langgraph", source: "map-reduce-notes" },
  },
  {
    content: "checkpointer 是 LangGraph 的短期记忆：按 thread_id 保存每个超步后的状态快照。MemorySaver 只适合单机调试，PostgresSaver 支持跨进程续跑、崩溃恢复与 human-in-the-loop 的 interrupt 恢复。",
    metadata: { topic: "memory", source: "checkpoint-notes" },
  },
  {
    content: "pgvector 用 <=> 计算余弦距离，1 - (embedding <=> query) 即相似度；HNSW 索引配合 vector_cosine_ops 做近似最近邻。维度必须与 embedding 模型一致，换模型要重建列与索引。metadata JSONB 配合 @> 可做结构化过滤。",
    metadata: { topic: "pgvector", source: "vector-db-notes" },
  },
  {
    content: "多 Agent 系统的三层记忆：L1 工作记忆是图状态里的 messages；L2 会话记忆是 checkpointer 的 checkpoint；L3 长期语义记忆是 pgvector 中的可召回事实，按 namespace 做用户级隔离。",
    metadata: { topic: "memory", source: "memory-layers" },
  },
  {
    content: "工具安全：不要对模型生成的字符串使用 eval 或 new Function；用白名单解析器或沙箱执行。工具应遵循最小权限原则，每个 Agent 只绑定自己需要的工具，降低误调用与提示词膨胀。",
    metadata: { topic: "safety", source: "agent-safety" },
  },
  {
    content: "上下文隔离：Worker 子图内部的工具调用轨迹不必全部回传主图，通常只回传最终结论（summary 模式），否则多轮协作后主图 token 线性膨胀。需要审计时再切到 full 模式或单独写事件表。",
    metadata: { topic: "context", source: "context-engineering" },
  },
  {
    content: "防死循环的硬护栏：状态里维护 completedAgents 与 iteration，路由前做白名单校验、重复调度去重、最大迭代次数强制收敛，并在 compile 时设置 recursionLimit。模型层的自律不可靠，必须由代码兜底。",
    metadata: { topic: "safety", source: "agent-safety" },
  },
];
