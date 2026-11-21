import { HumanMessage } from "@langchain/core/messages";
import { createTools } from "../agents/tools.js";
import { createEmbeddings } from "../llm/embeddings.js";
import { createLLM } from "../llm/factory.js";
import { createCheckpointer } from "../memory/checkpointer.js";
import { createVectorStore } from "../memory/vectorStore.js";
import { buildRunConfig } from "../observability/langsmith.js";
import { buildGraph } from "../graph/buildGraph.js";
import { emit, EVT } from "../agents/events.js";
import { textOf } from "../agents/context.js";

/**
 * Web 控制台专用的流式 runner。
 *
 * 为什么不直接改 runSession（CLI 用的 invoke）？
 *  - invoke 只返回「最终状态」，浏览器会一直空白直到整条链路跑完；
 *  - stream(streamMode:"updates") 每完成一个节点就吐一次「状态增量」，
 *    配合节点内部的 onEvent，就能实时画出路由轨迹和工具往返。
 *
 * 这里刻意不调用 app.getState()：updates 里的增量本身就等价于 reducer 的输入，
 * 自己按 reducer 语义累积即可得到最终状态，少一次 IO 且对没有 checkpointer
 * 的图也成立。这也是面试里讲「 reducer 决定合并语义」的一个好例子。
 */
export async function streamSession({ cfg, question, threadId, onEvent, signal }) {
  const startedAt = Date.now();
  const embeddings = createEmbeddings(cfg);
  const llm = createLLM(cfg);
  const { store, backend: vectorBackend } = await createVectorStore(cfg, embeddings);
  const {
    saver,
    close: closeCheckpointer,
    backend: checkpointerBackend,
  } = await createCheckpointer(cfg);

  try {
    const tools = createTools(store);
    const app = buildGraph({ cfg, llm, tools, checkpointer: saver, onEvent });
    const config = buildRunConfig(cfg, { threadId, question });

    emit(onEvent, EVT.META, {
      question,
      threadId: config.configurable.thread_id,
      backends: { vector: vectorBackend, checkpointer: checkpointerBackend },
      llm: {
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        thinking: cfg.llm.thinking,
        baseURL: cfg.llm.baseURL,
      },
      embeddings: { provider: cfg.embeddings.provider, model: cfg.embeddings.model },
      langsmith: { enabled: cfg.langsmith.enabled, project: cfg.langsmith.project },
      guardrails: cfg.graph,
      startedAt,
    });

    const acc = {
      visited: [],
      rounds: 0,
      trace: [],
      finalAnswer: "",
      workerOutputs: [],
    };

    const stream = await app.stream(
      { messages: [new HumanMessage(question)] },
      { ...config, streamMode: "updates" },
    );

    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error("运行已被用户中止");
      for (const [node, update] of Object.entries(chunk ?? {})) {
        if (node.startsWith("__")) continue;
        applyUpdate(acc, update);
        emit(onEvent, EVT.STATE, {
          node,
          rounds: acc.rounds,
          visited: [...acc.visited],
          next: update?.next ?? null,
          traceLines: [...(update?.trace ?? [])],
        });
      }
    }

    const result = {
      finalAnswer: acc.finalAnswer || "(本次未产出最终答案)",
      visited: acc.visited,
      rounds: acc.rounds,
      trace: acc.trace,
      workerOutputs: acc.workerOutputs,
      threadId: config.configurable.thread_id,
      backends: { vector: vectorBackend, checkpointer: checkpointerBackend },
      durationMs: Date.now() - startedAt,
    };
    emit(onEvent, EVT.FINAL, result);
    return result;
  } catch (error) {
    emit(onEvent, EVT.ERROR, {
      message: error?.message ?? String(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  } finally {
    await store.close();
    await closeCheckpointer();
  }
}

/** 按 AgentState 里定义的 reducer 语义累积 updates（集合并集 / 累加 / 追加 / 覆盖）。 */
function applyUpdate(acc, update = {}) {
  const u = update ?? {};
  acc.rounds += typeof u.rounds === "number" ? u.rounds : 0;
  for (const v of u.visited ?? []) {
    if (!acc.visited.includes(v)) acc.visited.push(v);
  }
  for (const line of u.trace ?? []) acc.trace.push(line);
  if (typeof u.finalAnswer === "string" && u.finalAnswer) acc.finalAnswer = u.finalAnswer;
  for (const message of u.messages ?? []) {
    if (message?.name) {
      acc.workerOutputs.push({ worker: message.name, content: textOf(message) });
    }
  }
}
