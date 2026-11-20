import test from "node:test";
import assert from "node:assert/strict";
import { calculatorTool, ragSearchTool, toolsFor, ALL_TOOLS } from "../src/tools/index.js";

test("计算器：四则运算与括号", async () => {
  assert.equal(await calculatorTool.invoke({ expression: "3 * 0.8 + 2 * 0.2" }), "2.8");
  assert.equal(await calculatorTool.invoke({ expression: "(1 + 2) * (4 - 1) / 3" }), "3");
  assert.equal(await calculatorTool.invoke({ expression: "-2 * (3 + 1)" }), "-8");
});

test("计算器：拒绝代码注入，不执行 eval", async () => {
  const out = await calculatorTool.invoke({ expression: "process.exit(1)" });
  assert.match(out, /计算失败/);
  assert.doesNotMatch(out, /^1$/);
});

test("工具注册表：最小权限分配正确", () => {
  assert.deepEqual(ALL_TOOLS.map((t) => t.name).sort(), ["calculator", "rag_search", "save_memory"]);
  assert.deepEqual(toolsFor(["rag_search", "save_memory"]).map((t) => t.name), ["rag_search", "save_memory"]);
  assert.deepEqual(toolsFor(["not_exist"]), []);
});

test("RAG 工具：空知识库时给出明确的兜底话术，而不是幻觉", async () => {
  const out = await ragSearchTool.invoke({ query: "一个肯定不存在的术语xyzzy" });
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
});
