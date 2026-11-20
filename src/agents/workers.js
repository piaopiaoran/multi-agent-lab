import { StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { getChatModel } from "../llm/factory.js";
import { toolsFor } from "../tools/index.js";
import { WORKER_SYSTEM, systemMessage } from "./prompts.js";
import { buildMemoryContext } from "../memory/long-term.js";
import { recordEvent } from "../memory/observability.js";
import { lastUserText } from "../graphs/state.js";
import { makeLogger } from "../config.js";

const log = makeLogger("worker");

/** 最小权限：每个 Agent 只拿自己需要的工具，减少误调用与提示词膨胀 */
const WORKER_SPEC = Object.freeze({
  researcher: ["rag_search", "save_memory"],
  analyst: ["calculator", "rag_search"],
  writer: [],
});

function withName(message, name) {
  // 强制署名：supervisor 靠 AIMessage.name 判断「谁已经交卷」
  return new AIMessage({
    content: message.content ?? "",
    name,
    tool_calls: message.tool_calls ?? [],
    additional_kwargs: message.additional_kwargs ?? {},
    response_metadata: message.response_metadata ?? {},
    id: message.id,
  });
}

/**
 * 手写 ReAct 子图（没有用 createReactAgent，面试时能讲清每一步）：
 *   START → agent →(有 tool_calls?)→ tools → agent → … → END
 * ToolNode 负责把 tool_calls 变成 ToolMessage；条件函数就是 «tools_condition» 的手写版。
 */
function buildReActSubgraph(name, tools) {
  const bound = tools.length
    ? getChatModel({ agentName: name }).bindTools(tools)
    : getChatModel({ agentName: name });

  const builder = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state) => {
      const ai = await bound.invoke([systemMessage(WORKER_SYSTEM[name]), ...state.messages]);
      log.debug("agent invoke", { name, toolCalls: ai.tool_calls?.length ?? 0 });
      return { messages: [withName(ai, name)] };
    })
    .addEdge(START, "agent");

  if (tools.length > 0) {
    builder
      .addNode("tools", new ToolNode(tools))
      .addConditionalEdges(
        "agent",
        (state) => (state.messages.at(-1)?.tool_calls?.length ? "tools" : END),
        { tools: "tools", [END]: END },
      )
      .addEdge("tools", "agent");
  }
  return builder.compile();
}

function pickFinalAnswer(delta) {
  const finals = delta.filter(
    (m) => (m?._getType?.() === "ai" || m?.type === "ai") && !m.tool_calls?.length,
  );
  return finals.length ? [finals.at(-1)] : delta.slice(-1);
}

/**
 * Worker 节点 = 「子图 + 上下文边界」。
 *
 * outputMode（重要的工程取舍）：
 *  - summary（默认）：只把子图的最终结论回传主图，工具调用中间轨迹留在子图里。
 *    优点：主图/Supervisor 上下文不膨胀、成本可控、彼此不污染；缺点：丢失过程细节。
 *  - full：把整条轨迹回传，便于调试与审计，但多轮后 token 会线性增长。
 * 真实系统里通常再叠一层「摘要/裁剪」节点，这里用开关把问题显式化。
 */
export function createWorkerNode(name, { outputMode = "summary", traceGraph = "supervisor" } = {}) {
  const subgraph = buildReActSubgraph(name, toolsFor(WORKER_SPEC[name] ?? []));

  return async (state, config) => {
    const threadId = config?.configurable?.thread_id ?? "default";
    const namespace = config?.configurable?.namespace ?? state.namespace ?? "default";
    await recordEvent({
      threadId, graph: traceGraph, node: name, event: "enter",
      payload: { iteration: state.iteration, outputMode },
    });

    // L3 长期记忆只在 researcher 入口注入一次，避免每个节点都重复塞上下文
    const memoryContext = name === "researcher"
      ? await buildMemoryContext(namespace, lastUserText(state.messages))
      : "";
    const seedMessages = memoryContext
      ? [new SystemMessage({ content: memoryContext }), ...state.messages]
      : [...state.messages];

    const result = await subgraph.invoke({ messages: seedMessages }, config);
    const delta = result.messages.slice(seedMessages.length);
    const outgoing = outputMode === "full" ? delta : pickFinalAnswer(delta);

    await recordEvent({
      threadId, graph: traceGraph, node: name, event: "leave",
      payload: { messagesOut: outgoing.length, iteration: state.iteration + 1 },
    });

    return {
      messages: outgoing,
      completedAgents: [name],
      activeAgent: name,
      iteration: 1,
      reason: `${name} 完成，产出 ${outgoing.length} 条消息`,
    };
  };
}

export { WORKER_SPEC };
