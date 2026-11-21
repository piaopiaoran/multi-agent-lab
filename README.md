# multi-agent-supervisor

> 一个**能跑通、能讲清、能对照取舍**的中心化 Supervisor 多 Agent 项目，为面试准备而写。

技术栈：**LangChain.js 1.x + LangGraph.js 1.x + PostgreSQL/pgvector + LangSmith + DeepSeek V4.1-Flash + 原生 ESM Web 控制台（SSE）**
语言：**全程 JavaScript（Node.js ≥ 20，ESM），没有一行 Python**。

它把下面这条链路完整跑了一遍，每个环节都能在代码里找到对应实现：

```
用户问题 → Supervisor 路由(结构化 function calling) → researcher(pgvector 检索)
         → analyst(工具计算) → writer(综合) → 回中心 → FINISH
横切：Checkpointer 状态快照 / LangSmith run tree / fake 档零成本验证
```

覆盖的面试主题：多 Agent 拓扑 · agent harness · 条件边与 reducer · 记忆与向量检索 · 可观测性 · 工程护栏 · 密钥安全 · 推理模型接入坑。

---

## 1. 架构

### 1.1 图结构（中心化 = 星形控制流）

```mermaid
flowchart TD
    U["用户问题 HumanMessage"] --> S["supervisor 节点<br/>LLM + route 工具"]
    S -->|"next=researcher"| R["researcher"]
    S -->|"next=analyst"| A["analyst"]
    S -->|"next=writer"| W["writer"]
    S -->|"next=FINISH"| E(["END"])
    R -->|"普通边：结果回中心"| S
    A -->|"普通边：结果回中心"| S
    W -->|"普通边：结果回中心"| S
    R -.->|"retrieve_knowledge"| V[("向量库<br/>pgvector / 内存")]
    A -.->|"calculate"| T["共享工具层"]
    W -.->|"综合产出"| F["finalAnswer"]
    S -.->|"每步状态快照"| C[("Checkpointer<br/>MemorySaver / PostgresSaver")]
    S -.->|"run tree"| L["LangSmith"]
```

**只有 Supervisor 有条件边**，所有 Worker 执行完都用普通边回到中心。这就是"中心化"在图结构上的定义：**没有任何 Worker 能直接把控制权交给另一个 Worker**。

### 1.2 一次执行的时序

```mermaid
sequenceDiagram
    participant U as 用户
    participant S as Supervisor
    participant R as researcher
    participant A as analyst
    participant W as writer
    participant K as 向量库 / 工具
    U->>S: 问题
    S->>S: route(next=researcher) 结构化决策
    S->>R: 条件边跳转
    R->>K: retrieve_knowledge(query, topK)
    K-->>R: 资料片段 + 相似度分数
    R->>S: AIMessage(name=researcher)
    S->>A: route(next=analyst)
    A->>K: calculate(expression)
    A->>S: AIMessage(name=analyst)
    S->>W: route(next=writer)
    W->>S: AIMessage(name=writer)
    S->>U: next=FINISH → END，输出 finalAnswer
```

---

## 2. 为什么选中心化 Supervisor

| 维度 | 中心化 Supervisor（本项目） | 去中心化 Swarm | 单 Agent ReAct |
| --- | --- | --- | --- |
| 拓扑 | 星形，跨 Agent 通信全经中心 | 网状，Agent 间 handoff 直连 | 无多 Agent |
| 全局视野 | 天然具备，统一记忆与停止条件 | 需额外协议，难以保证 | 自带但上下文易膨胀 |
| 可审计 / 限流 / 权限 | 一处收口，天然可留痕 | 路径分散，追溯成本高 | 简单 |
| 主要风险 | Supervisor 是单点与延迟瓶颈 | 死循环、路径发散、停不下来 | 工具越多 prompt 越乱 |
| 适合 | 任务可预先分解、需合规留痕 | 开放式探索、分工边跑边定 | 简单线性任务 |

**选型判据（可直接口述）**：先问两个问题——任务**能否预先分解**？**是否需要合规留痕与全局停止**？两者皆"是"选 Supervisor，皆"否"选 Swarm。实践中常见混合式：**外层 Supervisor 管边界与审批，内层局部允许动态交接**。

