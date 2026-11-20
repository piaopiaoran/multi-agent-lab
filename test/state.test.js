import test from "node:test";
import assert from "node:assert/strict";
import { END } from "@langchain/langgraph";
import { routeFromSupervisor } from "../src/graphs/state.js";
import { normalizeDecision } from "../src/agents/supervisor.js";

test("路由：合法成员原样转发", () => {
  const route = routeFromSupervisor();
  assert.equal(route({ next: "researcher", completedAgents: [] }), "researcher");
  assert.equal(route({ next: "analyst", completedAgents: ["researcher"] }), "analyst");
});

test("路由：FINISH / 非法节点 / 已调度过的成员一律收敛到 END", () => {
  const route = routeFromSupervisor();
  assert.equal(route({ next: "FINISH", completedAgents: [] }), END);
  assert.equal(route({ next: "__proto__", completedAgents: [] }), END);
  assert.equal(route({ next: "researcher", completedAgents: ["researcher"] }), END);
});

test("决策归一化：重复调度自动改派到下一个未完成成员", () => {
  const d = normalizeDecision(
    { next: "researcher", reason: "我忘了做过没" },
    { completedAgents: ["researcher"], iteration: 1 },
  );
  assert.equal(d.next, "analyst");
});

test("决策归一化：幻觉出的节点名被白名单拦截", () => {
  const d = normalizeDecision({ next: "hacker", reason: "" }, { completedAgents: [], iteration: 0 });
  assert.equal(d.next, "FINISH");
});

test("决策归一化：达到迭代上限强制收敛", () => {
  const d = normalizeDecision(
    { next: "writer", reason: "" },
    { completedAgents: ["researcher", "analyst"], iteration: 12 },
    { maxIterations: 12 },
  );
  assert.equal(d.next, "FINISH");
  assert.match(d.reason, /最大迭代/);
});

test("决策归一化：全部完成后收敛", () => {
  const d = normalizeDecision(
    { next: "writer", reason: "" },
    { completedAgents: ["researcher", "analyst", "writer"], iteration: 3 },
  );
  assert.equal(d.next, "FINISH");
});

test("决策归一化：拦截模型「虚假完成」的提前 FINISH", () => {
  const d = normalizeDecision(
    { next: "FINISH", reason: "researcher、analyst、writer 均已完成" },
    { completedAgents: ["researcher"], iteration: 1 },
  );
  assert.equal(d.next, "analyst");
  assert.match(d.reason, /拦截提前收敛/);
});
