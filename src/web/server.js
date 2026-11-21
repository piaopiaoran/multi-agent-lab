import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_DIR = path.join(ROOT, "web");

// 保证从任意 cwd 启动时，dotenv 都能读到项目根的 .env。
process.chdir(ROOT);

const { describeConfig, loadConfig } = await import("../config/env.js");
const { DEFAULT_QUESTION } = await import("../run.js");
const { streamSession } = await import("./runner.js");
const { EVT } = await import("../agents/events.js");

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
  ["/favicon.svg", { file: "favicon.svg", type: "image/svg+xml" }],
]);

/**
 * configureLangSmith() 在关闭 tracing 时会 delete 掉环境变量里的 key
 * （CLI 只加载一次所以无感），而 Web 服务会反复 loadConfig。
 * 因此这里在服务启动时快照一份，每次运行前恢复，避免第二次运行「密钥莫名消失」。
 */
const LS_KEYS = [
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_TRACING",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGSMITH_PROJECT",
  "LANGCHAIN_PROJECT",
  "LANGSMITH_ENDPOINT",
  "LANGCHAIN_ENDPOINT",
];

function captureLangSmithEnv() {
  return Object.fromEntries(
    LS_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
}

function resetLangSmithEnv(snapshot) {
  for (const key of LS_KEYS) {
    if (snapshot[key] !== undefined) process.env[key] = snapshot[key];
    else delete process.env[key];
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求体过大（上限 64KB）");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(res, pathname) {
  // 白名单映射，不接受任意路径拼接，天然免疫路径穿越。
  const entry = STATIC_FILES.get(pathname);
  if (!entry) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }
  try {
    const data = await fs.readFile(path.join(WEB_DIR, entry.file));
    res.writeHead(200, {
      "Content-Type": entry.type,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    sendJson(res, 500, { error: `静态资源缺失：${entry.file}` });
  }
}

function writeEvent(res, event) {
  let data;
  try {
    data = JSON.stringify(event);
  } catch {
    data = JSON.stringify({ seq: event.seq, at: event.at, type: "error", message: "事件序列化失败" });
  }
  res.write(`id: ${event.seq}\ndata: ${data}\n\n`);
}

export function createWebServer() {
  const envSnapshot = captureLangSmithEnv();
  const baseCfg = loadConfig();
  resetLangSmithEnv(envSnapshot);

  /** runId -> { events, listeners, done, cancelled, controller, createdAt } */
  const runs = new Map();
  let activeRunId = null;

  function publish(run, event) {
    const payload = { seq: run.events.length + 1, at: Date.now(), ...event };
    run.events.push(payload);
    for (const res of run.listeners) {
      try {
        writeEvent(res, payload);
      } catch {
        // 客户端断开，交给 close 事件清理
      }
    }
  }

  function finishRun(run) {
    run.done = true;
    for (const res of run.listeners) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    run.listeners.clear();
  }

  function handleEvents(req, res, runId) {
    const run = runs.get(runId);
    if (!run) {
      sendJson(res, 404, { error: "run 不存在或已被清理" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const lastId = Number(req.headers["last-event-id"] || 0);
    for (const event of run.events) {
      if (!lastId || event.seq > lastId) writeEvent(res, event);
    }
    if (run.done) {
      res.end();
      return;
    }
    run.listeners.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      run.listeners.delete(res);
    });
  }

  async function handleRun(req, res) {
    if (activeRunId) {
      sendJson(res, 409, { error: "已有运行中的任务，请等待完成或先中止" });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { error: `请求解析失败：${error.message}` });
      return;
    }

    const question = String(body.question ?? "").trim().slice(0, 4000) || DEFAULT_QUESTION;
    const overrides = {};
    const choices = {
      provider: ["fake", "openai"],
      storage: ["memory", "postgres"],
      checkpointer: ["memory", "postgres"],
    };
    for (const [key, allowed] of Object.entries(choices)) {
      if (allowed.includes(body[key])) overrides[key] = body[key];
    }

    resetLangSmithEnv(envSnapshot);
    if (body.trace === false) process.env.LANGSMITH_TRACING = "false";
    else if (body.trace === true) process.env.LANGSMITH_TRACING = "true";

    let cfg;
    try {
      cfg = loadConfig(overrides);
    } catch (error) {
      resetLangSmithEnv(envSnapshot);
      sendJson(res, 400, { error: error.message });
      return;
    }

    const runId = randomUUID();
    const run = {
      id: runId,
      events: [],
      listeners: new Set(),
      done: false,
      cancelled: false,
      controller: new AbortController(),
      createdAt: Date.now(),
    };
    runs.set(runId, run);
    activeRunId = runId;

    // 只保留最近 20 次运行，避免长驻进程内存无限增长。
    if (runs.size > 20) {
      const oldest = runs.keys().next().value;
      if (oldest !== runId) runs.delete(oldest);
    }

    sendJson(res, 200, {
      runId,
      summary: describeConfig(cfg),
      threadId: body.thread || undefined,
    });

    // 响应先发出，浏览器随即建立 EventSource 订阅；执行在后台继续。
    void (async () => {
      try {
        await streamSession({
          cfg,
          question,
          threadId: body.thread || undefined,
          signal: run.controller.signal,
          onEvent: (event) => {
            publish(run, event);
            if (run.cancelled) run.controller.abort();
          },
        });
      } catch {
        // streamSession 已经发出 error 事件，这里只需保证收尾
      } finally {
        publish(run, {
          type: EVT.DONE,
          durationMs: Date.now() - run.createdAt,
          cancelled: run.cancelled,
        });
        finishRun(run);
        activeRunId = null;
        resetLangSmithEnv(envSnapshot);
      }
    })();
  }

  function handleStop(res, runId) {
    const run = runs.get(runId);
    if (!run || run.done) {
      sendJson(res, 404, { error: "没有可中止的运行" });
      return;
    }
    run.cancelled = true;
    run.controller.abort();
    sendJson(res, 200, { ok: true, message: "已请求中止（当前节点结束后生效）" });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/api/config") {
        sendJson(res, 200, {
          defaultQuestion: DEFAULT_QUESTION,
          summary: describeConfig(baseCfg),
          llm: {
            provider: baseCfg.llm.provider,
            model: baseCfg.llm.model,
            thinking: baseCfg.llm.thinking,
          },
          storage: {
            vector: baseCfg.storage.backend,
            checkpointer: baseCfg.storage.checkpointer,
          },
          langsmith: {
            enabled: baseCfg.langsmith.enabled,
            project: baseCfg.langsmith.project,
          },
          guardrails: baseCfg.graph,
        });
        return;
      }
      if (req.method === "POST" && pathname === "/api/run") {
        await handleRun(req, res);
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/api/events/")) {
        handleEvents(req, res, decodeURIComponent(pathname.slice("/api/events/".length)));
        return;
      }
      if (req.method === "POST" && pathname.startsWith("/api/stop/")) {
        handleStop(res, decodeURIComponent(pathname.slice("/api/stop/".length)));
        return;
      }
      if (req.method === "GET") {
        await serveStatic(res, pathname);
        return;
      }
      sendJson(res, 405, { error: "Method Not Allowed" });
    } catch (error) {
      sendJson(res, 500, { error: error?.message ?? String(error) });
    }
  });

  return server;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.WEB_PORT || 5173);
  const host = process.env.WEB_HOST || "127.0.0.1";
  createWebServer().listen(port, host, () => {
    console.log("=== Supervisor Console ===");
    console.log(`  http://${host}:${port}`);
    console.log("  默认读取项目根 .env；Ctrl+C 退出。\n");
  });
}
