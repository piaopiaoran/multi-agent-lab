import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { similaritySearch } from "../memory/vector-store.js";
import { remember } from "../memory/long-term.js";
import { makeLogger } from "../config.js";

const log = makeLogger("tools");

/** 工具 1：pgvector 语义检索（RAG 的 Retrieval 环节） */
export const ragSearchTool = tool(
  async ({ query, k = 4, topic }) => {
    const hits = await similaritySearch(query, { k, filter: topic ? { topic } : {} });
    log.debug("rag_search", { query, hits: hits.length });
    if (hits.length === 0) return "知识库中无相关命中，请基于自身知识回答并说明不确定。";
    return hits
      .map((h, i) => `[${i + 1}] ${h.content}\n    source=${h.metadata?.source ?? "unknown"} topic=${h.metadata?.topic ?? "-"} score=${h.score.toFixed(3)}`)
      .join("\n\n");
  },
  {
    name: "rag_search",
    description: "从内部知识库做语义检索。需要事实依据、架构细节、项目约定时必须使用。",
    schema: z.object({
      query: z.string().describe("检索问题，尽量包含关键术语"),
      k: z.number().int().min(1).max(10).optional().describe("返回条数，默认 4"),
      topic: z.string().optional().describe("按 topic 过滤，可选"),
    }),
  },
);

/**
 * 工具 2：安全计算器。
 * 不用 eval / new Function —— 工具执行的是模型生成的字符串，
 * 直接求值等于把 RCE 入口交给模型，这是 Agent 安全题的标准答案之一。
 */
function safeEvaluate(input) {
  const expr = String(input).trim();
  // 字符白名单（不用正则字面量，避免字符类里的 / 被误当作正则结束符）
  const ALLOWED = "0123456789.()+-*/ \t\n";
  if ([...expr].some((ch) => !ALLOWED.includes(ch))) throw new Error("表达式含非法字符");
  const tokens = expr.match(/\d+(?:\.\d+)?|[()+\-*\/]/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function parseFactor() {
    const tok = take();
    if (tok === "-") return -parseFactor();
    if (tok === "(") {
      const value = parseExpr();
      if (take() !== ")") throw new Error("括号不匹配");
      return value;
    }
    if (tok === undefined || !/^\d/.test(tok)) throw new Error(`无法解析: ${tok}`);
    return Number(tok);
  }
  function parseTerm() {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = take();
      const rhs = parseFactor();
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  }
  function parseExpr() {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = take();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error("表达式未能完整解析");
  if (!Number.isFinite(result)) throw new Error("结果非有限数");
  // 收敛浮点尾差，避免把 2.8000000000000003 这种噪音喂回给模型
  return Number(result.toFixed(10));
}

export const calculatorTool = tool(
  async ({ expression }) => {
    try {
      return String(safeEvaluate(expression));
    } catch (err) {
      return `计算失败：${err.message}`;
    }
  },
  {
    name: "calculator",
    description: "四则运算求值，支持括号与负号。用于计算评分、比率、聚合数值。",
    schema: z.object({ expression: z.string().describe("如 (3*0.8 + 2*0.2)") }),
  },
);

/** 工具 3：写入 L3 长期语义记忆。namespace 优先取 graph 的 configurable */
export const saveMemoryTool = tool(
  async ({ content }, runtime) => {
    const namespace = runtime?.configurable?.namespace ?? "default";
    await remember(namespace, content, { source: "tool" });
    return `已记住（namespace=${namespace}）：${content}`;
  },
  {
    name: "save_memory",
    description: "把值得长期保留的用户偏好或事实写入长期记忆，供后续会话语义召回。",
    schema: z.object({ content: z.string().describe("要记住的一句话事实") }),
  },
);

export const ALL_TOOLS = [ragSearchTool, calculatorTool, saveMemoryTool];
export const TOOL_BY_NAME = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));
export const toolsFor = (names) => names.map((n) => TOOL_BY_NAME[n]).filter(Boolean);
