import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { config, isMock, logger } from "../config.js";
import { MockChatModel, MockEmbeddings } from "./mock.js";

/**
 * 统一模型工厂：整项目只有这里知道「模型从哪来」。
 * 好处：换供应商 / 换模型 / 加降级策略 / 做 A-B 对比，都只改一处。
 */
let embeddingsInstance;

export function getEmbeddings() {
  if (embeddingsInstance) return embeddingsInstance;
  embeddingsInstance = isMock
    ? new MockEmbeddings()
    : new OpenAIEmbeddings({
        model: config.llm.embeddingModel,
        apiKey: config.llm.apiKey,
        configuration: config.llm.baseURL ? { baseURL: config.llm.baseURL } : undefined,
      });
  return embeddingsInstance;
}

/**
 * @param {object} opts
 * @param {string} opts.agentName   用于 mock 分支选择话术；真实模型下会写进 AIMessage.name
 * @param {string[]} opts.routeSequence  仅 supervisor 用，mock 路由的流水线顺序
 */
export function getChatModel({ agentName = "generic", routeSequence = [] } = {}) {
  if (!isMock && !config.llm.apiKey) {
    throw new Error("AGENT_MODE=live 但缺少 OPENAI_API_KEY；可设置 AGENT_MODE=mock 离线运行。");
  }
  if (isMock) {
    return new MockChatModel({ agentName, routeSequence });
  }
  logger.debug("create chat model", { agentName, model: config.llm.model });
  return new ChatOpenAI({
    model: config.llm.model,
    temperature: config.llm.temperature,
    apiKey: config.llm.apiKey,
    configuration: config.llm.baseURL ? { baseURL: config.llm.baseURL } : undefined,
  });
}
