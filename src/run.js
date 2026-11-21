import { HumanMessage } from "@langchain/core/messages";
import { createTools } from "./agents/tools.js";
import { createEmbeddings } from "./llm/embeddings.js";
import { createLLM } from "./llm/factory.js";
import { createCheckpointer } from "./memory/checkpointer.js";
import { createVectorStore } from "./memory/vectorStore.js";
import { buildRunConfig } from "./observability/langsmith.js";
import { buildGraph } from "./graph/buildGraph.js";

export const DEFAULT_QUESTION =
  "请分析中心化 Supervisor 与去中心化 Swarm 两种多 Agent 架构的取舍，" +
  "说明 LangGraph 的条件边和 Checkpointer 各自解决什么问题，并给出 3 条面试回答要点。";

/**
 * 组装并运行一次完整会话。所有外部资源都在 try/finally 里释放，
 * 避免 Postgres 连接池让 Node 进程挂住不退出。
 */
export async function runSession({ cfg, question = DEFAULT_QUESTION, threadId }) {
  const embeddings = createEmbeddings(cfg);
  const llm = createLLM(cfg);
  const { store, backend: vectorBackend } = await createVectorStore(cfg, embeddings);
  const {
    saver,
    close: closeCheckpointer,
    backend: checkpointerBackend,
  } = await createCheckpointer(cfg);

  try {
    const tools = createTools(store);
    const app = buildGraph({ cfg, llm, tools, checkpointer: saver });
    const config = buildRunConfig(cfg, { threadId, question });

    const state = await app.invoke(
      { messages: [new HumanMessage(question)] },
      config,
    );

    return {
      finalAnswer: state.finalAnswer || "(本次未产出最终答案)",
      visited: state.visited ?? [],
      rounds: state.rounds ?? 0,
      trace: state.trace ?? [],
      messages: state.messages ?? [],
      threadId: config.configurable.thread_id,
      backends: { vector: vectorBackend, checkpointer: checkpointerBackend },
    };
  } finally {
    await store.close();
    await closeCheckpointer();
  }
}
