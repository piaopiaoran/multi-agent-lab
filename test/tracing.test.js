import test from "node:test";
import assert from "node:assert/strict";

// 单测一律不联网：先关掉 tracing，再加载会读取 .env 的模块
process.env.LANGSMITH_TRACING = "false";

const { isLangSmithEnabled, langsmithInfo, traceGraphRun, listRecentRuns } =
  await import("../src/tracing/langsmith.js");

test("未启用时透传业务结果，且不产生任何上报", async () => {
  assert.equal(isLangSmithEnabled(), false);
  const result = await traceGraphRun({
    graphName: "supervisor", threadId: "t", namespace: "n", question: "q",
    run: async () => ({ ok: 1 }),
  });
  assert.deepEqual(result, { ok: 1 });
  assert.deepEqual(await listRecentRuns(1), { enabled: false, runs: [] });
});

test("观测信息脱敏：不含 API key", () => {
  const info = langsmithInfo();
  assert.ok(!("apiKey" in info));
  assert.ok(!JSON.stringify(info).includes("lsv2_pt_"));
});
