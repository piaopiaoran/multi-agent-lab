/**
 * Supervisor Console 前端：纯原生 ESM，零构建、零外部 CDN。
 * 数据流：POST /api/run -> EventSource /api/events/:runId (SSE) -> handleEvent()
 * 服务端会回放历史事件，所以「先建连、后执行」还是「先执行、后建连」都不会丢事件。
 */
const $ = (selector) => document.querySelector(selector);
const WORKERS = ["researcher", "analyst", "writer"];
const ALL_NODES = ["supervisor", ...WORKERS, "FINISH"];

const state = {
  es: null,
  runId: null,
  running: false,
  startedAt: 0,
  timer: null,
  events: 0,
  tools: 0,
  filter: "all",
  verbose: false,
  activeWorker: "researcher",
  workerOutputs: {},
  finalAnswer: "",
  defaultQuestion: "",
};

const EXAMPLES = {
  graph:
    "请说明 LangGraph 的条件边（addConditionalEdges）与 Checkpointer 各自解决什么问题，为什么两者是正交的，并给出一段适合面试口述的表述。",
  rag:
    "请检索知识库里关于 pgvector HNSW 索引、余弦距离与向量维度的资料，再计算「3 个 Worker 各调用 2 次工具」一共调用多少次工具，最后给出 3 条面试回答要点。",
};

