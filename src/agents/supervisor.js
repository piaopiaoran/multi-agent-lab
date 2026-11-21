import { AIMessage } from "@langchain/core/messages";
import { WORKER_NAMES } from "./state.js";
import { buildObservationMessages } from "./context.js";
import { emit, EVT } from "./events.js";

const SUPERVISOR_SYSTEM = `[SUPERVISOR] 你是中心化多 Agent 系统的调度器（Supervisor），负责决定下一个由哪个 Worker 执行，以及何时结束。

可用 Worker：
- researcher：调用 retrieve_knowledge 检索知识库，产出事实资料与调研摘要。
- analyst：做要点分析、数值核对，产出分析结论。
- writer：综合所有已有产出，写出结构化最终答案。

决策规则：
1. 每次决策都必须调用 route 工具，禁止用自然语言直接回答用户问题。
2. 典型顺序是 researcher → analyst → writer → FINISH；每个 Worker 最多调用一次。
3. 需要事实依据但还没有资料时选 researcher；已有资料需要归纳或量化时选 analyst；资料与分析齐备时选 writer。
4. writer 完成后必须选 FINISH，不得再调度任何 Worker。
5. next 只能取 researcher / analyst / writer / FINISH 之一。`;

function lastWorkerText(state, preferred = "writer") {
  const messages = state.messages ?? [];
  const picked =
    [...messages].reverse().find((m) => m?.name === preferred) ??
    [...messages].reverse().find((m) => m instanceof AIMessage || m?._getType?.() === "ai");
  return typeof picked?.content === "string" ? picked.content : "";
}

function finish(state, reason) {
  return {
    next: "FINISH",
    rounds: 1,
    finalAnswer: lastWorkerText(state),
    trace: [`round ${state.rounds + 1}: supervisor -> FINISH (${reason})`],
  };
}

/**
 * Supervisor 节点：把「路由决策」写进 state.next，条件边据此跳转。
 *
 * 为什么不直接在节点里 return new Command({ goto })？
 * 两种写法都合法，但「写 next 字段 + addConditionalEdges」把控制流显式画在图上，
 * 面试时更容易讲清中心化拓扑，也让状态快照里能看到每一次决策。
 *
 * onEvent 是可选的展示通道（Web 控制台 SSE 用），不参与任何决策。
 */
export function makeSupervisorNode({ llm, routeTool, cfg, onEvent }) {
  const boundLLM = llm.bindTools([routeTool]);
  const allowed = new Set([...WORKER_NAMES, "FINISH"]);

  return async (state) => {
    const visited = new Set(state.visited ?? []);
    const round = state.rounds + 1;

    emit(onEvent, EVT.NODE, { node: "supervisor", phase: "start", round });

    // 护栏 1：全局轮次上限，避免任何模型在 Worker 之间反复横跳
    if (state.rounds >= cfg.graph.maxRounds) {
      const result = finish(state, `达到 MAX_ROUNDS=${cfg.graph.maxRounds}，强制结束`);
      emit(onEvent, EVT.ROUTE, {
        round,
        next: "FINISH",
        reason: "达到 MAX_ROUNDS，护栏强制收敛",
        visited: [...visited],
        guardrail: true,
      });
      emit(onEvent, EVT.NODE, { node: "supervisor", phase: "end", round });
      return result;
    }

    const statusText =
      `当前状态：已完成 Worker = [${[...visited].join(", ") || "无"}]；` +
      `轮次 ${state.rounds}/${cfg.graph.maxRounds}。请选择下一个 Worker 或 FINISH。`;

    // 历史 Worker 产出折叠成一条 observation，而不是当作本模型的 assistant 历史回传，
    // 详见 agents/context.js 的说明（这是规避推理模型 reasoning_content 校验的关键）。
    const messages = buildObservationMessages({
      system: SUPERVISOR_SYSTEM,
      state,
      status: statusText,
      visitedTag: true,
    });

    const aiMessage = await boundLLM.invoke(messages, { tags: ["node:supervisor"] });

    // 护栏 2：结构化输出解析失败 / 幻觉节点名 → 一律走白名单兜底
    const calls = aiMessage.tool_calls ?? [];
    const call = calls.find((c) => c.name === "route") ?? calls[0];
    let next = call?.args?.next ?? "FINISH";
    let reason = call?.args?.reason ?? "模型未调用 route，兜底结束";
    let guardrail = false;
    const instruction = call?.args?.instruction ?? "";

    if (!allowed.has(next)) {
      reason = `非法路由 ${next}，已被白名单拦截`;
      next = "FINISH";
      guardrail = true;
    }

    // 护栏 3：Writer 已完成则强制收敛；并防止重复调度同一 Worker
    if (visited.has("writer") && next !== "FINISH") {
      next = "FINISH";
      reason = "writer 已完成，强制 FINISH";
      guardrail = true;
    } else if (next !== "FINISH" && visited.has(next)) {
      const remaining = WORKER_NAMES.find((n) => !visited.has(n));
      next = remaining ?? "FINISH";
      reason = `避免重复调度，改选 ${next}`;
      guardrail = true;
    }

    emit(onEvent, EVT.ROUTE, {
      round,
      next,
      reason,
      instruction,
      visited: [...visited],
      guardrail,
      rawToolCalls: calls.length,
    });
    emit(onEvent, EVT.NODE, { node: "supervisor", phase: "end", round });

    return {
      next,
      rounds: 1,
      ...(next === "FINISH" ? { finalAnswer: lastWorkerText(state) } : {}),
      trace: [`round ${round}: supervisor -> ${next} (${reason})`],
    };
  };
}
