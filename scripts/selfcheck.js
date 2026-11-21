import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConfig, loadConfig } from "../src/config/env.js";

/**
 * 交付前自检：配置是否正确、依赖是否可用、真实密钥是否泄漏到将要提交的文件里。
 *
 *   node scripts/selfcheck.js           # 本地自检（含密钥扫描）
 *   node scripts/selfcheck.js --live    # 额外打一次真实 LLM，验证外网链路
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".workbuddy", "dist", "coverage"]);
const SKIP_FILES = new Set([".env", "package-lock.json"]); // .env 本身就是密钥存放处

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && !SKIP_FILES.has(entry.name)) acc.push(full);
  }
  return acc;
}

function realSecretsFromDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return [];
  return fs
    .readFileSync(envPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD)=/i.test(line))
    .map((line) => line.slice(line.indexOf("=") + 1).trim())
    .filter((value) => value.length >= 8 && !value.includes("xxxx"));
}

function scanForLeakedSecrets() {
  const secrets = realSecretsFromDotEnv();
  const files = walk(ROOT);
  const leaks = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const secret of secrets) {
      if (content.includes(secret)) {
        leaks.push(`${path.relative(ROOT, file)} => ${secret.slice(0, 6)}...`);
      }
    }
  }
  return { scanned: files.length, secrets: secrets.length, leaks };
}

const cfg = loadConfig();
console.log("=== 配置（已脱敏）===");
console.log(describeConfig(cfg));

const core = await import("@langchain/core/messages");
const graph = await import("@langchain/langgraph");
const openai = await import("@langchain/openai");
const pgSaver = await import("@langchain/langgraph-checkpoint-postgres");
console.log("\n=== 依赖导出检查 ===");
console.log(
  `  AIMessage=${typeof core.AIMessage} StateGraph=${typeof graph.StateGraph} ` +
    `MessagesAnnotation=${typeof graph.MessagesAnnotation} MemorySaver=${typeof graph.MemorySaver} ` +
    `ChatOpenAI=${typeof openai.ChatOpenAI} PostgresSaver=${typeof pgSaver.PostgresSaver}`,
);

const scan = scanForLeakedSecrets();
console.log("\n=== 密钥泄漏扫描 ===");
console.log(
  `  扫描 ${scan.scanned} 个文件 / ${scan.secrets} 个真实密钥；` +
    (scan.leaks.length ? `发现 ${scan.leaks.length} 处泄漏` : "未发现泄漏 ✓"),
);
for (const leak of scan.leaks) console.log(`  !! ${leak}`);

if (process.argv.includes("--live")) {
  console.log("\n=== 真实 LLM 连通性 ===");
  const { createLLM } = await import("../src/llm/factory.js");
  const { HumanMessage } = await import("@langchain/core/messages");
  try {
    const llm = createLLM(cfg);
    const reply = await llm.invoke([new HumanMessage("只回复 OK 两个字母")]);
    console.log(`  ${cfg.llm.model} -> ${String(reply.content).slice(0, 80)}`);
  } catch (error) {
    console.log(`  失败：${error.message}`);
    console.log("  提示：若报 model not found，把 LLM_MODEL 改成 deepseek-chat；推理模型可适当调大 LLM_TIMEOUT_MS。");
    process.exitCode = 1;
  }
}

if (scan.leaks.length) process.exitCode = 1;
