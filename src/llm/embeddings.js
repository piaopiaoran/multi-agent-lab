import { Embeddings } from "@langchain/core/embeddings";
import { OpenAIEmbeddings } from "@langchain/openai";

/**
 * Embeddings 层。
 *
 * 重要取舍：DeepSeek（以及不少国产 Chat 模型）只提供 /chat/completions，
 * 并不提供 /embeddings，所以 pgvector 的向量化必须独立选型，
 * 不能想当然地复用 LLM 的 baseURL / key。这里提供两档：
 *   fake   —— 本地确定性哈希向量，零成本，用于跑通检索链路（无语义，只有词面重叠信号）
 *   openai —— OpenAI 兼容 /embeddings（硅基流动 BGE 系列 / OpenAI 等）
 * 切换模型时向量维度可能变化，必须同步改 EMBEDDINGS_DIM 并重建 pgvector 表。
 */

function fnv1a(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 中文友好的确定性向量：词 token + 单字 + 相邻字 bigram，最后 L2 归一化。 */
export function deterministicVector(text, dim = 1536) {
  const width = Math.max(8, Math.floor(dim));
  const vec = new Array(width).fill(0);
  const s = String(text ?? "").toLowerCase();

  const bump = (token, weight) => {
    const h = fnv1a(token);
    vec[h % width] += weight;
    vec[(h >>> 8) % width] += weight * 0.5;
    vec[(h >>> 16) % width] += weight * 0.25;
  };

  for (const token of s.match(/[\p{L}\p{N}]+/gu) || []) bump(token, 1);

  // 中文没有空格分词，补上单字与相邻字 bigram，避免整句塌成一个 token
  const chars = Array.from(s.replace(/\s+/g, ""));
  for (let i = 0; i < chars.length; i += 1) {
    bump(chars[i], 0.6);
    if (i + 1 < chars.length) bump(chars[i] + chars[i + 1], 0.4);
  }

  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export class DeterministicEmbeddings extends Embeddings {
  constructor({ dim = 1536 } = {}) {
    super({});
    this.dim = dim;
  }

  async embedDocuments(texts) {
    return texts.map((t) => deterministicVector(t, this.dim));
  }

  async embedQuery(text) {
    return deterministicVector(text, this.dim);
  }
}

export function createEmbeddings(cfg) {
  if (cfg.embeddings.provider === "fake") {
    return new DeterministicEmbeddings({ dim: cfg.embeddings.dim });
  }
  return new OpenAIEmbeddings({
    apiKey: cfg.embeddings.apiKey,
    model: cfg.embeddings.model,
    configuration: { baseURL: cfg.embeddings.baseURL },
  });
}