---

## 3. 目录结构

```
.
├── .env                      # 本地真实密钥（已 gitignore，绝不提交）
├── .env.example              # 配置模板，只有占位符
├── .gitignore
├── LICENSE                   # MIT
├── README.md
├── docker-compose.yml        # pgvector/pgvector:pg16，首启自动执行 schema.sql
├── package.json
├── scripts/
│   └── selfcheck.js          # 配置/依赖/密钥泄漏自检；--live 实测真实 LLM
├── src/
│   ├── cli.js                # 命令行入口（--provider / --storage / --no-trace ...）
│   ├── run.js                # 组装依赖并运行一次会话
│   ├── config/env.js         # 配置加载、校验、脱敏、LangSmith 开关
│   ├── observability/langsmith.js  # run tags / metadata / trace 提示
│   ├── llm/
│   │   ├── factory.js        # fake | openai(DeepSeek) 工厂 + thinking mode 处理
│   │   ├── fakeModel.js      # 继承 BaseChatModel 的确定性本地模型
│   │   └── embeddings.js     # 确定性向量 / OpenAI 兼容 embeddings
│   ├── agents/
│   │   ├── state.js          # Annotation 状态 + reducer
│   │   ├── context.js        # 把子 Agent 产出折叠成 observation
│   │   ├── events.js         # 可选 onEvent 事件协议（Web SSE 的数据源）
│   │   ├── tools.js          # retrieve_knowledge / calculate / get_current_time / route
│   │   ├── supervisor.js     # 路由节点 + 三重护栏
│   │   └── workers.js        # 最小 agent harness（LLM ↔ 工具循环）
│   ├── graph/buildGraph.js   # StateGraph 拓扑 + 条件边
│   ├── web/
│   │   ├── server.js         # node:http 零依赖服务：静态资源 + SSE + 运行 API
│   │   └── runner.js         # app.stream updates 模式 + 按 reducer 累积最终状态
│   └── memory/
│       ├── vectorStore.js    # 内存 cosine / pgvector <=> 检索，两种后端同接口
│       ├── checkpointer.js   # MemorySaver / PostgresSaver
│       ├── seed.js           # 内置面试知识库片段
│       └── schema.sql        # CREATE EXTENSION vector + HNSW 索引示例
├── web/                      # 前端控制台（原生 ESM，零构建、零 CDN）
│   ├── index.html            # 三栏布局 + 星形拓扑 SVG
│   ├── app.js                # EventSource 消费 SSE、拓扑高亮、Markdown 渲染
│   ├── style.css             # CSS 变量双主题（跟随系统，可手动切换）
│   └── favicon.svg
└── test/
    ├── graph.test.js         # 8 个用例，全程零密钥零网络
    └── web.test.js           # 3 个用例：配置接口 / 静态资源 / SSE 全链路
```

---

## 4. 三档运行模式

| 档位 | 配置 | 外部依赖 | 用途 |
| --- | --- | --- | --- |
| **A. 零成本** | `LLM_PROVIDER=fake` + `STORAGE_BACKEND=memory` + `CHECKPOINTER=memory` | 无 | 跑通链路、跑测试、断网演示；语义质量退化 |
| **B. 真实大模型** | A + `LLM_PROVIDER=openai`（DeepSeek） | DeepSeek API | 真实语义、真实 tool calling、LangSmith trace |
| **C. 全量生产形态** | B + `STORAGE_BACKEND=postgres` + `CHECKPOINTER=postgres` | Docker + pgvector | pgvector 检索 + 状态持久化 |

嵌入式设计（面试要点）：**LLM、Embeddings、向量库、Checkpointer 四个维度各自独立可切换**，不是"一刀切"的开关。比如可以只把 Checkpointer 换成 Postgres，其余仍用 memory。

---

## 5. 快速开始

```bash
npm install
cp .env.example .env        # 按需填写；.env 已被 gitignore
```

### 5.1 档位 A：零密钥零成本跑通

```bash
npm test                                  # 8/8 用例
npm start -- --provider fake --no-trace   # 完整链路
```

预期路由轨迹：

