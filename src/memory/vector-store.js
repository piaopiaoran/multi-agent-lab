import { config, makeLogger } from "../config.js";
import { getEmbeddings } from "../llm/factory.js";
import { getPool, probePostgres } from "./pg-pool.js";

const log = makeLogger("vector-store");

/**
 * pgvector 薄封装（只用 pg 直接写 SQL，没有引入 @langchain/community 的 PGVectorStore）。
 * 取舍：
 *  - 自己写：能讲清 <=> 余弦距离、::vector 绑定、HNSW 索引、metadata @> 过滤，
 *    且不受社区包 API 变动影响；少一层抽象，面试时很好展开。
 *  - 换成生态件：把本文件替换为 PGVectorStore.fromDocuments(...) 即可，
 *    工具层 rag_search 不需要改动（依赖倒置）。
 *
 * 表名全部来自白名单常量，绝不拼接外部输入。
 */
const TABLES = Object.freeze({ knowledge: "knowledge_chunks", memory: "agent_memories" });

let backendPromise;

async function resolveBackend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      const probe = await probePostgres();
      if (probe.ok) return { kind: "pg", db: probe.db };
      if (config.strictPg) throw new Error(`PostgreSQL 不可用：${probe.reason}`);
      log.warn(`降级为内存向量库（${probe.reason}）`);
      return { kind: "memory", knowledge: [], memories: [] };
    })();
  }
  return backendPromise;
}

const toVectorLiteral = (v) => `[${v.join(",")}]`;

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot; // hashEmbedding / OpenAI embeddings 均可视为已归一化
}

function memorySearch(rows, vector, { k, filter, namespace }) {
  return rows
    .filter((r) => (!namespace || r.namespace === namespace))
    .filter((r) => Object.entries(filter ?? {}).every(([key, val]) => r.metadata?.[key] === val))
    .map((r) => ({ ...r, score: cosine(r.embedding, vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** 写入知识块；docs: [{ content, metadata }] */
export async function addDocuments(docs) {
  const backend = await resolveBackend();
  const embeddings = getEmbeddings();
  const vectors = await embeddings.embedDocuments(docs.map((d) => d.content));

  if (backend.kind === "memory") {
    docs.forEach((d, i) => backend.knowledge.push({
      content: d.content,
      metadata: d.metadata ?? {},
      embedding: vectors[i],
    }));
    return docs.length;
  }

  const pool = getPool();
  for (let i = 0; i < docs.length; i += 1) {
    await pool.query(
      `INSERT INTO ${TABLES.knowledge} (content, metadata, embedding)
       VALUES ($1, $2::jsonb, $3::vector)`,
      [docs[i].content, JSON.stringify(docs[i].metadata ?? {}), toVectorLiteral(vectors[i])],
    );
  }
  return docs.length;
}

/** 语义检索：返回 [{ content, metadata, score }]，score 越接近 1 越相似 */
export async function similaritySearch(query, { k = 4, filter = {} } = {}) {
  const backend = await resolveBackend();
  const vector = await getEmbeddings().embedQuery(query);

  if (backend.kind === "memory") {
    return memorySearch(backend.knowledge, vector, { k, filter }).map(({ content, metadata, score }) => ({
      content, metadata, score,
    }));
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT content, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM ${TABLES.knowledge}
      WHERE metadata @> $2::jsonb
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(vector), JSON.stringify(filter), k],
  );
  return rows.map((r) => ({ content: r.content, metadata: r.metadata, score: Number(r.score) }));
}

/** 跨会话语义记忆写入，namespace 做用户/租户级隔离 */
export async function saveMemory(namespace, content, metadata = {}) {
  const backend = await resolveBackend();
  const vector = await getEmbeddings().embedQuery(content);

  if (backend.kind === "memory") {
    backend.memories.push({ namespace, content, metadata, embedding: vector, created_at: new Date() });
    return;
  }
  await getPool().query(
    `INSERT INTO ${TABLES.memory} (namespace, content, metadata, embedding)
     VALUES ($1, $2, $3::jsonb, $4::vector)`,
    [namespace, content, JSON.stringify(metadata), toVectorLiteral(vector)],
  );
}

export async function recallMemories(namespace, query, k = 3) {
  const backend = await resolveBackend();
  const vector = await getEmbeddings().embedQuery(query);

  if (backend.kind === "memory") {
    return memorySearch(backend.memories, vector, { k, namespace });
  }
  const { rows } = await getPool().query(
    `SELECT content, metadata, created_at, 1 - (embedding <=> $1::vector) AS score
       FROM ${TABLES.memory}
      WHERE namespace = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(vector), namespace, k],
  );
  return rows.map((r) => ({ content: r.content, metadata: r.metadata, created_at: r.created_at, score: Number(r.score) }));
}

/** 仅用于清库重灌，避免重复 seed 造成检索结果重复 */
export async function clearKnowledge() {
  const backend = await resolveBackend();
  if (backend.kind === "memory") {
    backend.knowledge.length = 0;
    return;
  }
  await getPool().query(`TRUNCATE ${TABLES.knowledge} RESTART IDENTITY`);
}
