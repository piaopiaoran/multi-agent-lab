import http from "node:http";
import { HumanMessage } from "@langchain/core/messages";
import { createApp, invokeGraph, streamGraph, readState, GRAPH_META, GRAPH_NAMES } from "./graphs/factory.js";
import { similaritySearch, addDocuments } from "./memory/vector-store.js";
import { getEvents } from "./memory/observability.js";
import { SEED_DOCUMENTS } from "./data/knowledge.js";
import { config, describeRuntime, makeLogger } from "./config.js";

const log = makeLogger("server");
const PORT = Number(process.env.PORT ?? 3000);

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("请求体过大");
  }
  return raw ? JSON.parse(raw) : {};
}

const HELP = {
  "GET /health": "健康检查 + 当前运行模式",
  "GET /meta": "三种拓扑的对比元数据",
  "GET /knowledge?q=xxx": "直接试 pgvector 语义检索",
  "GET /state?graph=supervisor&threadId=t1": "读取 checkpointer 中该 thread 的状态快照",
  "GET /events?threadId=t1": "读取节点事件轨迹",
  "POST /invoke": "{ question, graph?, threadId?, namespace? } 同步执行",
  "POST /stream": "同上参数，返回 SSE 流（逐节点 updates）",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    if (url.pathname === "/" || url.pathname === "/help") return json(res, 200, HELP);
    if (url.pathname === "/health") return json(res, 200, { ok: true, runtime: describeRuntime() });
    if (url.pathname === "/meta") return json(res, 200, GRAPH_META);

    const app = await createApp();
    const q = url.searchParams;
    const threadId = q.get("threadId") ?? "http-thread";
    const namespace = q.get("namespace") ?? "default";
    const graphName = GRAPH_NAMES.includes(q.get("graph")) ? q.get("graph") : config.defaultGraph;

    if (url.pathname === "/knowledge") {
      const hits = await similaritySearch(q.get("q") ?? "LangGraph 状态", { k: Number(q.get("k") ?? 4) });
      return json(res, 200, { hits });
    }
    if (url.pathname === "/state") {
      const snapshot = await readState(app, graphName, { threadId, namespace });
      // checkpointer 里的 messages 可能是反序列化后的消息类，也可能是 lc 序列化对象，
      // 这里统一成可读摘要，避免把整个 checkpoint 原样倒给调用方
      const v = snapshot?.values;
      const summary = (v?.messages ?? []).map((m) => ({
        role: m?._getType?.() ?? m?.type ?? "message",
        name: m?.name ?? m?.kwargs?.name ?? "-",
        content: typeof m?.content === "string" ? m.content : (m?.kwargs?.content ?? ""),
      }));
      return json(res, 200, {
        threadId, graph: graphName,
        values: v ? { messages: summary, completedAgents: v.completedAgents, iteration: v.iteration, next: v.next } : null,
        next: snapshot?.next ?? [],
        checkpoint: snapshot?.config ?? null,
      });
    }
    if (url.pathname === "/events") return json(res, 200, { events: getEvents(threadId) });

    if (url.pathname === "/invoke" || url.pathname === "/stream") {
      if (req.method !== "POST") return json(res, 405, { error: "use POST" });
      const body = await readBody(req);
      const question = body.question ?? "多 Agent 系统如何做状态持久化？";
      const graph = GRAPH_NAMES.includes(body.graph) ? body.graph : graphName;
      const options = { threadId: body.threadId ?? threadId, namespace: body.namespace ?? namespace };
      const input = { messages: [new HumanMessage({ content: question })], namespace: options.namespace };

      if (url.pathname === "/invoke") {
        const result = await invokeGraph(app, graph, input, options);
        const final = [...result.messages].reverse().find((m) => m.name === "writer") ?? result.messages.at(-1);
        return json(res, 200, {
          graph, threadId: options.threadId,
          answer: final?.content ?? "",
          state: {
            completedAgents: result.completedAgents,
            iteration: result.iteration,
            next: result.next,
            messageCount: result.messages.length,
          },
          events: getEvents(options.threadId).filter((e) => e.graph === graph),
        });
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: start\ndata: ${JSON.stringify({ graph, threadId: options.threadId })}\n\n`);
      for await (const chunk of streamGraph(app, graph, input, options)) {
        res.write(`event: update\ndata: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write(`event: done\ndata: ${JSON.stringify({ threadId: options.threadId })}\n\n`);
      return res.end();
    }

    return json(res, 404, { error: "not found", routes: HELP });
  } catch (err) {
    log.error(err.message);
    if (!res.headersSent) return json(res, 500, { error: err.message });
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    return res.end();
  }
});

// 离线降级时内存向量库是空的，启动即灌入示例知识，保证 /knowledge 与 rag_search 有内容
if ((await similaritySearch("LangGraph 状态", { k: 1 })).length === 0) {
  await addDocuments(SEED_DOCUMENTS);
  log.info("已灌入示例知识块");
}

server.listen(PORT, () => {
  log.info(`HTTP 服务已启动 http://localhost:${PORT}`);
  console.log("可用接口：", HELP);
  console.log("运行配置：", describeRuntime());
});
