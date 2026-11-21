-- ============================================================================
-- pgvector 初始化脚本（docker-compose 首次启动时自动执行）
-- ============================================================================

-- 1) 向量扩展：pgvector 一切的起点
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) 业务知识表示范：展示 vector 列 + HNSW 余弦索引的标准写法
--    注意：LangChain 的 PGVectorStore.initialize() 会自动创建并管理
--    自己的 documents 表（列：id / content / metadata / embedding），
--    所以这里刻意用另一个表名，避免和运行时的自动建表冲突。
CREATE TABLE IF NOT EXISTS knowledge_base (
    id          TEXT PRIMARY KEY,
    content     TEXT        NOT NULL,
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    embedding   vector(1536),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW 是 pgvector 在召回率/查询延迟上更优的 ANN 索引（对比 IVFFlat）
CREATE INDEX IF NOT EXISTS knowledge_base_embedding_hnsw
    ON knowledge_base
    USING hnsw (embedding vector_cosine_ops);

-- 3) LangGraph PostgresSaver.setup() 会自动创建 checkpoint 相关表，无需手写 DDL。

-- 手动验证示例：
--   SELECT extname FROM pg_extension WHERE extname = 'vector';
--   SELECT id, left(content, 40) FROM knowledge_base LIMIT 5;
--   SELECT count(*) FROM checkpoints;   -- 图跑过之后才有数据
