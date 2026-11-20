-- 幂等建表脚本；docker-compose 会在首次启动时自动执行，
-- 也可手动执行：npm run init:db

CREATE EXTENSION IF NOT EXISTS vector;

-- 1) 知识库：RAG 检索用的文档块（pgvector 存向量，JSONB 存可过滤元数据）
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  embedding   vector(1536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- HNSW 是近似最近邻索引； cosine 距离对应 <=> 操作符。
-- 数据量小（< 万行）时可以不建，直接走精确扫描。
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS knowledge_chunks_metadata_gin
  ON knowledge_chunks USING gin (metadata);

-- 2) 长期记忆：跨会话的语义记忆，按 namespace 做逻辑隔离（多租户 / 多用户）
CREATE TABLE IF NOT EXISTS agent_memories (
  id          BIGSERIAL PRIMARY KEY,
  namespace   TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  embedding   vector(1536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_memories_namespace_idx ON agent_memories (namespace);
CREATE INDEX IF NOT EXISTS agent_memories_embedding_hnsw
  ON agent_memories USING hnsw (embedding vector_cosine_ops);

-- 3) 可观测性：节点级事件轨迹。面试讲「可观测 / 回放 / 评估」时很有用。
--    LangGraph 的 checkpointer 负责状态快照，本表负责业务语义事件，二者互补。
CREATE TABLE IF NOT EXISTS agent_events (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   TEXT        NOT NULL,
  graph       TEXT        NOT NULL,
  node        TEXT        NOT NULL,
  event       TEXT        NOT NULL,
  payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_events_thread_idx ON agent_events (thread_id, id);
