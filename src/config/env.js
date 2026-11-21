import dotenv from "dotenv";
import process from "node:process";

// 顶层立即加载 .env：ESM 的依赖模块先于本模块主体执行，
// 因此任何静态 import 进来的模块在首次调用前，环境变量都已就绪。
dotenv.config();

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return fallback;
}

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback = "") {
  return value === undefined || value === "" ? fallback : String(value);
}

/** 只用于打印，绝不把完整密钥写进日志 / trace metadata。 */
export function maskSecret(value) {
  if (!value) return "(未配置)";
  const s = String(value);
  if (s.length <= 12) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

/**
 * LangSmith 接入点。
 *
 * LangChain.js 在「每次 run 时」读取这些环境变量，而不是模块加载时缓存，
 * 所以只要在第一次 LLM 调用前设置即可。这里同时写新旧两套变量名，
 * 兼容不同版本的 @langchain/core tracer。
 *
 * 关键点：真实密钥只从 .env 读取，代码 / 文档 / trace metadata 里不出现。
 */
export function configureLangSmith() {
  const key =
    str(process.env.LANGSMITH_API_KEY) || str(process.env.LANGCHAIN_API_KEY);
  // LANGSMITH_TRACING 优先；只有它未配置时才退回旧变量。
  // 不能写成 OR：否则 --no-trace 会被上一次调用写入的
  // LANGCHAIN_TRACING_V2=true 重新打开。
  const rawTracing = process.env.LANGSMITH_TRACING;
  const requested =
    rawTracing !== undefined && rawTracing !== ""
      ? bool(rawTracing, false)
      : bool(process.env.LANGCHAIN_TRACING_V2, false);
  const enabled = Boolean(key) && requested;
  const project = str(
    process.env.LANGSMITH_PROJECT || process.env.LANGCHAIN_PROJECT,
    "multi-agent-supervisor-demo",
  );
  const endpoint = str(process.env.LANGSMITH_ENDPOINT);

  if (enabled) {
    process.env.LANGSMITH_API_KEY = key;
    process.env.LANGCHAIN_API_KEY = key;
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGSMITH_PROJECT = project;
    process.env.LANGCHAIN_PROJECT = project;
    if (endpoint) {
      process.env.LANGSMITH_ENDPOINT = endpoint;
      process.env.LANGCHAIN_ENDPOINT = endpoint;
    }
  } else {
    // 彻底关闭，避免无密钥时 tracer 反复重试或测试环境产生网络噪音
    for (const name of [
      "LANGSMITH_TRACING",
      "LANGCHAIN_TRACING_V2",
      "LANGCHAIN_TRACING",
      "LANGSMITH_API_KEY",
      "LANGCHAIN_API_KEY",
    ]) {
      delete process.env[name];
    }
  }

  return { enabled, project, endpoint, keyMasked: maskSecret(key) };
}

// 注意：这里刻意「不在模块顶层」执行 configureLangSmith。
// LangChain.js 的 tracer 在每次 run 时动态读取环境变量，
// 由 loadConfig() 统一调用一次即可；若顶层先跑，CLI 的 --no-trace
// 会在 import 提升阶段就被覆盖，配置失去可覆盖性。

const PROVIDERS = new Set(["fake", "openai"]);
const BACKENDS = new Set(["memory", "postgres"]);

/**
 * 集中式配置加载 + 校验。
 * overrides 用于 CLI 参数 / 测试注入（例如 --provider fake）。
 */
export function loadConfig(overrides = {}) {
  const langsmith = configureLangSmith();

  const cfg = {
    llm: {
      provider: str(overrides.provider || process.env.LLM_PROVIDER, "fake").toLowerCase(),
      baseURL: str(process.env.LLM_BASE_URL, "https://api.deepseek.com/v1"),
      apiKey: str(process.env.LLM_API_KEY),
      model: str(process.env.LLM_MODEL, "deepseek-chat"),
      thinking: str(process.env.LLM_THINKING, "disabled").toLowerCase(),
      temperature: num(process.env.LLM_TEMPERATURE, 0.2),
      timeoutMs: num(process.env.LLM_TIMEOUT_MS, 20000),
    },
    embeddings: {
      provider: str(process.env.EMBEDDINGS_PROVIDER, "fake").toLowerCase(),
      baseURL: str(process.env.EMBEDDINGS_BASE_URL),
      apiKey: str(process.env.EMBEDDINGS_API_KEY),
      model: str(process.env.EMBEDDINGS_MODEL, "text-embedding-3-small"),
      dim: num(process.env.EMBEDDINGS_DIM, 1536),
    },
    storage: {
      backend: str(
        overrides.storage || process.env.STORAGE_BACKEND,
        "memory",
      ).toLowerCase(),
      checkpointer: str(
        overrides.checkpointer || process.env.CHECKPOINTER,
        "memory",
      ).toLowerCase(),
      databaseUrl: str(
        process.env.DATABASE_URL,
        "postgresql://postgres:postgres@localhost:5432/supervisor_demo",
      ),
      table: str(process.env.PGVECTOR_TABLE, "documents"),
      checkpointPrefix: str(process.env.CHECKPOINT_TABLE_PREFIX, "supervisor_ckpt"),
    },
    graph: {
      maxRounds: num(process.env.MAX_ROUNDS, 8),
      maxToolIterations: num(process.env.MAX_TOOL_ITERATIONS, 4),
    },
    langsmith,
  };

  validate(cfg);
  return cfg;
}

function validate(cfg) {
  if (!PROVIDERS.has(cfg.llm.provider)) {
    throw new Error(`LLM_PROVIDER 只支持 fake | openai，当前为 ${cfg.llm.provider}`);
  }
  if (!new Set(["disabled", "enabled"]).has(cfg.llm.thinking)) {
    throw new Error(`LLM_THINKING 只支持 disabled | enabled，当前为 ${cfg.llm.thinking}`);
  }
  if (!PROVIDERS.has(cfg.embeddings.provider)) {
    throw new Error(`EMBEDDINGS_PROVIDER 只支持 fake | openai，当前为 ${cfg.embeddings.provider}`);
  }
  if (!BACKENDS.has(cfg.storage.backend)) {
    throw new Error(`STORAGE_BACKEND 只支持 memory | postgres，当前为 ${cfg.storage.backend}`);
  }
  if (!BACKENDS.has(cfg.storage.checkpointer)) {
    throw new Error(`CHECKPOINTER 只支持 memory | postgres，当前为 ${cfg.storage.checkpointer}`);
  }
  if (cfg.llm.provider === "openai") {
    for (const field of ["apiKey", "baseURL", "model"]) {
      if (!cfg.llm[field]) throw new Error(`LLM_PROVIDER=openai 时缺少 LLM 配置：${field}`);
    }
  }
  if (cfg.embeddings.provider === "openai") {
    for (const field of ["apiKey", "baseURL", "model"]) {
      if (!cfg.embeddings[field]) {
        throw new Error(`EMBEDDINGS_PROVIDER=openai 时缺少 embeddings 配置：${field}`);
      }
    }
  }
  if (
    (cfg.storage.backend === "postgres" || cfg.storage.checkpointer === "postgres") &&
    !cfg.storage.databaseUrl
  ) {
    throw new Error("postgres 档位需要 DATABASE_URL");
  }
  if (cfg.graph.maxRounds < 1 || cfg.graph.maxToolIterations < 1) {
    throw new Error("MAX_ROUNDS / MAX_TOOL_ITERATIONS 必须 >= 1");
  }
}

/** 打印用的脱敏配置摘要。 */
export function describeConfig(cfg) {
  return [
    cfg.llm.provider === "fake"
      ? "LLM        : fake（确定性本地应答，零密钥零成本）"
      : `LLM        : openai / ${cfg.llm.model} / thinking=${cfg.llm.thinking} / ${cfg.llm.baseURL} (key=${maskSecret(cfg.llm.apiKey)})`,
    `Embeddings : ${cfg.embeddings.provider} / ${cfg.embeddings.model} / dim=${cfg.embeddings.dim}`,
    `Storage    : vector=${cfg.storage.backend} / checkpointer=${cfg.storage.checkpointer}`,
    `LangSmith  : ${cfg.langsmith.enabled ? `ON  project=${cfg.langsmith.project} key=${cfg.langsmith.keyMasked}` : "OFF"}`,
    `Guardrails : maxRounds=${cfg.graph.maxRounds} / maxToolIterations=${cfg.graph.maxToolIterations}`,
  ].join("\n");
}
