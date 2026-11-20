import { recallMemories, saveMemory } from "./vector-store.js";

/**
 * 三层记忆模型（面试高频考点，务必能分清）：
 *   L1 工作记忆：State 里的 messages，单次 run 内有效，随图结束即消失。
 *   L2 短期/会话记忆：checkpointer 的 checkpoint，按 thread_id 索引，跨轮次、跨进程。
 *   L3 长期语义记忆：pgvector 里的 agent_memories，按 namespace 隔离，跨会话、可语义召回。
 * 本文件负责 L3 的「召回 → 注入 prompt」和「提炼 → 落库」两件事。
 */

export async function buildMemoryContext(namespace, query, k = 3) {
  const hits = await recallMemories(namespace, query, k);
  if (hits.length === 0) return "";
  const lines = hits.map((h, i) => `${i + 1}. ${h.content} (相似度 ${h.score.toFixed(3)})`);
  return `【历史记忆 · namespace=${namespace}】\n${lines.join("\n")}\n请在不与当前指令冲突的前提下参考以上记忆。`;
}

export async function remember(namespace, content, metadata = {}) {
  await saveMemory(namespace, content, { ...metadata, saved_by: "long-term-memory" });
}
