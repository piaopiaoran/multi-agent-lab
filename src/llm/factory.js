import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { config, isMock, logger } from "../config.js";
import { MockChatModel, MockEmbeddings } from "./mock.js";

/**
 * 统一模型工厂：整项目只有这里知道「模型从哪来、供应商缺什么能力」。
 * 好处：换供应商 / 换模型 / 加降级策略 / 做 A-B 对比，都只改一处。
 *
 * 三个出口：
 *   getEmbeddings()  向量化     —— DeepSeek 无 /embeddings，自动降级本地哈希
 *   getChatModel()   对话/工具   —— OpenAI 兼容 /chat/completions + function calling
 *   getRouterModel() 结构化路由 —— OpenAI 用 json_schema，兼容网关用 json_object
 */
let embeddingsInstance;
let chatModelInstance;

export function getEmbeddings() {
  if (embeddingsInstance) return embeddingsInstance;
  if (config.embedding.provider === "mock") {
    logger.debug("embedding 降级为本地哈希向量（chat 网关未提供 /embeddings）");
    embeddingsInstance = new MockEmbeddings();
  } else {
    embeddingsInstance = new OpenAIEmbeddings({
      model: config.embedding.model,
      apiKey: config.embedding.apiKey,
      configuration: config.embedding.baseURL ? { baseURL: config.embedding.baseURL } : undefined,
    });
  }
  return embeddingsInstance;
}

/** ChatOpenAI 无状态，全局复用一个实例；bindTools / withConfig 都返回新的 RunnableBinding */
function chatModel() {
  if (chatModelInstance) return chatModelInstance;
  if (!config.llm.apiKey) {
    throw new Error(
      "LLM_PROVIDER=openai（或 AGENT_MODE=live）但缺少 LLM_API_KEY；" +
        "可设 LLM_PROVIDER=fake 或 AGENT_MODE=mock 离线运行。",
    );
  }
  logger.debug("create chat model", {
    provider: config.llm.provider,
    model: config.llm.model,
    baseURL: config.llm.baseURL ?? "(default)",
    timeoutMs: config.llm.timeoutMs,
    disableThinking: config.llm.disableThinking,
  });
  chatModelInstance = new ChatOpenAI({
    model: config.llm.model,
    temperature: config.llm.temperature,
    apiKey: config.llm.apiKey,
    configuration: config.llm.baseURL ? { baseURL: config.llm.baseURL } : undefined,
    timeout: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    // 供应商专属请求体参数走 modelKwargs（LangChain 不会过滤）。
    // 不关 DeepSeek thinking，ReAct 第二轮就会因 reasoning_content 缺失被 400 拒绝。
    modelKwargs: config.llm.disableThinking ? { thinking: { type: "disabled" } } : undefined,
  });
  return chatModelInstance;
}

/**
 * @param {object} opts
 * @param {string} opts.agentName   用于 mock 分支选择话术；真实模型下由 worker 节点强制署名
 * @param {string[]} opts.routeSequence  仅 supervisor 用，mock 路由的流水线顺序
 */
export function getChatModel({ agentName = "generic", routeSequence = [] } = {}) {
  if (isMock) return new MockChatModel({ agentName, routeSequence });
  return chatModel();
}

/** 去掉模型偶尔套的 Markdown 代码块，只取最外层 JSON 对象 */
function extractJson(text) {
  const cleaned = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

/**
 * 兼容网关的结构化输出适配器。
 *
 * 为什么不用 model.withStructuredOutput()：
 *  - 它默认走 response_format=json_schema（strict），DeepSeek 实测返回 400
 *    "This response_format type is unavailable now"；
 *  - method="functionCalling" 会用强制 tool_choice，DeepSeek thinking 模式返回 400
 *    "Thinking mode does not support this tool_choice"。
 * 所以这里手工走 response_format=json_object（实测 200），本地用 zod 校验并重试。
 *
 * 兜底哲学：解析/校验彻底失败时返回 null，交给 supervisor 的 normalizeDecision
 * 收敛成 FINISH —— 宁可提前结束，也不能让「模型输出不可解析」把整个图抛崩。
 */
class JsonObjectRouter {
  constructor({ schema, allowedValues = [], maxAttempts = 2 } = {}) {
    this.schema = schema;
    this.allowedValues = allowedValues;
    this.maxAttempts = maxAttempts;
    this.model = chatModel().withConfig({ response_format: { type: "json_object" } });
  }

  async invoke(messages) {
    const hint = new SystemMessage({
      content: [
        "你必须只输出一个 JSON 对象，不要输出解释文字、不要使用 Markdown 代码块。",
        `对象只有两个字段：next 与 reason。next 只能取以下值之一：${this.allowedValues.join(" | ")}。`,
        "必须根据消息里各成员的署名判断谁已完成；只要还有成员未交卷，就派给最早未完成的那个，绝不能提前返回 FINISH。",
        'reason 是一句话中文说明。示例：{"next":"researcher","reason":"先从知识库取证"}',
      ].join("\n"),
    });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const ai = await this.model.invoke([hint, ...messages]);
        const parsed = JSON.parse(extractJson(ai.content));
        // 模型偶尔会把枚举值写成大小写不同或带空格，先归一化再交给 zod
        const candidate = {
          ...parsed,
          next: typeof parsed.next === "string" ? parsed.next.trim() : parsed.next,
        };
        const checked = this.schema.safeParse(candidate);
        if (checked.success) return checked.data;
        logger.warn("结构化路由未通过 schema 校验", {
          attempt,
          received: JSON.stringify(candidate).slice(0, 200),
          issues: checked.error?.issues?.map((i) => i.message).slice(0, 3),
        });
      } catch (err) {
        logger.warn("结构化路由解析失败", { attempt, error: err.message });
      }
    }
    return null;
  }
}

/**
 * Supervisor / Swarm handoff 的路由模型。
 * 对外只暴露 invoke(messages) -> { next, reason }，与 mock 分支形状完全一致，
 * 所以上层 normalizeDecision、护栏、状态机一行都不用改。
 */
export function getRouterModel({
  agentName = "supervisor",
  routeSequence = [],
  schema,
  allowedValues = [],
} = {}) {
  if (isMock) {
    return new MockChatModel({ agentName, routeSequence }).withStructuredOutput();
  }
  if (!schema) throw new Error("真实模型的结构化路由必须提供 zod schema");
  if (config.llm.structuredOutput === "json_schema") {
    // OpenAI 原生：交给 LangChain 的严格结构化输出（后端会做 grammar 约束）
    return chatModel().withStructuredOutput(schema);
  }
  return new JsonObjectRouter({ schema, allowedValues });
}
