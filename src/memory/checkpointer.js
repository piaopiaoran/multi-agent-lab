import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { config, makeLogger } from "../config.js";
import { probePostgres } from "./pg-pool.js";

const log = makeLogger("checkpointer");

/**
 * 短期记忆 = LangGraph 的「线程状态」。
 * 同一个 thread_id 会复用 checkpoint，因此：
 *   1) 天然支持多轮对话；
 *   2) 进程重启后能续跑（PostgresSaver 持久化，MemorySaver 不行）；
 *   3) 可以在任意节点后加 interruptBefore 做 human-in-the-loop。
 *
 * 降级策略：连不上 PG 就用 MemorySaver，接口完全一致，上层图代码零改动。
 * 这是面试里「如何保证 demo 可演示性 / 如何做依赖隔离」的一个好答案。
 */
export async function createCheckpointer() {
  const probe = await probePostgres();
  if (!probe.ok) {
    if (config.strictPg) throw new Error(`PostgreSQL 不可用：${probe.reason}`);
    log.warn(`降级为 MemorySaver（${probe.reason}）`);
    return { saver: new MemorySaver(), kind: "memory" };
  }

  try {
    const saver = typeof PostgresSaver.fromConnString === "function"
      ? PostgresSaver.fromConnString(config.databaseUrl)
      : new PostgresSaver({ connectionString: config.databaseUrl });
    // setup() 幂等，会创建 checkpoints / checkpoint_writes / checkpoint_blobs / checkpoint_migrations
    await saver.setup();
    log.info(`PostgresSaver 已接入，数据库 ${probe.db}`);
    return { saver, kind: "postgres" };
  } catch (err) {
    if (config.strictPg) throw err;
    log.warn(`PostgresSaver 初始化失败，降级为 MemorySaver：${err.message}`);
    return { saver: new MemorySaver(), kind: "memory" };
  }
}
