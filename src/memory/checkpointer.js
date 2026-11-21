import { MemorySaver } from "@langchain/langgraph";

/**
 * LangGraph Checkpointer：在每个 superstep 之后把整张图的状态快照持久化。
 *
 *   memory   —— MemorySaver，进程内，测试用
 *   postgres —— PostgresSaver，生产用，setup() 自动建 checkpoint 表
 *
 * thread_id 是会话隔离键：同一 thread_id 再次 invoke 会接着上次状态继续，
 * 这也是 human-in-the-loop（断点 / 审批 / 回溯）的基础。
 */
export async function createCheckpointer(cfg) {
  if (cfg.storage.checkpointer === "memory") {
    return { saver: new MemorySaver(), close: async () => {}, backend: "memory" };
  }

  const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
  const saver = PostgresSaver.fromConnString(cfg.storage.databaseUrl);
  await saver.setup();
  return {
    saver,
    close: async () => {
      if (typeof saver.end === "function") await saver.end();
    },
    backend: "postgres",
  };
}
