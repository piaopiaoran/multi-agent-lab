/**
 * 内置面试知识库片段：让 retrieve_knowledge 工具在两种存储后端下都有内容可检索。
 * 生产环境应换成 ingest 管道（文档切分 → embeddings → upsert），这里为学习项目内置种子数据。
 */
export const SEED_DOCUMENTS = [
  {
    id: "arch-supervisor",
    content:
      "中心化 Supervisor 架构：一个调度 Agent（Supervisor）接收用户任务，负责分解、选择下一个 Worker、判断何时结束；多个 Worker 各司其职，执行完统一把结果交回 Supervisor。所有跨 Agent 的通信都经过中心节点，控制流是星形拓扑。",
    metadata: { topic: "architecture", tag: "supervisor" },
  },
  {
    id: "arch-swarm",
    content:
      "去中心化 Swarm 架构：Agent 之间通过 handoff（移交）直接把控制权交给同伴，没有固定中心节点。优点是扩展性好、单点瓶颈小；缺点是可观测性差、容易形成循环、难以做全局终止判断与权限收口。",
    metadata: { topic: "architecture", tag: "swarm" },
  },
  {
    id: "arch-tradeoff",
    content:
      "Supervisor 与 Swarm 的取舍：Supervisor 便于审计、限流、统一记忆与全局停止条件，适合任务可分解、需要合规留痕的企业场景；Swarm 适合探索性、动态协作的场景。面试中常答：中心化换来可控性，代价是 Supervisor 成为单点与延迟瓶颈。",
    metadata: { topic: "architecture", tag: "tradeoff" },
  },
  {
    id: "langgraph-conditional-edges",
    content:
      "LangGraph 实现 Supervisor 的核心机制是条件边（addConditionalEdges）：Supervisor 节点把路由决策写入状态的 next 字段，条件边根据 next 的值跳转到对应 Worker 节点或 END；每个 Worker 执行完通过普通边回到 Supervisor，形成循环。",
    metadata: { topic: "langgraph", tag: "routing" },
  },
  {
    id: "langgraph-checkpointer",
    content:
      "LangGraph 的 Checkpointer 在图的每个 superstep 后把状态快照持久化。MemorySaver 用于本地测试，PostgresSaver 用于生产。thread_id 用来隔离不同会话，配合 breakpoint 可实现 human-in-the-loop 审批与断点续跑。",
    metadata: { topic: "langgraph", tag: "checkpoint" },
  },
  {
    id: "langgraph-state-reducer",
    content:
      "LangGraph 状态由 Annotation 定义，每个字段带 reducer。messages 常用 MessagesAnnotation 的追加语义（按 message id 支持覆盖与删除），next / rounds 这类标量字段用覆盖或累加 reducer。reducer 决定并发节点写同一字段时如何合并。",
    metadata: { topic: "langgraph", tag: "state" },
  },
  {
    id: "pgvector",
    content:
      "pgvector 让 PostgreSQL 支持向量列与 ANN 检索，索引类型主要有 HNSW 与 IVFFlat，距离算子常用 vector_cosine_ops / vector_l2_ops。优势是与业务数据同库、支持事务与 SQL 过滤；代价是需要自行管理维度、索引重建与召回率调优。",
    metadata: { topic: "memory", tag: "pgvector" },
  },
  {
    id: "embeddings-selection",
    content:
      "Embedding 模型与生成模型是两个独立服务。很多国产 Chat 模型（如 DeepSeek）只提供 chat/completions，不提供 embeddings，因此 RAG 链路需要单独选型：可换用硅基流动的 BGE 系列或 OpenAI text-embedding，也可在离线验证阶段使用确定性哈希向量。切换模型必须同步修改向量维度并重建表。",
    metadata: { topic: "memory", tag: "embeddings" },
  },
  {
    id: "langsmith",
    content:
      "LangSmith 通过环境变量 LANGSMITH_TRACING / LANGSMITH_API_KEY / LANGSMITH_PROJECT 接入，无需改业务代码。它为每次图执行生成 run tree，记录每个节点的输入输出、延迟、token 与工具调用，是排查多 Agent 死循环、路由错误和幻觉的主要依据。",
    metadata: { topic: "observability", tag: "langsmith" },
  },
  {
    id: "harness",
    content:
      "Agent harness 指包裹 LLM 的执行骨架：构造 prompt、调用模型、解析 tool_calls、执行工具、把 ToolMessage 回填、循环直到模型不再请求工具或达到迭代上限。必须设置 max_iterations 防止工具循环，并对工具异常做降级返回而非让整张图崩溃。",
    metadata: { topic: "engineering", tag: "harness" },
  },
  {
    id: "guardrails",
    content:
      "多 Agent 生产化的四类护栏：路由白名单校验（防止 LLM 输出不存在的节点名）、最大轮次 maxRounds、单 worker 工具迭代上限、以及结构化输出解析失败时的兜底策略。此外还要有超时、重试、成本上限与密钥隔离。",
    metadata: { topic: "engineering", tag: "guardrails" },
  },
];
