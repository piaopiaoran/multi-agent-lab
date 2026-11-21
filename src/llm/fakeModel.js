import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";

/**
 * 确定性本地 ChatModel（LLM_PROVIDER=fake）。
 *
 * 为什么继承 BaseChatModel 而不是写一个 if/else 适配器：
 *  - 它仍然是一个标准 Runnable，能无缝进 LangGraph 节点、能 bindTools、
 *    能被 LangSmith 记录成一次真实的 LLM run；
 *  - 因此「零密钥零成本」下依然能跑通 supervisor 路由 → tool_calls →
 *    ToolMessage 回填 → worker 输出 → FINISH 的完整链路，而不是把链路短路掉。
 *
 * 语义质量会退化：它按固定规则应答，不做任何理解。仅用于链路验证 / 测试 / 断网演示。
 */

const WORKER_ORDER = ["researcher", "analyst", "writer"];
let callCounter = 0;
const nextCallId = () => `fake_call_${++callCounter}`;

function textOf(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join(" ");
  }
  return "";
}

function isToolMessage(message) {
  return message?.tool_call_id !== undefined || message?._getType?.() === "tool";
}

function detectRole(messages) {
  for (const message of messages) {
    const text = textOf(message);
    if (/\[SUPERVISOR\]/.test(text)) return { role: "supervisor" };
    const worker = text.match(/\[WORKER:([a-zA-Z_]+)\]/);
    if (worker) return { role: "worker", worker: worker[1] };
  }
  return { role: "generic" };
}

function firstHumanText(messages) {
  for (const message of messages) {
    if (message?._getType?.() === "human" || message?.constructor?.name === "HumanMessage") {
      return textOf(message);
    }
  }
  return "";
}

/** observation 里第一行是「用户任务：」，展示时去掉这层包装。 */
function taskText(messages) {
  return firstHumanText(messages).replace(/^用户任务：\s*/, "").split("\n\n")[0].trim();
}

function fakeToolArgs(toolName, messages) {
  switch (toolName) {
    case "retrieve_knowledge":
      return { query: taskText(messages).slice(0, 120) || "Supervisor 架构", topK: 3 };
    case "calculate":
      return { expression: "2 * 3 + 4" };
    case "get_current_time":
      return {};
    case "route":
      return { next: "FINISH", reason: "[fake] 兜底结束" };
    default:
      return {};
  }
}

function collectToolResults(messages) {
  return messages.filter(isToolMessage).map(textOf).filter(Boolean).join("\n");
}

/** 从 observation HumanMessage 里抽回各 Worker 的产出摘要（Worker 产出已被折叠）。 */
function workerOutputsFromObservation(worker, messages) {
  const text = firstHumanText(messages);
  const lines = [];
  const pattern = /--- (researcher|analyst|writer) ---\n([\s\S]*?)(?=\n\n--- |\n\n当前状态|\n\n\[VISITED:|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] === worker) continue;
    lines.push(`  · [${match[1]}] ${match[2].replace(/\s+/g, " ").trim().slice(0, 160)}`);
  }
  return lines.join("\n");
}

function workerFinalText(worker, messages) {
  const toolResults = collectToolResults(messages);
  const prior = workerOutputsFromObservation(worker, messages);

  if (worker === "writer") {
    return [
      "[fake:writer] 最终汇总（确定性应答，仅演示链路）",
      `任务：${taskText(messages).slice(0, 100)}`,
      prior ? `已完成的环节：\n${prior}` : "（尚无前置环节产出）",
      "结论：Supervisor 依次调度 researcher → analyst → writer，所有结果回到中心节点后判定 FINISH。",
      "换成 LLM_PROVIDER=openai 即可获得真实语义输出。",
    ].join("\n");
  }

  return [
    `[fake:${worker}] 已处理「${taskText(messages).slice(0, 60)}」`,
    toolResults ? `工具产出：\n${toolResults}` : "（本次未调用工具，直接基于上下文作答）",
    `产出：完成 ${worker} 环节，结果交回 Supervisor 决定下一步。`,
  ].join("\n");
}

function buildFakeReply(messages, boundTools) {
  const { role, worker } = detectRole(messages);
  const tools = boundTools || [];

  if (role === "supervisor") {
    // 优先读 Supervisor 注入的 [VISITED:...] 标记；
    // 早期版本/自定义调用没有该标记时，回退到扫描带 name 的 AIMessage。
    const tag = messages.map(textOf).join("\n").match(/\[VISITED:([^\]]*)\]/);
    const visited = new Set(
      tag
        ? tag[1].split(",").map((s) => s.trim()).filter(Boolean)
        : messages
            .filter((m) => m?.name && WORKER_ORDER.includes(m.name))
            .map((m) => m.name),
    );
    const next = WORKER_ORDER.find((n) => !visited.has(n)) ?? "FINISH";
    const routeTool = tools.find((t) => t.name === "route") ?? tools[0];
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          name: routeTool?.name ?? "route",
          args: {
            next,
            reason: `[fake] 已访问 {${[...visited].join(",")}}，按固定顺序选择 ${next}`,
            instruction: "",
          },
          id: nextCallId(),
          type: "tool_call",
        },
      ],
    });
  }

  if (role === "worker") {
    const hasToolResult = messages.some(isToolMessage);
    // 第一次进入：请求调用该 worker 的第一个工具；工具回填后：给出最终文本
    if (!hasToolResult && tools.length > 0) {
      const t = tools[0];
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            name: t.name,
            args: fakeToolArgs(t.name, messages),
            id: nextCallId(),
            type: "tool_call",
          },
        ],
      });
    }
    return new AIMessage({ content: workerFinalText(worker, messages) });
  }

  return new AIMessage("[fake] 已收到任务（确定性本地应答，语义质量会退化）。");
}

export class FakeChatModel extends BaseChatModel {
  constructor(fields = {}) {
    super(fields);
    this.boundTools = [];
  }

  _llmType() {
    return "fake-deterministic";
  }

  /**
   * BaseChatModel 在 LangChain.js 1.x 里没有默认 bindTools，必须自己实现。
   * 返回一个绑定了工具列表的新实例（仍是标准 Runnable）。
   */
  bindTools(tools) {
    const clone = new FakeChatModel({});
    clone.boundTools = Array.isArray(tools) ? tools : [];
    return clone;
  }

  async _generate(messages) {
    const message = buildFakeReply(messages, this.boundTools);
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ text, message }] };
  }
}
