import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { WORKER_NAMES } from "./state.js";

/**
 * 共享工具集。工具是 Worker 与外部世界交互的唯一出口，
 * retrieve_knowledge 把 pgvector / 内存向量库接进了 Agent 链路。
 */
export function createTools(store) {
  const retrieveKnowledge = tool(
    async ({ query, topK = 3 }) => {
      const k = Math.min(Math.max(Number(topK) || 3, 1), 8);
      const hits = await store.similaritySearchWithScore(query, k);
      if (!hits.length) return "知识库中未检索到相关内容。";
      return hits
        .map(
          ([doc, score], i) =>
            `[${i + 1}] score=${Number(score).toFixed(4)} id=${doc.id ?? "-"} topic=${doc.metadata?.topic ?? "-"}\n${doc.pageContent}`,
        )
        .join("\n\n");
    },
    {
      name: "retrieve_knowledge",
      description:
        "从知识库检索与问题相关的资料片段（底层为 pgvector 或内存向量库），返回带相似度分数的内容。需要先查资料时调用。",
      schema: z.object({
        query: z.string().describe("检索关键词或问题原文"),
        topK: z.number().int().min(1).max(8).optional().describe("返回条数，默认 3"),
      }),
    },
  );

  const calculate = tool(
    async ({ expression }) => {
      // 安全：字符集白名单里不含任何字母、引号、分号，无法构造标识符或注入代码。
      // 生产环境仍建议换成真正的表达式解析器 / 沙箱，这里为教学保留最小实现。
      if (!/^[\d\s+\-*/().]+$/.test(expression) || !/\d/.test(expression)) {
        return "错误：只允许纯数字与 + - * / ( ) 组成的算术表达式";
      }
      try {
        const value = Function(`"use strict"; return (${expression});`)();
        if (!Number.isFinite(value)) return "错误：结果不是有限数字";
        return `${expression} = ${value}`;
      } catch (error) {
        return `计算失败：${error.message}`;
      }
    },
    {
      name: "calculate",
      description: "计算一个纯算术表达式（不支持变量、函数与字符串）。",
      schema: z.object({
        expression: z.string().describe("例如 (12 + 8) * 3 / 4"),
      }),
    },
  );

  const getCurrentTime = tool(
    async () => new Date().toISOString(),
    {
      name: "get_current_time",
      description: "获取当前的 UTC 时间（ISO 8601）。",
      schema: z.object({}),
    },
  );

  // Supervisor 的「结构化输出」用 function calling 实现：
  // 让模型必须调用 route 工具，就能拿到可校验的路由决策，而不是解析自由文本。
  const route = tool(
    async (args) => JSON.stringify(args),
    {
      name: "route",
      description:
        "选择下一个要执行的 Worker；当答案已经完备时选择 FINISH。每次决策必须调用本工具，不要用自然语言回答。",
      schema: z.object({
        next: z
          .enum([...WORKER_NAMES, "FINISH"])
          .describe("下一个 Worker 名，或 FINISH 结束任务"),
        reason: z.string().describe("一句话说明为什么这样路由"),
        instruction: z.string().optional().describe("给下一个 Worker 的具体指令"),
      }),
    },
  );

  return {
    retrieve_knowledge: retrieveKnowledge,
    calculate,
    get_current_time: getCurrentTime,
    route,
    all: [retrieveKnowledge, calculate, getCurrentTime, route],
  };
}
