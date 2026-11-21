import { ChatOpenAI } from "@langchain/openai";
import { FakeChatModel } from "./fakeModel.js";

/**
 * LLM 工厂：LLM_PROVIDER=fake | openai
 *
 * openai 档走 OpenAI 兼容 /chat/completions，因此 DeepSeek / 硅基流动 /
 * OpenAI 只要换 LLM_BASE_URL + LLM_MODEL 就能接，业务代码零改动。
 * 这也是「面向协议编程」而不是「面向厂商 SDK 编程」的好处。
 *
 * ── DeepSeek V4 的 thinking mode 坑（本项目真实踩过并修掉）──
 * deepseek-flash 默认开启 thinking，响应里带 reasoning_content。
 * 官方文档：只要请求带 tools，之前「每一轮 assistant 消息」的
 * reasoning_content 都必须原样回传，否则直接 400。
 * 多 Agent 系统里 Supervisor / Worker 会反复把别的 Agent 的产出拼进历史，
 * 这些是我们构造的新 AIMessage，天然没有该字段，于是必炸。
 *
 * 本项目两层处理：
 *  1) 默认 LLM_THINKING=disabled —— 用 modelKwargs 传
 *     {"thinking":{"type":"disabled"}}，从源头不产生 reasoning_content；
 *     路由/工具调用不需要深度推理，更快更省，且 temperature 才真正生效
 *     （thinking mode 下 temperature 会被忽略）。
 *     注意：ChatOpenAI 1.x 只有 modelKwargs 会合并进请求体，
 *     extraBody 不生效（已实测）。
 *  2) 即便设为 enabled，agents/context.js 把子 Agent 产出折叠成
 *     一条 observation，而不是伪装成历史 assistant 消息，也不会触发校验。
 */
export function createLLM(cfg) {
  if (cfg.llm.provider === "fake") {
    return new FakeChatModel({});
  }

  const thinkingKwargs =
    cfg.llm.thinking === "disabled"
      ? { modelKwargs: { thinking: { type: "disabled" } } }
      : {};

  return new ChatOpenAI({
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    temperature: cfg.llm.temperature,
    timeout: cfg.llm.timeoutMs,
    maxRetries: 1,
    configuration: { baseURL: cfg.llm.baseURL },
    ...thinkingKwargs,
  });
}
