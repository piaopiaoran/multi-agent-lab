import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 显式指定路径：无论从哪个目录执行 npm scripts，都能读到项目根的 .env
loadDotenv({ path: path.join(ROOT, ".env"), quiet: true });

const asBool = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));
const asNumber = (v, fallback) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);

/**
 * auto 模式：有 key 就走真实模型，没 key 就走 mock。
 * 面试现场演示最怕「网络/额度/数据库」三连挂，所以离线可跑是硬要求。
 */
function resolveMode() {
  const raw = String(process.env.AGENT_MODE ?? "auto").toLowerCase();
  if (raw === "mock" || raw === "live") return raw;
  return process.env.OPENAI_API_KEY ? "live" : "mock";
}

export const config = Object.freeze({
  root: ROOT,
  mode: resolveMode(),
  strictPg: asBool(process.env.PG_STRICT),
  databaseUrl: process.env.DATABASE_URL ?? "",
  defaultGraph: process.env.DEFAULT_GRAPH ?? "supervisor",
  logLevel: process.env.LOG_LEVEL ?? "info",
  llm: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    temperature: asNumber(process.env.LLM_TEMPERATURE, 0),
    embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    dim: asNumber(process.env.EMBEDDING_DIM, 1536),
  },
});

export const isMock = config.mode === "mock";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/** 极简 logger：debug 级别用于打印图节点轨迹，方便面试时讲执行流 */
export function makeLogger(scope) {
  const emit = (level, ...args) => {
    if (LEVELS[level] >= threshold) {
      console[level === "debug" ? "log" : level](`[${level.toUpperCase()}] [${scope}]`, ...args);
    }
  };
  return {
    debug: (...a) => emit("debug", ...a),
    info: (...a) => emit("info", ...a),
    warn: (...a) => emit("warn", ...a),
    error: (...a) => emit("error", ...a),
  };
}

export const logger = makeLogger("app");

export function describeRuntime() {
  return {
    mode: config.mode,
    llmModel: isMock ? `mock-chat(${config.llm.model})` : config.llm.model,
    embeddingModel: isMock ? "mock-hash-embedding" : config.llm.embeddingModel,
    postgres: config.databaseUrl ? "configured (runtime fallback allowed)" : "not configured",
    defaultGraph: config.defaultGraph,
  };
}
