import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { probePostgres, execSqlFile, closePool } from "../memory/pg-pool.js";
import { makeLogger } from "../config.js";

const log = makeLogger("init-db");

const probe = await probePostgres();
if (!probe.ok) {
  console.error(`✗ PostgreSQL 不可用：${probe.reason}`);
  console.error("  请先执行 docker compose up -d，或本机安装 postgresql@16 + pgvector 后建库。");
  process.exit(1);
}

const sql = await fs.readFile(path.join(config.root, "db", "schema.sql"), "utf8");
await execSqlFile(sql);
log.info(`✓ 建表完成（${probe.db}）：knowledge_chunks / agent_memories / agent_events`);
if (config.llm.dim !== 1536) {
  log.warn(`当前 EMBEDDING_DIM=${config.llm.dim}，但 schema.sql 中是 vector(1536)；请同步修改列与索引。`);
}
await closePool();
