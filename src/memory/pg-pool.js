import pg from "pg";
import { config, makeLogger } from "../config.js";

const { Pool } = pg;
const log = makeLogger("pg-pool");
let pool;

/** 单例连接池。PostgresSaver 自己维护一套连接，这里只服务 pgvector / 事件表。 */
export function getPool() {
  if (!config.databaseUrl) return null;
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 3000 });
    pool.on("error", (err) => log.warn("idle client error", err.message));
  }
  return pool;
}

/** 真正的连通性探测：光看 DATABASE_URL 是否存在不够，本机可能没起服务。 */
export async function probePostgres() {
  const p = getPool();
  if (!p) return { ok: false, reason: "DATABASE_URL 未配置" };
  try {
    const { rows } = await p.query("SELECT 1 AS ok, current_database() AS db");
    return { ok: true, db: rows[0].db };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function execSqlFile(sql) {
  const p = getPool();
  if (!p) throw new Error("未配置 DATABASE_URL，无法执行建表脚本");
  await p.query(sql);
}

export async function closePool() {
  if (pool) await pool.end();
  pool = undefined;
}
