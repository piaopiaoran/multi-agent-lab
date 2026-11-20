import { AIMessage } from "@langchain/core/messages";
import { config } from "../config.js";

/**
 * 可复现的离线模型。故意做成「duck typing」而不是继承 BaseChatModel：
 * 只实现项目真正用到的三个能力 invoke / bindTools / withStructuredOutput，
 * 这样 mock 模式完全不依赖 LangChain 内部类，版本升级不会把 demo 跑挂。
 *
 * 行为设计的目的：让「工具调用 → ToolNode → 再推理」这个 ReAct 循环、
 * 以及「supervisor 路由 → worker 回传 → 再路由」这个多 Agent 循环真实发生，
 * 而不是打印几行假日志。
 */

const lastText = (messages) => {
  const last = [...messages].reverse().find((m) => typeof m?.content === "string" && m.content.trim());
  return last?.content ?? "";
};

/** 原始用户问题：worker 越靠后，「最后一条文本」越是上游结论，引用它会串台 */
const firstHumanText = (messages) => {
  const hit = messages.find((m) => m?._getType?.() === "human" || m?.type === "human");
  return typeof hit?.content === "string" ? hit.content : "";
};

const namesIn = (messages) => new Set(messages.map((m) => m?.name).filter(Boolean));
const hasToolMessage = (messages) => messages.some((m) => m?._getType?.() === "tool" || m?.type === "tool");

/** 稳定哈希 → 归一化向量。字面重合越多，余弦相似度越高，便于离线验证 RAG 排序。 */
export function hashEmbedding(text) {
  const dim = config.embedding.dim;
  const vector = new Array(dim).fill(0);
  const tokens = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    let h = 2166136261;
    for (const ch of token) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    vector[Math.abs(h) % dim] += 1;
    // 加一个 bigram 桶，缓解纯 unigram 对中文短语不敏感的问题
    for (let i = 0; i < token.length - 1; i += 1) {
      const pair = token.slice(i, i + 2);
      let p = 5381;
      for (const ch of pair) p = Math.imul(p ^ ch.codePointAt(0), 33);
      vector[Math.abs(p) % dim] += 0.5;
    }
  }
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}

export class MockEmbeddings {
  async embedDocuments(texts) {
    return texts.map(hashEmbedding);
  }
  async embedQuery(text) {
    return hashEmbedding(text);
  }
}

/**
 * 结构化输出适配器：模拟 supervisor 的路由决策。
 * 依据「消息里已经出现过哪些 agent 的署名」推进流水线，
 * 与真实 supervisor 的 prompt 契约保持一致（改提示词时两边一起改）。
 */
class MockStructuredRouter {
  constructor(sequence) {
    this.sequence = sequence;
  }
  async invoke(messages) {
    const names = namesIn(messages);
    const done = this.sequence.filter((n) => names.has(n));
    const nextAgent = this.sequence[done.length];
    return {
      next: nextAgent ?? "FINISH",
      reason: nextAgent
        ? `已完成 ${done.join("→") || "无"}，按流水线交给 ${nextAgent}`
        : "所有子任务均已产出，收敛为最终答案",
    };
  }
}

export class MockChatModel {
  constructor({ agentName = "generic", tools = [], routeSequence = [] } = {}) {
    this.agentName = agentName;
    this.tools = tools;
    this.routeSequence = routeSequence;
  }

  bindTools(tools) {
    return new MockChatModel({ agentName: this.agentName, tools, routeSequence: this.routeSequence });
  }

  withStructuredOutput(_schema) {
    // zod schema 只用于真实模型做校验；mock 直接按约定返回同形状对象
    return new MockStructuredRouter(this.routeSequence);
  }

  async invoke(messages) {
    const text = lastText(messages);
    const task = firstHumanText(messages) || text;
    const toolSeen = hasToolMessage(messages);

    // ---- worker：第一次推理先调工具，看到 ToolMessage 后才给结论 ----
    if (this.agentName === "researcher" && !toolSeen) {
      return new AIMessage({
        content: "",
        name: "researcher",
        tool_calls: [
          {
            id: `call_rag_${Math.abs(hashCode(text)) % 100000}`,
            name: "rag_search",
            args: { query: text.slice(0, 120) || "多 Agent 架构" },
            type: "tool_call",
          },
        ],
      });
    }
    if (this.agentName === "analyst" && !toolSeen) {
      return new AIMessage({
        content: "",
        name: "analyst",
        tool_calls: [
          {
            id: `call_calc_${Math.abs(hashCode(text)) % 100000}`,
            name: "calculator",
            args: { expression: "3 * 0.8 + 2 * 0.2" },
            type: "tool_call",
          },
        ],
      });
    }

    const toolOutput = [...messages].reverse()
      .find((m) => m?._getType?.() === "tool" || m?.type === "tool")?.content ?? "";
    const evidence = truncate(String(toolOutput).replace(/\s+/g, " "), 90);

    const outputs = {
      researcher: `【检索结论】针对「${truncate(task)}」，rag_search 命中：${evidence} 据此整理要点：Supervisor 负责路由、Worker 负责执行、checkpointer 负责状态快照、pgvector 负责语义召回。`,
      analyst: `【分析结论】对上游材料做结构化拆解：中心化路由可控性强但 supervisor 是瓶颈；去中心化 handoff 延迟低但易循环；并行扇出省时延、费 token。综合评分 2.8 / 4。`,
      writer: `【最终答复】关于「${truncate(task)}」：建议以 Supervisor 星型拓扑为主链路，用 thread_id + PostgresSaver 保证多轮与断点续跑，用 pgvector 承载 RAG 与长期记忆，并以 maxIterations / 路由去重作为兜底防死循环。\n（本回答由 researcher → analyst → writer 三个 Agent 协作生成）`,
    };

    return new AIMessage({
      content: outputs[this.agentName] ?? `【${this.agentName}】已处理：${truncate(text)}`,
      name: this.agentName,
    });
  }
}

function hashCode(s) {
  let h = 0;
  for (const ch of String(s)) h = Math.imul(31, h) + ch.codePointAt(0) | 0;
  return h;
}

function truncate(s, n = 60) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
