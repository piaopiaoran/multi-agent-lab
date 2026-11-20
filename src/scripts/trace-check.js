import { listRecentRuns, langsmithInfo, isLangSmithEnabled } from "../tracing/langsmith.js";
import { describeRuntime } from "../config.js";

const info = langsmithInfo();
console.log("运行配置：", describeRuntime());

if (!isLangSmithEnabled()) {
  console.log("\n✗ LangSmith 未启用：请在 .env 设置 LANGSMITH_TRACING=true 与 LANGSMITH_API_KEY。");
  process.exit(0);
}

const result = await listRecentRuns(10);
if (result.error) {
  console.error("✗ 查询失败：", result.error);
  process.exit(1);
}
console.log(`\n✓ 项目 ${info.project}（找到 ${result.scanned ?? 0} 条顶层 run，isRoot 过滤）`);
if (result.runs.length === 0) {
  console.log("  暂无 multi-agent 顶层 run。先跑一次：npm run demo，LangSmith 索引有秒级延迟，稍后重试。");
} else {
  for (const r of result.runs) {
    console.log(`  ${String(r.start_time ?? "").slice(0, 19)}  ${r.name}  status=${r.status}  子 run=${r.child_count}  result=${r.result}`);
  }
}
console.log(`\n打开 ${info.console} → 项目 ${info.project} 查看完整 trace 树。`);
