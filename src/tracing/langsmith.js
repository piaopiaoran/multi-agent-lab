import { Client } from "langsmith";
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { config, makeLogger } from "../config.js";
import { getEvents } from "../memory/observability.js";

const log = makeLogger("langsmith");

export const isLangSmithEnabled = () => config.langsmith.tracing && Boolean(config.langsmith.apiKey);

/**
 * 把配置写回 process.env，让 LangChain 内部的 LangChainTracer 生效。
 * 真实模型下 ChatOpenAI / ToolNode / LangGraph 节点会自动上报；
 * 但离线 mock 模式压根没有这些 Runnable，所以本文件还会用 traceable
 * 显式建一条顶层 run，并把节点事件转成 child runs。
 *
 * 两种模式最终汇成同一棵树：traceable 通过 AsyncLocalStorage 提供 current
 * run tree，LangChain 内部 tracer 会自动挂到它下面。
 */
export function configureLangSmithEnv() {
  if (!isLangSmithEnabled()) return false;
  process.env.LANGSMITH_TRACING = "true";
  process.env.LANGSMITH_API_KEY = config.langsmith.apiKey;
  process.env.LANGSMITH_PROJECT = config.langsmith.project;
  process.env.LANGSMITH_ENDPOINT = config.langsmith.endpoint;
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = String(config.langsmith.background);
  return true;
}

// 模块加载即生效，保证早于任何 LangChain 组件构造
configureLangSmithEnv();

let client;

export function getLangSmithClient() {
  if (!client) {
    client = new Client({ apiKey: config.langsmith.apiKey, apiUrl: config.langsmith.endpoint });
  }
  return client;
}

export function langsmithInfo() {
  return {
    enabled: isLangSmithEnabled(),
    project: config.langsmith.project,
    endpoint: config.langsmith.endpoint,
    // UI 里按项目名查找即可；不打印 key
    console: "https://smith.langchain.com/",
  };
}

/** 只把精简摘要写进 trace 的 outputs，避免把整份 State / 消息对象原样上传 */
function toDigest(result) {
  if (!result) return { status: "error" };
  const msgs = result.messages ?? [];
  const final = [...msgs].reverse().find((m) => m?.name === "writer") ?? msgs.at(-1);
  return {
    answer: typeof final?.content === "string" ? final.content.slice(0, 500) : "",
    completedAgents: result.completedAgents,
    iteration: result.iteration,
    next: result.next,
    messageCount: msgs.length,
  };
}

async function flush() {
  try {
    await getLangSmithClient().awaitPendingTraceBatches();
  } catch (err) {
    log.debug("flush 失败", err.message);
  }
}

/**
 * 包装一次图执行，产出「一条顶层 chain run + N 条节点 child run」。
 * 关键取舍：观测失败绝不能影响业务链路 —— 上报异常一律吞掉，
 * 业务异常原样抛出。
 */
export async function traceGraphRun({ graphName, threadId, namespace, question, run }) {
  if (!isLangSmithEnabled()) return run();

  const startedAt = Date.now();
  let fullResult;
  let runError;

  const wrapped = traceable(
    async () => {
      const rt = getCurrentRunTree();
      try {
        fullResult = await run();
      } catch (err) {
        runError = err;
      }

      if (rt) {
        const events = getEvents(threadId).filter(
          (e) => e.graph === graphName && (!e.created_at || e.created_at.getTime() >= startedAt),
        );
        for (const e of events) {
          try {
            const child = rt.createChild({
              name: `${e.node}:${e.event}`,
              run_type: e.event === "enter" || e.event === "leave" ? "tool" : "chain",
              inputs: e.payload ?? {},
              metadata: { graph: graphName, threadId, node: e.node, event: e.event },
              tags: ["multi-agent-node", graphName],
            });
            await child.end({ ok: !runError });
            await child.postRun();
          } catch (err) {
            log.debug("child run 写入失败", err.message);
          }
        }
        rt.metadata = {
          ...(rt.metadata ?? {}),
          nodeCount: events.length,
          status: runError ? "error" : "success",
          completedAgents: fullResult?.completedAgents,
          iteration: fullResult?.iteration,
        };
      }
      return runError ? { error: runError.message } : toDigest(fullResult);
    },
    {
      name: `multi-agent:${graphName}`,
      run_type: "chain",
      project_name: config.langsmith.project,
      tags: ["multi-agent", graphName, config.mode],
      metadata: { graph: graphName, threadId, namespace, mode: config.mode },
      client: getLangSmithClient(),
    },
  );

  try {
    await wrapped({ question, graph: graphName, threadId, namespace });
  } catch (err) {
    log.warn("LangSmith 上报失败（不影响业务）", err.message);
  }
  await flush();
  if (runError) throw runError;
  return fullResult;
}

/**
 * 给 trace-check 脚本用：验证上报是否真的到达。
 *
 * 注意两个 LangSmith 的坑：
 *  1) isRoot 过滤会把「ToolNode 单独上报的工具 run」也算作 root，直接用会看不到我们的顶层 run；
 *  2) 父 run 的 child_run_ids 通常不回填，子 run 只能通过 parent_run_id 反查。
 * 因此这里拉一批 run 后在本地按 name 前缀找顶层 run，再按 parent_run_id 数子节点。
 */
export async function listRecentRuns(limit = 5) {
  if (!isLangSmithEnabled()) return { enabled: false, runs: [] };
  try {
    const all = [];
    for await (const run of getLangSmithClient().listRuns({
      projectName: config.langsmith.project,
      limit: 100,
    })) {
      all.push(run);
      if (all.length >= 100) break;
    }
    const roots = all.filter(
      (r) => !r.parent_run_id && String(r.name ?? "").startsWith("multi-agent:"),
    );
    const runs = roots.slice(0, limit).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status ?? "-",
      start_time: r.start_time,
      child_count: all.filter((c) => c.parent_run_id === r.id).length,
      result: r.extra?.metadata?.status ?? "-",
    }));
    return {
      enabled: true,
      project: config.langsmith.project,
      console: langsmithInfo().console,
      scanned: all.length,
      runs,
    };
  } catch (err) {
    return { enabled: true, error: err.message, runs: [] };
  }
}