```
round 1: supervisor -> researcher
round 2: worker=researcher tools=[retrieve_knowledge] iterations=1
round 2: supervisor -> analyst
round 3: worker=analyst tools=[calculate] iterations=1
round 3: supervisor -> writer
round 4: worker=writer tools=[] iterations=0
round 4: supervisor -> FINISH
```

### 5.2 档位 B：接真实大模型

`.env` 中：

```dotenv
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxxxxxxxxxxxxxxx
LLM_MODEL=deepseek-flash
LLM_THINKING=disabled
LLM_TEMPERATURE=0.2
LLM_TIMEOUT_MS=20000
```

```bash
npm start                                  # 真实 DeepSeek 跑完整链路
npm start -- -q "对比 Supervisor 和 Swarm 的取舍"
node scripts/selfcheck.js --live           # 只打一次 LLM 验证连通
```

实测可用模型（`/v1/models`）：`deepseek-flash`（DeepSeek-V4.1-Flash）、`deepseek-v4-pro`。旧的 `deepseek-chat` / `deepseek-reasoner` 已下线。

### 5.3 档位 C：起 PostgreSQL + pgvector

```bash
npm run db:up       # docker compose up -d，首启自动执行 schema.sql
```

把 `.env` 改成：

```dotenv
STORAGE_BACKEND=postgres
CHECKPOINTER=postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/supervisor_demo
EMBEDDINGS_PROVIDER=openai          # 可选：换成真实 embedding 服务
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDINGS_API_KEY=...
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_DIM=1024                 # 维度变了必须重建表
```

```bash
npm start
psql "$DATABASE_URL" -c "SELECT count(*) FROM checkpoints;"   # 图跑过之后有快照
```

> ⚠️ 诚实说明：开发机上没有 Docker / psql，所以 **档位 C 的代码与 SQL 已完整实现，但未在本机实跑**；档位 A、B、D 均已实跑验证。

### 5.4 档位 D：Web 控制台（实时可视化运行轨迹）

```bash
npm run web                 # 默认 http://127.0.0.1:5173
WEB_PORT=8080 npm run web   # 自定义端口
```

页面是三栏结构：**左栏**填任务、选 `fake`/`openai` 档、开/关 LangSmith 上报、指定 `thread_id`；**中栏**是星形拓扑 SVG（当前节点脉冲高亮、路由连线流动）+ 轮次/工具数/耗时统计 + 三个 Worker 产出卡片 + Markdown 最终答案；**右栏**是按时间线滚动的实时事件流，可按「路由 / 工具 / 产出」过滤。`⌘/Ctrl + Enter` 直接启动，长工具返回可折叠查看。

**为什么值得做这一层**：CLI 用 `invoke`，只在整条链路跑完后一次性输出，面试讲解时看不到「Supervisor 为什么这样路由」「Worker 究竟调了什么工具、拿回什么结果」。Web 层改用 `app.stream({ streamMode: "updates" })`，配合节点内一个**可选**的 `onEvent` 回调把过程实时推给浏览器；不传回调时核心链路与 CLI 完全一致（8 个原有测试零改动通过）。

| 文件 | 职责 |
| --- | --- |
| `src/agents/events.js` | 定义事件类型与 `emit()`；回调自身异常被吞掉，展示层故障绝不影响 Agent 执行 |
| `src/web/runner.js` | `app.stream` 逐节点吐 updates，按 `AgentState` 的 reducer 语义自己累积最终状态（不依赖 `getState`，少一次 IO） |
| `src/web/server.js` | `node:http` 零依赖：`POST /api/run`、`GET /api/events/:id`（SSE）、`GET /api/config`、`POST /api/stop/:id` |
| `web/app.js` | `EventSource` 消费 SSE，驱动拓扑高亮、时间线、Worker 卡片与答案渲染 |

SSE 事件协议：

