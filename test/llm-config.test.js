import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 配置推断在子进程里测：config.js 模块加载即读 .env 并冻结 config，
 * 同进程无法重复 import。子进程显式传 env 覆盖 .env，断言与本机密钥无关。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_URL = pathToFileURL(path.join(ROOT, "src/config.js")).href;
const PROBE = `
import { config, describeRuntime } from ${JSON.stringify(CONFIG_URL)};
console.log(JSON.stringify({
  mode: config.mode,
  provider: config.llm.provider,
  structuredOutput: config.llm.structuredOutput,
  disableThinking: config.llm.disableThinking,
  embeddingProvider: config.embedding.provider,
  runtime: describeRuntime(),
}));
`;

const CONFIG_KEYS = [
  "LLM_PROVIDER", "AGENT_MODE", "LLM_BASE_URL", "LLM_API_KEY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_STRUCTURED_OUTPUT",
  "LLM_DISABLE_THINKING", "EMBEDDING_PROVIDER", "EMBEDDING_API_KEY",
];

function probe(overrides) {
  const base = { ...process.env };
  for (const key of CONFIG_KEYS) delete base[key];
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    cwd: ROOT,
    env: { ...base, ...overrides },
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
}

const DEEPSEEK = {
  LLM_PROVIDER: "openai",
  LLM_BASE_URL: "https://api.deepseek.com/v1",
  LLM_API_KEY: "sk-probe-not-a-real-key",
};

test("LLM_PROVIDER=fake 强制离线，不发起任何模型请求", () => {
  const r = probe({ LLM_PROVIDER: "fake", LLM_API_KEY: "" });
  assert.equal(r.mode, "mock");
  assert.equal(r.runtime.mode, "mock");
  assert.equal(r.runtime.llm.provider, "fake");
});

test("DeepSeek 自动识别：json_object + 关闭 thinking + embedding 降级", () => {
  const r = probe({ ...DEEPSEEK, EMBEDDING_PROVIDER: "" });
  assert.equal(r.mode, "live");
  assert.equal(r.provider, "deepseek");
  assert.equal(r.structuredOutput, "json_object");
  assert.equal(r.disableThinking, true);
  // DeepSeek 没有 /embeddings，不能把 chat key 打到不存在的端点
  assert.equal(r.embeddingProvider, "mock");
});

test("AGENT_MODE 是运行时强制开关，优先级高于 .env 里的真实供应商", () => {
  const r = probe({ ...DEEPSEEK, AGENT_MODE: "mock" });
  assert.equal(r.mode, "mock");
});

test("OpenAI 官方端点走严格 json_schema，且复用 chat key 做真实 embedding", () => {
  const r = probe({
    LLM_PROVIDER: "openai",
    LLM_BASE_URL: "https://api.openai.com/v1",
    LLM_API_KEY: "sk-probe-not-a-real-key",
    EMBEDDING_PROVIDER: "",
  });
  assert.equal(r.provider, "openai");
  assert.equal(r.structuredOutput, "json_schema");
  assert.equal(r.disableThinking, false);
  assert.equal(r.embeddingProvider, "openai");
});

test("运行信息脱敏：不把 API key 写进日志或 HTTP 响应", () => {
  const r = probe(DEEPSEEK);
  assert.ok(!JSON.stringify(r.runtime).includes("sk-probe-not-a-real-key"));
  assert.ok(!("apiKey" in r.runtime.llm));
});
