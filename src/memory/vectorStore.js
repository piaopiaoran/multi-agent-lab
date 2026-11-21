import { SEED_DOCUMENTS } from "./seed.js";

/**
 * 向量存储层：两种后端实现同一接口 similaritySearchWithScore(query, k)，
 * 上层的 retrieve_knowledge 工具完全无感。
 *
 *   memory   —— 纯 JS 内存实现（cosine），零外部依赖，开箱即跑
 *   postgres —— pgvector：手写 pg 客户端 SQL，使用 <=> 余弦距离算子 + HNSW 索引
 *
 * 为什么 postgres 档不用 @langchain/community 的 PGVectorStore：
 *  1) community 是可选依赖大集合，1.x 会拖入 stagehand / playwright 等无关包，
 *     对学习项目是噪音，还和 dotenv 版本产生 peer 冲突；
 *  2) 手写 SQL 能直接看到 <=> 算子、::vector 类型转换和 HNSW 索引，面试更好讲；
 *  3) 接口与 LangChain VectorStore 对齐，换成官方 PGVectorStore 只是替换这个类的实现。
 */

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) dot += a[i] * b[i];
  return dot; // 向量已 L2 归一化，点积即余弦相似度
}

function toLiteral(vector) {
  return `[${vector.join(",")}]`;
}

function assertSafeIdentifier(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`非法的表/索引标识符：${name}`);
  }
  return name;
}

/** 与 LangChain Document 形状一致：{ pageContent, metadata, id } */
function toDocument(row) {
  return {
    pageContent: row.content,
    metadata: row.metadata ?? {},
    id: row.id,
  };
}

export class InMemoryVectorStore {
  constructor(embeddings) {
    this.embeddings = embeddings;
    this.entries = [];
    this.backend = "memory";
  }

  static async create(embeddings, docs = SEED_DOCUMENTS) {
    const store = new InMemoryVectorStore(embeddings);
    await store.addDocuments(docs);
    return store;
  }

  async addDocuments(docs) {
    const vectors = await this.embeddings.embedDocuments(docs.map((d) => d.content));
    docs.forEach((d, i) => {
      this.entries.push({
        doc: { pageContent: d.content, metadata: d.metadata ?? {}, id: d.id },
        vector: vectors[i],
      });
    });
    return docs.map((d) => d.id);
  }

  async similaritySearchWithScore(query, k = 3) {
    const qv = await this.embeddings.embedQuery(query);
    return this.entries
      .map((e) => [e.doc, cosine(qv, e.vector)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);
  }

  async close() {
    this.entries = [];
  }
}

export class PgVectorStore {
  constructor(pool, { table, dim, embeddings }) {
    this.pool = pool;
    this.table = assertSafeIdentifier(table);
    this.dim = dim;
    this.embeddings = embeddings;
    this.backend = "postgres";
  }

  static async create(cfg, embeddings, docs = SEED_DOCUMENTS) {
    const pg = await import("pg");
    const Pool = pg.default?.Pool ?? pg.Pool;
    const pool = new Pool({ connectionString: cfg.storage.databaseUrl });
    const store = new PgVectorStore(pool, {
      table: cfg.storage.table,
      dim: cfg.embeddings.dim,
      embeddings,
    });
    await store.setup(docs);
    return store;
  }

  async setup(docs = SEED_DOCUMENTS) {
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id        TEXT PRIMARY KEY,
        content   TEXT NOT NULL,
        metadata  JSONB NOT NULL DEFAULT '{}'::jsonb,
        embedding vector(${this.dim})
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.table}_embedding_hnsw
        ON ${this.table} USING hnsw (embedding vector_cosine_ops)
    `);

    const existing = await this.pool.query(`SELECT 1 FROM ${this.table} LIMIT 1`);
    if (existing.rowCount > 0) return; // 已有数据就不重复灌入

    const vectors = await this.embeddings.embedDocuments(docs.map((d) => d.content));
    for (let i = 0; i < docs.length; i += 1) {
      await this.pool.query(
        `INSERT INTO ${this.table} (id, content, metadata, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (id) DO NOTHING`,
        [
          docs[i].id,
          docs[i].content,
          JSON.stringify(docs[i].metadata ?? {}),
          toLiteral(vectors[i]),
        ],
      );
    }
  }

  async similaritySearchWithScore(query, k = 3) {
    const qv = await this.embeddings.embedQuery(query);
    const literal = toLiteral(qv);
    // <=> 是 pgvector 的 cosine distance，1 - distance 即相似度
    const res = await this.pool.query(
      `SELECT id, content, metadata,
              1 - (embedding <=> $1::vector) AS score
         FROM ${this.table}
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [literal, k],
    );
    return res.rows.map((row) => [toDocument(row), Number(row.score)]);
  }

  async close() {
    await this.pool.end();
  }
}

export async function createVectorStore(cfg, embeddings) {
  const store =
    cfg.storage.backend === "postgres"
      ? await PgVectorStore.create(cfg, embeddings)
      : await InMemoryVectorStore.create(embeddings);
  return { store, backend: store.backend };
}
