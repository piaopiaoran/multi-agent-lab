/**
 * LangSmith 可观测性辅助层。
 *
 * 接入本身只靠环境变量（见 config/env.js 的 configureLangSmith），
 * LangChain.js 会自动为每个 LLM 调用 / 工具调用 / 图节点创建 run。
 * 这个文件负责给整张图的根 run 打上可检索的 tags 和 metadata，
 * 方便在 LangSmith 里按「模型 / 存储档位 / 线程」过滤对比。
 *
 * 面试要点：trace 的层级是 run tree —— 根 run(图) → supervisor → worker → LLM / tool，
 * 每一层都能看到 input / output / latency / token，定位死循环或幻觉时非常有用。
 */
export function buildRunConfig(cfg, { threadId, question, recursionLimit = 40 } = {}) {
  const config = {
    configurable: { thread_id: threadId || `thread-${Date.now()}` },
    recursionLimit,
    runName: "supervisor-session",
    tags: [
      "multi-agent",
      "supervisor",
      `llm:${cfg.llm.provider}`,
      `vector:${cfg.storage.backend}`,
      `checkpointer:${cfg.storage.checkpointer}`,
    ],
    metadata: {
      llm_provider: cfg.llm.provider,
      llm_model: cfg.llm.model,
      embeddings_provider: cfg.embeddings.provider,
      storage_backend: cfg.storage.backend,
      checkpointer: cfg.storage.checkpointer,
      max_rounds: cfg.graph.maxRounds,
      question_length: (question || "").length,
      // 注意：这里刻意不放任何密钥
    },
  };
  return config;
}

/** 节点级 tag，让 trace 里能一眼分辨是哪个 agent 的 LLM 调用。 */
export function nodeTags(nodeName) {
  return { tags: [`node:${nodeName}`] };
}

export function printLangSmithHint(cfg) {
  if (!cfg.langsmith.enabled) {
    return "LangSmith tracing 当前关闭（设置 LANGSMITH_TRACING=true 且填写 LANGSMITH_API_KEY 后开启）";
  }
  return (
    `LangSmith tracing 已开启：project=${cfg.langsmith.project}\n` +
    `在 https://smith.langchain.com 选择该 project 即可查看 run tree`
  );
}
