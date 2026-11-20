import { z } from "zod";
import { SystemMessage } from "@langchain/core/messages";
import { getRouterModel } from "../llm/factory.js";
import { SUPERVISOR_SYSTEM } from "./prompts.js";
import { AGENT_NAMES } from "../graphs/state.js";
import { recordEvent } from "../memory/observability.js";
import { makeLogger } from "../config.js";

const log = makeLogger("supervisor");

/**
 * 结构化输出 = 让 LLM 填「表单」而不是吐自然语言，路由才可被代码消费。
 * 注意：schema 只是「契约」，不同供应商的约束强度不同（OpenAI 由后端 grammar
 * 强约束，DeepSeek 只能靠 prompt + json_object + 本地 zod 校验），所以下面
 * 的 normalizeDecision 护栏对所有供应商都必须保留。
 */
export const RouteSchema = z.object({
  next: z.enum([...AGENT_NAMES, "FINISH"]).describe("下一个调度的成员；全部完成时填 FINISH"),
  reason: z.string().describe("一句话说明路由依据"),
});

/**
 * 把模型输出收敛成可执行决策：白名单 + 去重 + 迭代上限。
 * 这层「不信模型」的护栏是生产多 Agent 系统必备，也是面试常问的
 * 「Agent 死循环 / 路由幻觉怎么防」的标准答案。
 */
export function normalizeDecision(raw, state, { maxIterations = 12 } = {}) {
  const done = new Set(state?.completedAgents ?? []);
  const reason = String(raw?.reason ?? "").slice(0, 200);
  if ((state?.iteration ?? 0) >= maxIterations) {
    return { next: "FINISH", reason: `达到最大迭代 ${maxIterations}，强制收敛` };
  }
  const rawNext = String(raw?.next ?? "FINISH");
  if (rawNext === "FINISH" || /^end$/i.test(rawNext)) {
    return { next: "FINISH", reason: reason || "调度器判定任务完成" };
  }
  if (!AGENT_NAMES.includes(rawNext)) {
    return { next: "FINISH", reason: `非法路由「${rawNext}」，强制收敛` };
  }
  if (done.has(rawNext)) {
    const remaining = AGENT_NAMES.filter((n) => !done.has(n));
    return remaining.length
      ? { next: remaining[0], reason: `去重：${rawNext} 已完成，改派 ${remaining[0]}` }
      : { next: "FINISH", reason: "所有成员已完成" };
  }
  return { next: rawNext, reason };
}

/** 中心化 Supervisor 节点：只决策，不执行任务、不写答案 */
export function createSupervisorNode({ traceGraph = "supervisor", maxIterations = 12 } = {}) {
  const router = getRouterModel({
    agentName: "supervisor",
    routeSequence: AGENT_NAMES,
    schema: RouteSchema,
    allowedValues: [...AGENT_NAMES, "FINISH"],
  });

  return async (state, config) => {
    const threadId = config?.configurable?.thread_id ?? "default";
    const raw = await router.invoke([new SystemMessage({ content: SUPERVISOR_SYSTEM }), ...state.messages]);
    const decision = normalizeDecision(raw, state, { maxIterations });
    log.info("route", decision);
    await recordEvent({
      threadId, graph: traceGraph, node: "supervisor", event: "route",
      payload: { rawNext: raw?.next, ...decision },
    });
    return { next: decision.next, reason: decision.reason, activeAgent: "supervisor" };
  };
}

/** Swarm 用：由当前 Agent 自己决定把控制权移交给谁（去中心化 handoff） */
export function createHandoffRouter(agentName) {
  const router = getRouterModel({
    agentName: "handoff",
    routeSequence: AGENT_NAMES,
    schema: RouteSchema,
    allowedValues: [...AGENT_NAMES, "FINISH"],
  });
  return async (state, completedWithCurrent = []) => {
    const raw = await router.invoke([
      new SystemMessage({
        content: `${SUPERVISOR_SYSTEM}\n\n你刚以 ${agentName} 的身份完成了工作。请决定接下来把控制权移交给哪个成员，或返回 FINISH。`,
      }),
      ...state.messages,
    ]);
    return normalizeDecision(raw, { ...state, completedAgents: completedWithCurrent });
  };
}
