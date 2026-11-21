import { describeConfig, loadConfig } from "./config/env.js";
import { printLangSmithHint } from "./observability/langsmith.js";
import { DEFAULT_QUESTION, runSession } from "./run.js";

const HELP = `
中心化 Supervisor 多 Agent Demo（LangChain.js + LangGraph.js + pgvector + LangSmith）

用法：
  npm start -- [选项]

选项：
  -q, --question <text>   自定义任务（默认是一道多 Agent 架构面试题）
      --provider <name>   覆盖 LLM_PROVIDER：fake | openai
      --storage <name>    覆盖 STORAGE_BACKEND：memory | postgres
      --checkpointer <n>  覆盖 CHECKPOINTER：memory | postgres
      --thread <id>       指定 thread_id（Checkpointer 会话隔离键）
      --no-trace          本次运行不上报 LangSmith
  -h, --help              显示帮助

常用示例：
  npm start -- --provider fake                    # 零密钥零成本跑通完整链路
  npm start                                       # 使用 .env 中的 DeepSeek 真实模型
  npm start -- -q "对比 Supervisor 和 Swarm 的取舍"
  npm start -- --storage postgres --checkpointer postgres   # 需先 npm run db:up
`;

function parseArgs(argv) {
  const keyMap = {
    "-q": "question",
    "--question": "question",
    "--provider": "provider",
    "--storage": "storage",
    "--checkpointer": "checkpointer",
    "--thread": "thread",
  };
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--no-trace") out.noTrace = true;
    else if (keyMap[arg]) out[keyMap[arg]] = argv[++i] ?? "";
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.noTrace) process.env.LANGSMITH_TRACING = "false";

const cfg = loadConfig({
  provider: args.provider,
  storage: args.storage,
  checkpointer: args.checkpointer,
});
const question = args.question || DEFAULT_QUESTION;
const workerNames = new Set(["researcher", "analyst", "writer"]);

console.log("=== 运行配置 ===");
console.log(describeConfig(cfg));
console.log(`\n=== 任务 ===\n${question}`);

try {
  const result = await runSession({ cfg, question, threadId: args.thread });

  console.log("\n=== 路由轨迹（Supervisor 决策）===");
  for (const line of result.trace) console.log(`  ${line}`);

  console.log("\n=== 各 Worker 产出 ===");
  for (const message of result.messages) {
    if (workerNames.has(message?.name)) {
      console.log(`\n--- [${message.name}] ---\n${message.content}`);
    }
  }

  console.log("\n=== 最终答案 ===");
  console.log(result.finalAnswer);

  console.log("\n=== 收尾信息 ===");
  console.log(
    `已访问 Worker: ${result.visited.join(" -> ") || "无"} | 轮次: ${result.rounds} | ` +
      `thread_id: ${result.threadId} | 后端: vector=${result.backends.vector}, checkpointer=${result.backends.checkpointer}`,
  );
  console.log(printLangSmithHint(cfg));
} catch (error) {
  console.error("\n运行失败：", error?.message || error);
  console.error(
    "排查建议：fake 档零依赖；openai 档检查 LLM_BASE_URL / LLM_MODEL / 网络与超时；" +
      "postgres 档先执行 npm run db:up。",
  );
  process.exitCode = 1;
}