| 事件 | 触发点 | 页面呈现 |
| --- | --- | --- |
| `meta` | runner 启动 | 配置徽章、`thread_id`、护栏参数 |
| `node` | 节点 start / end | 拓扑高亮（「显示详细事件」开启时可见） |
| `route` | Supervisor 每次决策 | `Supervisor → X`、决策 reason、护栏拦截标记 |
| `tool` | Worker 工具调用前 / 返回后 | 调用参数、完整返回、耗时 ms |
| `worker` | Worker 产出 | 对应产出卡片 + 字数 / 迭代数 |
| `state` | 节点写回 updates | `rounds` / `visited` 统计 |
| `final` / `error` / `done` | 收尾 | 最终答案 / 报错提示 / 关闭流 |

几个可以直接拿去讲的取舍：

- **SSE 而非 WebSocket**：数据方向只有「服务端 → 浏览器」，浏览器原生 `EventSource` 自带断线重连与 `Last-Event-ID`；控制命令走普通 `POST`。服务端几十行 `node:http` 就够，不引入 `ws` / `express`。
- **事件不进 state**：state 是决策依据，会被 Checkpointer 持久化并喂给模型；事件是给人看的轨迹，包含工具参数、耗时、中间失败，绝不回流进 LLM 上下文。这是「横切关注点」与「状态边界」的分离 —— 面试里很容易被追问。
- **事件缓存 + 回放**：`POST /api/run` 先返回 `runId`，浏览器随后才建立订阅；服务端按 `seq` 缓存全部事件，因此即使运行已经开始也不会丢，重连时只补增量。串行单运行（`activeRunId`）是为了避免 LangChain tracer「按每次 run 动态读环境变量」导致并发时 tracing 开关互相串；每次运行前还会恢复 LangSmith 环境快照，因为 `configureLangSmith()` 关闭 tracing 时会 `delete` 掉 key。
- **安全**：服务只监听 `127.0.0.1`，静态资源走白名单映射（不接受任意路径拼接），`/api/config` 只返回 `describeConfig()` 的脱敏摘要，密钥始终留在服务端 `.env`；前端所有模型输出都先转义再插入 DOM。
- **零构建零 CDN**：原生 ESM + CSS 变量双主题，完全离线可用；和 LangSmith 是互补关系 —— 一个自托管实时 UI，一个持久化 run tree 离线分析。

---

## 6. LangSmith 接入

只需环境变量，**业务代码零侵入**（LangChain.js 在每次 run 时动态读取）：

```dotenv
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_pt_xxxxxxxx
LANGSMITH_PROJECT=multi-agent-supervisor-demo
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```

`src/config/env.js` 同时写新旧两套变量名以兼容不同 tracer 版本；`src/observability/langsmith.js` 给根 run 打上 `llm:openai` / `vector:memory` / `checkpointer:memory` 等 tags 和 metadata，方便按档位过滤对比。

trace 层级：`根 run(图) → supervisor / worker 节点 → 每次 LLM 调用 → 每次工具调用`。每层都有 input/output/latency/token。排查多 Agent 死循环、路由错误、工具幻觉时，先看 supervisor 的 route 参数，再看对应 worker 的工具往返。

- `--no-trace` 可单次关闭；
- `npm test` 强制关闭，测试不产生网络噪音；
- trace metadata **刻意不含任何密钥**。

---

## 7. 关键实现讲解

### 7.1 状态与 reducer — `src/agents/state.js`

`Annotation.Root({ ...MessagesAnnotation.spec, ... })`。`messages` 复用官方追加语义（支持按 message id 覆盖/删除），`next` 覆盖、`visited` 集合并集、`rounds` 累加、`trace` 追加。**reducer 决定并发节点写同一字段时如何合并**，不是简单的赋值。

### 7.2 条件边 — `src/graph/buildGraph.js`

Supervisor 把决策写进 `state.next`，`addConditionalEdges("supervisor", s => s.next, pathMap)` 跳转，每个 Worker 用 `addEdge(name, "supervisor")` 回中心。

> 也可以用 `return new Command({ goto })`，两者都合法。本项目选前者的理由：**控制流显式画在图上、每次决策都留在状态快照里、可回放可断言**——面试时更好解释，也更贴合"中心化"的语义。

### 7.3 结构化路由 — `src/agents/supervisor.js` + `tools.js`

给 Supervisor 绑定一个 `route` 工具（`next` 是 enum + `reason` + `instruction`），要求**必须调用**，再从 `tool_calls` 里取参数。比"让模型输出 JSON 再正则解析"稳得多：schema 可校验、非法值可白名单拦截。

