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
 * 实测（真实模型）：LangChain 内部 tracer 还会自建一条节点链
 * （LangGraph → supervisor / agent → ChatOpenAI / rag_search），与这里显式
 * 创建的顶层 run 共同构成完整轨迹；工具节点偶尔是独立 root，属正常现象。
 * 生产里若要求严格单棵树，可把 traceable 的 run tree 作为 callback 传给
 * graph.invoke，让所有 run 显式共用同一个 parent_run_id。
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
 * 三个 LangSmith 的坑：
 *  1) 真实模型下每次 LLM / ToolNode 调用都会上报 run，全量扫描最近 100 条会把
 *     顶层 run 挤出窗口（mock 模式没这个问题），所以必须先用 isRoot 缩小范围；
 *  2) isRoot 里会混入「工具单独上报的 root」，要再按 name 前缀过滤；
 *  3) 父 run 的 child_run_ids 通常不回填，子 run 只能用
 *     filter=eq(parent_run_id, "...") 反查，不能靠本地 batch 里数。
 */
export async function listRecentRuns(limit = 5) {
  if (!isLangSmithEnabled()) return { enabled: false, runs: [] };
  try {
    const client = getLangSmithClient();
    const roots = [];
    for await (const run of client.listRuns({
      projectName: config.langsmith.project,
      isRoot: true,
      limit: 100,
    })) {
      if (String(run.name ?? "").startsWith("multi-agent:")) roots.push(run);
      if (roots.length >= limit) break;
    }

    const runs = [];
    for (const r of roots) {
      let child_count = 0;
      try {
        for await (const _child of client.listRuns({
          projectName: config.langsmith.project,
          filter: `eq(parent_run_id, "${r.id}")`,
          limit: 100,
        })) {
          child_count += 1;
        }
      } catch (err) {
        log.debug("子节点统计失败", err.message);
      }
      runs.push({
        id: r.id,
        name: r.name,
        status: r.status ?? "-",
        start_time: r.start_time,
        child_count,
        result: r.extra?.metadata?.status ?? "-",
      });
    }
    return {
      enabled: true,
      project: config.langsmith.project,
      console: langsmithInfo().console,
      scanned: roots.length,
      runs,
    };
  } catch (err) {
    return { enabled: true, error: err.message, runs: [] };
  }
}