/* ---------------- 基础工具 ---------------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

/** 轻量 Markdown：标题 / 列表 / 代码块 / 粗体 / 行内代码，足够渲染模型答案。 */
function markdown(source) {
  const lines = String(source ?? "").split(/\r?\n/);
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listType = null;
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const want = bullet ? "ul" : "ol";
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      out.push(`<li>${inline((bullet || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode && codeBuf.length) out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  return out.join("\n");
}

function timeNow() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function setStatus(kind, text) {
  const el = $("#run-status");
  el.className = `status ${kind}`;
  el.innerHTML = `<i></i> ${escapeHtml(text)}`;
  $("#live-dot").classList.toggle("on", kind === "running");
}

/* ---------------- 拓扑 ---------------- */

function setNodeClass(node, cls) {
  const el = document.getElementById(`node-${node}`);
  if (!el) return;
  el.classList.remove("active", "done", "thinking");
  if (cls) el.classList.add(cls);
}

function activateEdge(next) {
  for (const node of [...WORKERS, "FINISH"]) {
    document.getElementById(`edge-${node}`)?.classList.remove("active");
  }
  document.getElementById(`edge-${next}`)?.classList.add("active");
}

function clearEdges() {
  for (const node of [...WORKERS, "FINISH"]) {
    document.getElementById(`edge-${node}`)?.classList.remove("active");
  }
}

function resetTopology() {
  for (const node of ALL_NODES) setNodeClass(node, "");
  clearEdges();
}

/* ---------------- 时间线 ---------------- */

function addTimeline({ type, kind, title, detail = "", verbose = false, fold = null }) {
  const li = document.createElement("li");
  li.className = `ev-${type}`;
  li.dataset.type = type;
  li.dataset.verbose = verbose ? "1" : "0";
  const empty = $("#timeline").querySelector(".timeline-empty");
  if (empty) empty.remove();

  let foldHtml = "";
  if (fold) {
    foldHtml = `<details class="ev-fold"><summary>${escapeHtml(fold.label)}</summary><pre>${escapeHtml(fold.content)}</pre></details>`;
  }
  li.innerHTML =
    `<div class="ev-head"><span class="ev-kind">${escapeHtml(kind)}</span>` +
    `<span class="ev-time">${timeNow()}</span></div>` +
    `<div class="ev-title">${title}</div>` +
    (detail ? `<div class="ev-detail">${detail}</div>` : "") + foldHtml;

  $("#timeline").appendChild(li);
  state.events += 1;
  $("#event-count").textContent = `${state.events} 条`;
  applyVisibility();
  const wrap = $(".events");
  wrap.scrollTop = wrap.scrollHeight;
}

function applyVisibility() {
  for (const li of document.querySelectorAll("#timeline li[data-type]")) {
    const type = li.dataset.type;
    let hide = false;
    if (state.filter !== "all" && type !== state.filter && type !== "error" && type !== "final") hide = true;
    if (li.dataset.verbose === "1" && !state.verbose) hide = true;
    li.classList.toggle("hidden", hide);
  }
}

/* ---------------- 事件处理 ---------------- */

function handleEvent(event) {
  switch (event.type) {
    case "meta": {
      $("#badge-llm").textContent = `LLM: ${event.llm.provider} / ${event.llm.model}`;
      $("#badge-trace").textContent = `LangSmith: ${event.langsmith.enabled ? "ON" : "OFF"}`;
      $("#badge-store").textContent = `Store: ${event.backends.vector} / ${event.backends.checkpointer}`;
      addTimeline({
        type: "meta", kind: "启动",
        title: `会话 <code>${escapeHtml(event.threadId)}</code> 开始`,
        detail: `${escapeHtml(event.llm.provider)} / ${escapeHtml(event.llm.model)} · thinking=${escapeHtml(event.llm.thinking)} · guardrails maxRounds=${escapeHtml(event.guardrails.maxRounds)}`,
      });
      break;
    }
    case "node": {
      if (event.phase === "start") {
        if (event.node === "supervisor") {
          setNodeClass("supervisor", "thinking");
          for (const w of WORKERS) {
            const el = document.getElementById(`node-${w}`);
            if (el?.classList.contains("active")) setNodeClass(w, "done");
          }
        } else {
          setNodeClass(event.node, "active");
        }
      } else if (event.node === "supervisor") {
        document.getElementById("node-supervisor")?.classList.remove("thinking");
      }
      addTimeline({
        type: "node", kind: "节点",
        title: `<code>${escapeHtml(event.node)}</code> ${event.phase === "start" ? "进入" : "完成"}`,
        detail: `round ${escapeHtml(event.round)}`, verbose: true,
      });
      break;
    }
    case "route": {
      setNodeClass("supervisor", "done");
      activateEdge(event.next);
      if (event.next === "FINISH") {
        for (const w of WORKERS) {
          const el = document.getElementById(`node-${w}`);
          if (el?.classList.contains("active")) setNodeClass(w, "done");
        }
        setNodeClass("FINISH", "active");
      } else {
        for (const w of WORKERS) {
          const el = document.getElementById(`node-${w}`);
          if (w !== event.next && el?.classList.contains("active")) setNodeClass(w, "done");
        }
        setNodeClass(event.next, "active");
      }
      $("#stat-rounds").textContent = event.round;
      addTimeline({
        type: "route", kind: `路由 · R${event.round}`,
        title: `Supervisor → <span class="next-tag">${escapeHtml(event.next)}</span>` +
          (event.guardrail ? ' <span class="ev-guard">[护栏]</span>' : ""),
        detail: escapeHtml(event.reason) +
          (event.instruction ? `<br/>指令：${escapeHtml(event.instruction)}` : ""),
      });
      break;
    }
    case "tool": {
      if (event.phase === "start") {
        state.tools += 1;
        $("#stat-tools").textContent = state.tools;
        addTimeline({
          type: "tool", kind: `工具 · ${event.worker}`,
          title: `调用 <span class="tool-name">${escapeHtml(event.tool)}</span>`,
          detail: `<code>${escapeHtml(JSON.stringify(event.args ?? {}))}</code>`,
        });
      } else {
        const text = String(event.result ?? "");
        addTimeline({
          type: "tool", kind: `返回 · ${event.tool}`,
          title: `${escapeHtml(event.tool)} 耗时 ${escapeHtml(event.durationMs)}ms`,
          detail: escapeHtml(text.slice(0, 110)) + (text.length > 110 ? "…" : ""),
          fold: text.length > 110 ? { label: "查看完整返回", content: text } : null,
        });
      }
      break;
    }
    case "worker": {
      state.workerOutputs[event.worker] = event.content;
      showWorker(event.worker, true);
      const tab = document.querySelector(`.tab[data-worker="${event.worker}"]`);
      tab?.classList.add("filled");
      addTimeline({
        type: "worker", kind: "产出",
        title: `<span class="tool-name">${escapeHtml(event.worker)}</span> 输出 ${escapeHtml(event.content.length)} 字`,
        detail: `工具 ${escapeHtml((event.tools || []).join(", ") || "无")} · 迭代 ${escapeHtml(event.iterations)}`,
      });
      break;
    }
    case "state": {
      $("#stat-rounds").textContent = event.rounds;
      $("#stat-visited").textContent = event.visited.length ? event.visited.join(" → ") : "—";
      addTimeline({
        type: "state", kind: "状态",
        title: `<code>${escapeHtml(event.node)}</code> 写回状态`,
        detail: `rounds=${escapeHtml(event.rounds)} · visited=[${escapeHtml(event.visited.join(", "))}]` +
          (event.next ? ` · next=${escapeHtml(event.next)}` : ""),
        verbose: true,
      });
      break;
    }
    case "final": {
      state.finalAnswer = event.finalAnswer || "";
      $("#final-answer").innerHTML = markdown(state.finalAnswer) || '<p class="empty">无最终答案</p>';
      $("#btn-copy").disabled = false;
      $("#stat-rounds").textContent = event.rounds;
      $("#stat-visited").textContent = event.visited.join(" → ") || "—";
      setNodeClass("FINISH", "done");
      clearEdges();
      addTimeline({
        type: "final", kind: "完成",
        title: `最终答案已生成（${escapeHtml(event.finalAnswer.length)} 字）`,
        detail: `${escapeHtml(event.rounds)} 轮 · ${escapeHtml(event.visited.length)} 个 Worker · ${escapeHtml((event.durationMs / 1000).toFixed(1))}s`,
      });
      break;
    }
    case "error": {
      setStatus("error", "运行异常");
      addTimeline({ type: "error", kind: "错误", title: escapeHtml(event.message) });
      toast(event.message || "运行出错", true);
      break;
    }
    case "done": {
      finishRun(event.cancelled ? "已中止" : "已完成");
      break;
    }
    default:
      break;
  }
}

/* ---------------- Worker 卡片 ---------------- */

function showWorker(name, switchTab = false) {
  if (switchTab) {
    state.activeWorker = name;
    for (const tab of document.querySelectorAll(".tab")) {
      tab.classList.toggle("active", tab.dataset.worker === name);
    }
  }
  const el = $("#worker-output");
  const content = state.workerOutputs[name];
  el.innerHTML = content
    ? markdown(content)
    : '<p class="empty">该 Worker 尚未产出内容。</p>';
}

/* ---------------- 运行控制 ---------------- */

function resetRunUI() {
  state.events = 0;
  state.tools = 0;
  state.workerOutputs = {};
  state.finalAnswer = "";
  state.activeWorker = "researcher";
  $("#timeline").innerHTML = '<li class="timeline-empty">等待事件…</li>';
  $("#event-count").textContent = "0 条";
  $("#stat-rounds").textContent = "0";
  $("#stat-visited").textContent = "—";
  $("#stat-tools").textContent = "0";
  $("#stat-time").textContent = "0.0s";
  $("#btn-copy").disabled = true;
  $("#final-answer").innerHTML = '<p class="empty">等待运行结束…</p>';
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.remove("filled");
    tab.classList.toggle("active", tab.dataset.worker === "researcher");
  }
  showWorker("researcher");
  resetTopology();
}

function startTimer() {
  state.startedAt = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    $("#stat-time").textContent = `${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`;
  }, 100);
}

function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
  $("#stat-time").textContent = `${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`;
}

function finishRun(label) {
  state.running = false;
  $("#btn-run").disabled = false;
  $("#btn-stop").disabled = true;
  stopTimer();
  const hasError = $("#run-status").classList.contains("error");
  setStatus(hasError ? "error" : "idle", hasError ? "运行异常" : label);
  state.es?.close();
  state.es = null;
}

async function startRun() {
  if (state.running) return;
  const payload = {
    question: $("#question").value.trim() || state.defaultQuestion,
    provider: $("#provider").value,
    thread: $("#thread").value.trim() || undefined,
    trace: $("#trace").checked,
  };
  let response;
  try {
    response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    toast(`无法连接服务：${error.message}`, true);
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    toast(data.error || `启动失败（HTTP ${response.status}）`, true);
    return;
  }

  state.running = true;
  state.runId = data.runId;
  $("#btn-run").disabled = true;
  $("#btn-stop").disabled = false;
  $("#config-summary").textContent = data.summary || $("#config-summary").textContent;
  resetRunUI();
  setStatus("running", "运行中");
  startTimer();

  const es = new EventSource(`/api/events/${encodeURIComponent(data.runId)}`);
  state.es = es;
  es.onmessage = (message) => {
    try { handleEvent(JSON.parse(message.data)); } catch { /* 忽略单条坏事件 */ }
  };
  es.onerror = () => {
    if (state.running) toast("事件通道断开，浏览器将自动重连", true);
  };
}

async function stopRun() {
  if (!state.runId || !state.running) return;
  try {
    const res = await fetch(`/api/stop/${encodeURIComponent(state.runId)}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    toast(data.message || "已请求中止");
  } catch (error) {
    toast(`中止失败：${error.message}`, true);
  }
}

/* ---------------- 初始化 ---------------- */

function bindUI() {
  $("#btn-run").addEventListener("click", startRun);
  $("#btn-stop").addEventListener("click", stopRun);
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("supervisor-theme", next);
  });
  $("#verbose").addEventListener("change", (e) => {
    state.verbose = e.target.checked;
    applyVisibility();
  });
  $("#btn-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.finalAnswer);
      toast("最终答案已复制");
    } catch { toast("复制失败，请手动选中", true); }
  });
  for (const chip of document.querySelectorAll("[data-example]")) {
    chip.addEventListener("click", () => {
      const key = chip.dataset.example;
      $("#question").value = key === "arch" ? state.defaultQuestion : EXAMPLES[key];
    });
  }
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showWorker(tab.dataset.worker, true));
  }
  for (const chip of document.querySelectorAll("[data-filter]")) {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      for (const c of document.querySelectorAll("[data-filter]")) c.classList.remove("active");
      chip.classList.add("active");
      applyVisibility();
    });
  }
  $("#question").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") startRun();
  });
}

async function init() {
  const saved = localStorage.getItem("supervisor-theme");
  document.documentElement.dataset.theme =
    saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  bindUI();
  resetRunUI();
  try {
    const res = await fetch("/api/config");
    const config = await res.json();
    state.defaultQuestion = config.defaultQuestion || "";
    $("#question").value = state.defaultQuestion;
    $("#config-summary").textContent = config.summary || "";
    $("#provider").value = ["fake", "openai"].includes(config.llm?.provider)
      ? config.llm.provider : "fake";
    $("#trace").checked = Boolean(config.langsmith?.enabled);
    $("#badge-llm").textContent = `LLM: ${config.llm.provider} / ${config.llm.model}`;
    $("#badge-trace").textContent = `LangSmith: ${config.langsmith.enabled ? "ON" : "OFF"}`;
    $("#badge-store").textContent = `Store: ${config.storage.vector} / ${config.storage.checkpointer}`;
  } catch (error) {
    $("#config-summary").textContent = `配置读取失败：${error.message}`;
    toast("无法读取服务配置", true);
  }
}

init();
