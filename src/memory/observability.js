import { getPool } from "./pg-pool.js";
import { makeLogger } from "../config.js";

const log = makeLogger("trace");
const MAX_IN_MEMORY = 500;
const buffer = [];

/**
 * 最轻量的节点级事件轨迹。
 * - checkpointer 存的是「状态快照」，适合回放 / 断点续跑；
 * - 这里存的是「业务语义事件」（谁在什么时候做了什么），适合评估与排障。
 * 写库失败一律吞掉：可观测性不能反过来拖垮主链路。
 */
export async function recordEvent({ threadId = "default", graph = "unknown", node, event, payload = {} }) {
  const row = { thread_id: threadId, graph, node, event, payload, created_at: new Date() };
  buffer.push(row);
  if (buffer.length > MAX_IN_MEMORY) buffer.shift();
  log.debug("event", { graph, node, event });

  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO agent_events (thread_id, graph, node, event, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [row.thread_id, row.graph, row.node, row.event, JSON.stringify(row.payload)],
    );
  } catch {
    // 表不存在 / 连接断开：静默降级为内存轨迹
  }
}

export function getEvents(threadId) {
  return buffer.filter((r) => r.thread_id === threadId);
}
