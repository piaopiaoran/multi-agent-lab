import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 显式指定路径：无论从哪个目录执行 npm scripts，都能读到项目根的 .env
loadDotenv({ path: path.join(ROOT, ".env"), quiet: true });

const asBool = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));
const asNumber = (v, fallback) => (Number.isFinite(Number(v)) && v !== "" && v !== undefined ? Number(v) : fallback);

// 主配置用 LLM_* 一套；OPENAI_* 是历史别名，老 .env 不用改也能跑
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "";

/**
 * 运行模式优先级：AGENT_MODE（运行时强制开关） > LLM_PROVIDER（配置文件） > 自动判断。
 * 单测 / CI 靠 AGENT_MODE=mock 强制离线，不会被 .env 里的真实供应商覆盖。
 *
 * fake  = 确定性本地应答（原 mock），零密钥零成本，用来跑通链路与测试
 * openai= OpenAI 兼容 /chat/completions（DeepSeek / 硅基流动 / OpenAI 都走这里）
 */
function resolveMode() {
  const override = String(process.env.AGENT_MODE ?? "").toLowerCase();
  if (override === "mock" || override === "live") return override;
  const provider = String(process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (provider === "fake") return "mock";
  if (provider === "openai") return "live";
  return LLM_API_KEY ? "live" : "mock";
}

/**
 * 供应商能力矩阵 —— 这是「接一个大模型」真正要处理的地方。
 * 协议都叫 OpenAI 兼容，但能力并不一致，实测（2026-11）：
 *   DeepSeek：chat ✅ / function calling ✅ / json_schema ❌ / 强制 tool_choice ❌ / embeddings ❌
 * 所以不能把 key 换掉就完事，结构化输出与向量化都要按能力分派。
 */
const CAPABILITIES = Object.freeze({
  deepseek: { structuredOutput: "json_object", hasEmbeddings: false },
  openai: { structuredOutput: "json_schema", hasEmbeddings: true },
  compatible: { structuredOutput: "json_object", hasEmbeddings: false },
});

function detectProvider(url) {
  const u = String(url ?? "").toLowerCase();
  if (u.includes("deepseek")) return "deepseek";
  if (u.includes("api.openai.com") || u === "") return "openai";
  return "compatible";
}

const provider = detectProvider(LLM_BASE_URL);
const capabilities = CAPABILITIES[provider];

/** embedding 独立配置：chat 网关没有 /embeddings 时自动降级为本地哈希向量 */
function resolveEmbeddingProvider(mode) {
  const explicit = String(process.env.EMBEDDING_PROVIDER ?? "").toLowerCase();
  if (explicit === "fake") return "mock";
  if (explicit === "mock" || explicit === "openai") return explicit;
  if (mode === "mock") return "mock";
  if (process.env.EMBEDDING_API_KEY) return "openai";
  // 只有确认是 OpenAI 官方端点才复用 chat key；DeepSeek 等一律走本地降级
  return capabilities.hasEmbeddings && provider === "openai" && LLM_API_KEY ? "openai" : "mock";
}

const mode = resolveMode();
const embeddingProvider = resolveEmbeddingProvider(mode);

export const config = Object.freeze({
  root: ROOT,
  mode,
  strictPg: asBool(process.env.PG_STRICT),
  databaseUrl: process.env.DATABASE_URL ?? "",
  defaultGraph: process.env.DEFAULT_GRAPH ?? "supervisor",
  logLevel: process.env.LOG_LEVEL ?? "info",
  llm: {
    provider,
    apiKey: LLM_API_KEY,
    baseURL: LLM_BASE_URL || undefined,
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    temperature: asNumber(process.env.LLM_TEMPERATURE, 0),
    timeoutMs: asNumber(process.env.LLM_TIMEOUT_MS, 20000),
    maxRetries: asNumber(process.env.LLM_MAX_RETRIES, 2),
    // 可显式覆盖：json_schema（OpenAI 原生严格模式）| json_object（兼容网关）
    structuredOutput: String(
      process.env.LLM_STRUCTURED_OUTPUT ?? capabilities.structuredOutput,
    ).toLowerCase(),
    // DeepSeek 默认开 thinking：响应带 reasoning_content，且要求多轮里原样回传，
    // 否则报 400。LangChain 的 AIMessage→OpenAI converter 不会回写这个字段，
    // 因此 ReAct 的第二次 invoke 必挂。默认对 DeepSeek 关闭 thinking。
    disableThinking: asBool(
      process.env.LLM_DISABLE_THINKING ?? (provider === "deepseek" ? "true" : "false"),
    ),
  },
  embedding: {
    provider: embeddingProvider,
    apiKey: process.env.EMBEDDING_API_KEY ?? (embeddingProvider === "openai" ? LLM_API_KEY : ""),
    baseURL: process.env.EMBEDDING_BASE_URL ?? (embeddingProvider === "openai" ? LLM_BASE_URL : ""),
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
    // 必须与 db/schema.sql 里的 vector(N) 一致；换 embedding 模型要同时改列与 HNSW 索引
    dim: asNumber(process.env.EMBEDDING_DIM, 1536),
  },
  langsmith: {
    tracing: asBool(process.env.LANGSMITH_TRACING),
    apiKey: process.env.LANGSMITH_API_KEY ?? "",
    project: process.env.LANGSMITH_PROJECT ?? "default",
    endpoint: process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
    background: asBool(process.env.LANGCHAIN_CALLBACKS_BACKGROUND),
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
  // 只暴露供应商/模型/端点，绝不把任何 API key 打印到日志或 HTTP 响应里
  return {
    mode: config.mode,
    llm: isMock
      ? { provider: "fake", model: "deterministic-local-chat" }
      : {
          provider: config.llm.provider,
          model: config.llm.model,
          baseURL: config.llm.baseURL ?? "(default)",
          structuredOutput: config.llm.structuredOutput,
          timeoutMs: config.llm.timeoutMs,
        },
    embedding: config.embedding.provider === "mock"
      ? { provider: "fake", model: "local-hash-embedding", dim: config.embedding.dim }
      : { provider: "openai", model: config.embedding.model, dim: config.embedding.dim },
    postgres: config.databaseUrl ? "configured (runtime fallback allowed)" : "not configured",
    defaultGraph: config.defaultGraph,
    langsmith: {
      enabled: config.langsmith.tracing && Boolean(config.langsmith.apiKey),
      project: config.langsmith.project,
      endpoint: config.langsmith.endpoint,
      keyConfigured: Boolean(config.langsmith.apiKey),
    },
  };
}