### 7.4 最小 agent harness — `src/agents/workers.js`

`prompt → LLM → 解析 tool_calls → 执行工具 → ToolMessage 回填 → 循环`，直到模型不再请求工具或达到 `MAX_TOOL_ITERATIONS`。两个必备护栏：迭代上限防死循环；工具异常转成文本回填，不让单个工具失败炸掉整张图。

Worker 只把**最终 AIMessage（带 name）**写回全局状态，中间的工具往返留在节点内部，避免上下文膨胀。

### 7.5 observation 折叠 — `src/agents/context.js`

**不要把别的 Agent 的产出当成"本模型自己说过的 assistant 消息"塞进历史**。本项目把它折叠成一条 HumanMessage 观察。三个理由：语义上更准确、规避推理模型的 `reasoning_content` 校验（见 7.7）、压缩上下文噪声。

### 7.6 Embeddings 独立选型 — `src/llm/embeddings.js`

**DeepSeek 只提供 `/chat/completions`，不提供 `/embeddings`**。所以 pgvector 的向量化必须单独选型，不能复用 LLM 的 baseURL/key。本项目提供确定性哈希向量（fake，中文按单字 + bigram 哈希，零成本）和 OpenAI 兼容 embeddings 两档。切换模型时维度可能变化，必须同步改 `EMBEDDINGS_DIM` 并重建表。

### 7.7 推理模型的真实坑：`reasoning_content` 400

这是本项目**真实踩到并修掉**的问题，很值得在面试里讲。

`deepseek-flash` 默认开启 thinking mode，响应里带 `reasoning_content`。官方文档规定：**只要请求带 `tools`，之前每一轮 assistant 消息的 `reasoning_content` 都必须原样回传，否则直接 HTTP 400**。而多 Agent 系统里 Supervisor / Worker 会反复把别的 Agent 产出拼进历史，这些是我们 `new AIMessage()` 构造的，天然没有该字段 → 必炸。

两层修复：

1. **默认 `LLM_THINKING=disabled`**，通过 `modelKwargs: { thinking: { type: "disabled" } }` 关闭。实测 `extraBody` **不生效**，只有 `modelKwargs` 会合并进请求体。附带好处：更快、更省，且 `temperature` 真正生效（thinking mode 下 temperature 被忽略）。
2. **observation 折叠**（7.5）让历史里不再有"伪造的 assistant 消息"，因此把 `LLM_THINKING=enabled` 也能正常跑通（已实测）。

