import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { buildObservationMessages } from "./context.js";
import { emit, EVT } from "./events.js";

/**
 * 三个专职 Worker。注意 system prompt 里的 [WORKER:xxx] 标记：
 * 真实 LLM 把它当作普通的角色说明；fake 模型用它识别当前角色并给出确定性应答。
 */
export const WORKER_SPECS = {
  researcher: {
    toolNames: ["retrieve_knowledge"],
    system:
      "[WORKER:researcher] 你是资料检索员。必须先调用 retrieve_knowledge 取回事实片段，再基于检索结果输出简短调研摘要。不要编造知识库之外的事实。",
  },
  analyst: {
    toolNames: ["calculate", "get_current_time"],
    system:
      "[WORKER:analyst] 你是分析员。结合前序资料做要点分析；需要数值核对时调用 calculate。输出条理清晰的结论。",
  },
  writer: {
    toolNames: [],
    system:
      "[WORKER:writer] 你是撰写者。综合前面各 Worker 的产出，输出结构化的最终答案：先给结论，再给依据，最后给一段适合面试口述的表述。不再调用任何工具。",
  },
};

/**
 * 最小 Agent harness（面试常考概念）：
 *   prompt 组装 → LLM 调用 → 解析 tool_calls → 执行工具 → ToolMessage 回填 → 循环
 *   → 模型不再请求工具或达到 maxToolIterations 时退出。
 *
 * 两个必须有的护栏：
 *  1) 迭代上限，防止 LLM 与工具互相触发形成死循环；
 *  2) 工具异常不外抛，转成文本回填，避免单个工具失败让整张图崩溃。
 *
 * 节点只往 state 写「带 name 的最终 AIMessage」，中间的工具往返不写进全局状态，
 * 这样 Supervisor 看到的是干净的结果流，上下文也不会膨胀。
 * 但工具往返会通过 onEvent 实时推给 Web 控制台 —— 这正是可观测性的价值：
 * 状态保持精简，展示层依然能看到完整过程。
 */
export function makeWorkerNode(name, { llm, tools, cfg, onEvent }) {
  const spec = WORKER_SPECS[name];
  if (!spec) throw new Error(`未知 Worker：${name}`);

  const workerTools = spec.toolNames.map((t) => tools[t]).filter(Boolean);
  const toolByName = new Map(workerTools.map((t) => [t.name, t]));
  const boundLLM = workerTools.length ? llm.bindTools(workerTools) : llm;

  return async (state) => {
    const round = state.rounds + 1;
    emit(onEvent, EVT.NODE, { node: name, phase: "start", round });

    // 前序 Worker 的产出以 observation 形式注入，不伪装成历史 assistant 消息
    const convo = buildObservationMessages({ system: spec.system, state });
    const usedTools = [];
    let aiMessage = null;
    let iterations = 0;

    while (iterations < cfg.graph.maxToolIterations) {
      aiMessage = await boundLLM.invoke(convo, { tags: [`worker:${name}`] });
      const calls = aiMessage.tool_calls ?? [];
      if (calls.length === 0) break;

      convo.push(aiMessage);
      for (const call of calls) {
        const target = toolByName.get(call.name);
        const startedAt = Date.now();
        let content;
        emit(onEvent, EVT.TOOL, {
          worker: name,
          tool: call.name,
          args: call.args ?? {},
          phase: "start",
          round,
          iteration: iterations + 1,
        });
        if (!target) {
          content = `错误：Worker ${name} 无权调用工具 ${call.name}`;
        } else {
          try {
            const result = await target.invoke(call.args ?? {});
            content = typeof result === "string" ? result : JSON.stringify(result);
          } catch (error) {
            content = `工具 ${call.name} 执行失败：${error.message}`;
          }
        }
        emit(onEvent, EVT.TOOL, {
          worker: name,
          tool: call.name,
          result: content,
          phase: "end",
          durationMs: Date.now() - startedAt,
          round,
          iteration: iterations + 1,
        });
        convo.push(
          new ToolMessage({
            content,
            tool_call_id: call.id ?? `call_${name}_${iterations}_${usedTools.length}`,
          }),
        );
        usedTools.push(call.name);
      }
      iterations += 1;
    }

    const text =
      typeof aiMessage?.content === "string" && aiMessage.content.trim()
        ? aiMessage.content
        : `[${name}] 已达到工具迭代上限（${cfg.graph.maxToolIterations}），未产出文本。`;

    emit(onEvent, EVT.WORKER, {
      worker: name,
      content: text,
      tools: [...usedTools],
      iterations,
      round,
    });
    emit(onEvent, EVT.NODE, { node: name, phase: "end", round });

    return {
      messages: [new AIMessage({ content: text, name })],
      visited: [name],
      trace: [
        `round ${state.rounds + 1}: worker=${name} tools=[${usedTools.join(",")}] iterations=${iterations}`,
      ],
    };
  };
}