### 7.8 pgvector — `src/memory/vectorStore.js` + `schema.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE INDEX ... ON documents USING hnsw (embedding vector_cosine_ops);
-- 检索：1 - (embedding <=> $1::vector) AS score
```

`<=>` 是 pgvector 的余弦距离算子；HNSW 相比 IVFFlat 在召回率/查询延迟上更优。两档后端实现同一个 `similaritySearchWithScore(query, k)` 接口，上层工具完全无感。

### 7.9 Checkpointer — `src/memory/checkpointer.js`

每个 superstep 后持久化状态快照；`thread_id` 隔离会话；`MemorySaver` → `PostgresSaver` 是测试到生产的路径。配合 `interrupt` / breakpoint 可做 human-in-the-loop 审批与断点续跑。**它不参与路由决策**，与条件边是正交的两层。

### 7.10 护栏 — `supervisor.js`

| 护栏 | 作用 |
| --- | --- |
| `MAX_ROUNDS` | Supervisor 最大轮次，防跨 Worker 死循环 |
| `MAX_TOOL_ITERATIONS` | 单 Worker 内工具循环上限 |
| 路由白名单 | 拦截模型幻觉出的节点名 |
| `visited` 去重 | 防止重复调度同一 Worker |
| writer 后强制 FINISH | 保证图一定收敛 |
| `recursionLimit` | LangGraph 自身的最后一道保险 |

---

## 8. 设计取舍对照表

| # | 决策点 | 选择 | 为什么 | 代价 / 何时该换 |
| --- | --- | --- | --- | --- |
| 1 | LLM 接入 | `fake \| openai` 工厂 | 链路验证不依赖密钥，一键切真实模型 | fake 无语义；要评估质量必须用真实模型 |
| 2 | 路由输出 | function calling 而非解析文本 | schema 可校验、可白名单 | 多一次工具定义；小模型可能不会调工具 |
| 3 | 控制流 | `next` 字段 + 条件边 | 控制流画在图上、决策可回放 | 多一个状态字段；极简场景 `Command(goto)` 更短 |
| 4 | 子 Agent 产出 | 折叠成 observation | 语义正确 + 规避推理模型 400 | 丢失原始消息结构，需要按 id 覆盖时不适用 |
| 5 | thinking mode | 默认 disabled | 路由不需深推理；更快更省；temperature 生效 | 复杂推理任务应 enabled（本项目已兼容） |
| 6 | Embeddings | 与 LLM 解耦 | DeepSeek 无 embeddings | fake 只有词面重叠信号，无语义 |
| 7 | pgvector 实现 | 手写 `pg` SQL，不用 community 包 | 依赖从 41 个包起步、能看到 `<=>`/HNSW、避开 peer 冲突 | 少了官方维护；接口已对齐，替换成本低 |
| 8 | Checkpointer | memory / postgres 双档 | 本机零依赖即可跑，生产可持久化 | MemorySaver 进程重启即失 |
| 9 | 可观测 | 环境变量 + tags/metadata | 零代码侵入，run tree 定位问题 | 依赖外部服务；`--no-trace` 可关 |
| 10 | 密钥 | `.env` + gitignore + 自检扫描 | 公开仓库不泄密 | 多一步 `npm run check` |
| 11 | Worker 内部循环 | 手写 harness | 能讲清 tool_calls 往返，面试价值高 | 生产可用框架预置的 `createReactAgent` |
| 12 | 语言 | 全 JS / ESM | 与全栈栈一致，一套语言贯穿 | LangChain JS 生态比 Python 小，部分新特性滞后 |

---

## 9. 面试高频问答

**Q1：Supervisor 和 Swarm 的本质区别？**
控制流所有权。Supervisor 是星形，所有跨 Agent 通信经中心，换来审计/限流/统一记忆/全局停止，代价是单点与延迟瓶颈；Swarm 是 handoff 直连，换来探索性，代价是可观测性差、终止难保证。判据是「任务可分解性 + 合规留痕需求」。

**Q2：为什么本项目用条件边，而不是 `Command({ goto })`？**
两者等价，但写 `next` 字段 + 条件边把控制流显式画在图上，每次决策都进状态快照，可断言、可回放、能在 LangSmith 里按 `next` 过滤。中心化架构强调"决策集中且可审计"，这个写法更贴合语义。

**Q3：条件边和 Checkpointer 分别解决什么？**
正交的两层：**条件边管走向（控制层，运行时动态路由）；Checkpointer 管留存（状态层，快照持久化与会话隔离）**。后者不参与路由，但恢复时会把 `next` 一起恢复，图才知道接着往哪走。

**Q4：reducer 有什么用？**
决定多个节点并发写同一字段时如何合并。`messages` 用追加（且支持按 id 覆盖/删除），`rounds` 累加，`next` 覆盖。没有 reducer，并行分支下会读到脏值或直接报错。

**Q5：多 Agent 怎么防止死循环和成本失控？**
分层兜底：Supervisor 的 `MAX_ROUNDS`、Worker 内的 `MAX_TOOL_ITERATIONS`、路由白名单、`visited` 去重、writer 后强制 FINISH、LangGraph 的 `recursionLimit`。再往外是超时、重试上限、token 预算和 LangSmith 告警。

**Q6：为什么需要 fake LLM？它是不是把链路短路了？**
不是。fake 继承 `BaseChatModel`，仍是标准 Runnable，**照样走 bindTools → tool_calls → ToolMessage 回填 → LangSmith run**，只是用确定性规则代替语义理解。因此零密钥零成本也能验证完整链路与全部护栏。

**Q7：DeepSeek 没有 embeddings，RAG 怎么办？**
把 embedding 当作独立服务选型：换硅基流动 BGE / OpenAI embeddings，或离线验证阶段用确定性哈希向量。**切换模型的第一个动作是确认维度并重建 pgvector 表**，否则插入直接报错。

**Q8：pgvector 的 `<=>` 和 HNSW 是什么？**
`<=>` 是余弦距离算子，`1 - (embedding <=> query)` 得到相似度；HNSW 是 ANN 索引，比 IVFFlat 在召回率与延迟上更均衡。pgvector 的优势是向量与业务数据同库、可事务、可 SQL 过滤；代价是要自己管维度、索引重建与召回调优。

**Q9：LangSmith 接入要改业务代码吗？**
不用，环境变量即可。真正要做的是给根 run 打 tags/metadata（模型档位、存储档位、thread），否则几十次实验混在一起没法对比。run tree 的层级是 图 → 节点 → LLM → 工具。

**Q10：推理模型接 Agent 框架最容易踩什么坑？**
thinking mode 的 `reasoning_content` 回传。带 tools 的请求要求历史里每轮 assistant 都带该字段，而多 Agent 里"别的 Agent 的产出"是伪造的 assistant 消息，必然缺字段 → 400。解法：关闭 thinking；或把子 Agent 产出折叠成 observation；或完整透传原始推理字段。

**Q11：`thread_id` 有什么用？怎么实现 human-in-the-loop？**
它是 Checkpointer 的会话隔离键。同一 id 再 invoke 会接着上次状态；配合 breakpoint 在敏感节点前暂停、人工审批后从快照继续，还能回溯到任意 superstep。

**Q12：生产化还缺什么？**
并发与幂等、真实 ingest 管道（切分/去重/增量 upsert）、权限与工具沙箱、结构化错误与降级、成本/超时预算、评测集与回归、密钥托管（Vault/KMS）、以及把 Supervisor 的路由做成可回放可灰度。

---

## 10. 已知限制

- 档位 C（Postgres + pgvector）代码与 SQL 完整，但**开发机无 Docker，未实跑**；建议 `npm run db:up` 后自行验证。
- `calculate` 用字符集白名单 + `Function` 求值，适合教学；生产应换成真正的表达式解析器或沙箱。
- 内置知识库是 11 条静态种子文档，用于演示检索链路，不是真实语料管道。
- fake 档是确定性应答，**语义质量会退化**，只用于验证链路与护栏，不用于评估答案质量。
- 未做人机协同审批（breakpoint）示例，Checkpointer 已具备该能力的基础。

---

## 11. 密钥安全

公开仓库里**没有任何真实密钥**：

- `.env` 存放真实 key，被 `.gitignore` 排除；
- `.env.example`、README、源码、测试里只有占位符；
- 所有配置从 `process.env` 读取，日志与 trace metadata 只显示脱敏值；
- `scripts/selfcheck.js` 会**从 `.env` 动态读出真实密钥值**，扫描所有待提交文件是否包含它们（测试代码里也刻意不写字面量，否则"检查泄漏的代码"自己就成了泄漏源）；
- 推送前执行：`node scripts/selfcheck.js`，看到「未发现泄漏 ✓」再提交。

```bash
npm run check              # 配置 / 依赖 / 密钥扫描
npm run check -- --live    # 额外打一次真实 LLM
```

---

## 12. 验证记录

| 项 | 结果 |
| --- | --- |
| `npm test` | **11/11 通过**（8 个核心用例 + 3 个 Web / SSE 用例） |
| 档位 A fake 链路 | ✅ researcher → analyst → writer → FINISH，4 轮，工具与检索均生效 |
| 档位 B 真实 DeepSeek（thinking disabled） | ✅ 跑通，writer 产出结构化架构分析 |
| 档位 B 真实 DeepSeek（thinking enabled） | ✅ 跑通，observation 折叠规避了 400 |
| 档位 D Web 控制台 | ✅ 单次运行推送 34 个事件；`meta → route → tool → worker → final → done` 全链路，fake 与真实模型均可驱动 |
| LangSmith tracing | ✅ 开启并写入 project `multi-agent-supervisor-demo` |
| 密钥泄漏扫描 | ✅ 0 处 |

---

MIT License · 仅供学习与面试准备使用
