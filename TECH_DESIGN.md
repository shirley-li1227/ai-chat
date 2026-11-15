# 技术设计文档

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器                                 │
│   React 19 + TypeScript + Tailwind CSS 4                    │
│   ┌─────────────────┐  ┌──────────────────┐                 │
│   │ ChatInterface   │  │ ApiConfigModal   │                 │
│   └────────┬────────┘  └────────┬─────────┘                 │
│            └──────────┬──────────┘                           │
│                 src/client.ts (API 层)                       │
└────────────────────────┬─────────────────────────────────────┘
                    │ HTTP / SSE（本地同源 /api/*；云端跨域，见「云端部署架构」）
┌────────────────────────▼─────────────────────────────────────┐
│              Vite Dev Server (:5173)                          │
│         proxy: /api → http://localhost:3001                   │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│              NestJS Backend (:3001)                           │
│  ┌────────────┐  ┌──────────────────┐  ┌──────────────┐     │
│  │ConfigModule│  │ConversationsModule│  │  ChatModule  │     │
│  │ (CRUD)     │  │ (CRUD + 级联)     │  │ (SSE 代理)   │     │
│  └─────┬──────┘  └────────┬─────────┘  └──────┬───────┘     │
│        └───────────────────┼───────────────────┘             │
│                    TypeORM + sql.js                           │
│            (functions/api/data/app.db)                        │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTPS + SSE
┌────────────────────────────▼─────────────────────────────────┐
│                    DeepSeek API                               │
│         https://api.deepseek.com/chat/completions             │
└──────────────────────────────────────────────────────────────┘
```

## 云端部署架构

```
浏览器  https://<envId>-<appid>.tcloudbaseapp.com   （CloudBase 静态托管，写在托管桶根目录）
  │  fetch https://<envId>.service.tcloudbase.com/api/*   ← 跨域，BASE 写死在 client.ts
  ▼
CloudBase HTTP 网关
  ├─ 路由 /api：enablePathTransmission=true（后端自带 /api 前缀，剥掉就全量 404）
  ├─ 安全域名注入 CORS 并直接应答 OPTIONS 预检（204，不拉起函数实例）
  └─ 匿名访问 public: true（网关 OPA 未拦截）
  ▼
HTTP 云函数 api（Runtime Nodejs20.19，入口 scf_bootstrap，NestJS 监听 9000，timeout 300s）
  ▼
数据层：DB_TYPE=sqljs    → /tmp/app.db（实例私有，仅演示）
        DB_TYPE=postgres → VPC 内网 PG（多实例共享，正式环境）
```

关键约束：

| 项 | 说明 |
|----|------|
| SSE 与函数超时 | 默认 5 秒会砍断流，必须 `timeout: 300`；响应头 `X-Accel-Buffering: no` 阻止网关缓冲 |
| CORS 只能一层 | Nest `enableCors` 与网关安全域名会各加一份 ACAO；函数侧 `CORS_ORIGINS` 留空，只靠网关 |
| 实例粘性 + `/tmp` | sqljs 下 config / 对话不跨实例共享；chat 先用 `ensureExists()` 补建对话规避 404，根治要切 postgres |
| 限流 | `ThrottlerGuard` 计数在进程内存，实际放行量 ≈ limit × 实例数，需网关限频兜底 |
| 部署产物 | `ignore` 排除 `src` 与 `evals`，云端执行包内 `dist/`，改源码必须重新 build + deploy |
| 摘要与多实例 | `contextSummary`/`summaryUntil` 跟着库走；sqljs 下冷启动会连同摘要一起丢失（切 postgres 根治），但不会造成“摘要覆盖不存在的消息”这类错乱 |
| 路径区分产品 | `tcb hosting` 写托管桶根目录、无“部署记录”；`*.webapps.tcloudbase.com` 是另一个产品云应用 WebApps，本项目不用 |

## 技术选型

| 层面 | 选择 | 理由 |
|------|------|------|
| 前端框架 | React 19 + Vite 8 | 快速 HMR、生态成熟 |
| 样式 | Tailwind CSS 4 | 原子化、无运行时开销 |
| Markdown | react-markdown + remark-gfm | 支持 GFM 表格/任务列表/删除线 |
| 代码高亮 | react-syntax-highlighter (Prism) | 按需加载、100+ 语言 |
| 后端框架 | NestJS 11 | 模块化、DI、装饰器风格 |
| ORM | TypeORM 0.3 | NestJS 官方推荐、装饰器实体 |
| 数据库 | sql.js (SQLite in WASM) / PostgreSQL | 本地零配置演示；多实例云端必须共享库 |
| 大模型 | DeepSeek | 官方 CORS 友好、兼容 OpenAI 协议、价格低 |

## 数据模型

### ApiConfig（单行表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| provider | varchar | 供应商标识（'deepseek'） |
| apiKey | varchar(512) | AES-256-GCM 密文，格式 `gcm1:<iv-hex>:<tag-hex>:<cipher-b64>`；主密钥缺失时拒绝保存，不退化成明文 |
| baseUrl | varchar | API 基地址 |
| model | varchar | 模型名称 |
| createdAt | datetime | 创建时间 |
| updatedAt | datetime | 最后更新时间 |

### Conversation

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| title | varchar | 对话标题（自动取首条用户消息前 24 字） |
| contextSummary | text, nullable | 滑出上下文窗口的旧轮次归并成的**滚动摘要**；存库里而不是每轮重算，否则对话越长压缩成本反超节省量 |
| summaryUntil | bigint, nullable | 摘要已覆盖到的消息时间戳（含）。时间戳 ≤ 该值的消息视为“已在摘要里”，避免同一段对话既在摘要里又原文重发 |
| createdAt | datetime | 创建时间 |
| updatedAt | datetime | 最后更新时间 |

> `contextSummary` / `summaryUntil` 只在服务端组装上下文时使用，不随 `GET /api/conversations/:id` 返回给前端；`truncateFrom` 在删除消息时若发现摘要已覆盖被删范围（`summaryUntil >= fromTimestamp`）会一并作废，避免摘要里残留根本不存在的对话。

### Message

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| role | varchar | 'user' 或 'assistant' |
| content | text | 消息正文 |
| toolCalls | text, nullable | Agent 工具轨迹 JSON（id/name/arguments/result/ok），仅 assistant 消息有值；既供前端展示步骤，也供多轮还原 tool_calls 上下文 |
| timestamp | bigint | 毫秒时间戳（前端排序用） |
| conversation | FK → Conversation | 所属对话（CASCADE 删除） |

## API 接口设计

### 健康检查

| Method | Path | 响应 |
|--------|------|------|
| GET | `/api/health` | `{ status, database: up/down, encryption: enabled/disabled, promptVersion }` |

全局：所有接口受 `ThrottlerGuard` 按 IP 限流（`THROTTLE_TTL` / `THROTTLE_LIMIT`）。

### 配置管理

| Method | Path | 请求体 | 响应 |
|--------|------|--------|------|
| GET | `/api/config` | — | `{ configured, provider, baseUrl, model, apiKeyMasked }` |
| POST | `/api/config` | `{ provider, apiKey, baseUrl, model }` | 实体对象 |
| DELETE | `/api/config` | — | `{ success: true }` |

### 对话管理

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/conversations` | 列表（createdAt DESC，不含 messages） |
| POST | `/api/conversations` | 新建，返回含 id 的完整对象 |
| GET | `/api/conversations/:id` | 含完整 messages（timestamp ASC） |
| PATCH | `/api/conversations/:id` | 更新 title |
| DELETE | `/api/conversations/:id` | 级联删除所有 messages |
| POST | `/api/conversations/:id/truncate` | 请求体 `{ fromTimestamp }`，删除 `timestamp >= fromTimestamp` 的消息，返回 `{ removed, summaryReset }`。“重新生成”与“编辑重发”共用此入口；按时间戳而非消息 id 删除，与前端列表以 timestamp 为 key 保持同一套坐标系 |

### 聊天（核心）

`POST /api/chat`

请求体：
```json
{ "conversationId": "uuid", "content": "用户输入" }
```

响应：SSE 流，每帧一个 JSON 对象（`data: {...}\n\n`）

| 事件 | 载荷 | 说明 |
|------|------|------|
| 正文 | `{"content":"你"}` | 逐字增量，前端拼到当前气泡 |
| 工具开始 | `{"tool":{"id","name","args","status":"calling"}}` | 模型决定调用工具；**同一轮的多个调用会先全部发出再并发执行**，展示顺序与执行完成顺序无关 |
| 工具结束 | `{"tool":{"id","name","result","ok","status":"done"}}` | 结果按 `tool_calls` 原顺序回填，前端靠 `id` 对位更新 |
| 提示 | `{"notice":"…被截断…"}` | 非致命提示（如输出撞长度上限） |
| 错误 | `{"error":"具体错误信息"}` | 上游 4xx/5xx、轮数耗尽、网络异常 |
| 结束 | `data: [DONE]` | 流终止信号 |

业务异常仍走 HTTP 状态码（在 SSE 头写出之前抛出）：未配置 Key → `400 尚未配置大模型 API…`。

## 核心流程

### 发送消息

1. 前端调用 `streamChat(conversationId, content, callbacks, signal)`；`App.tsx` 在 `pagehide` 与组件卸载时主动 `abort()`，及时停掉后端对上游的请求
2. 后端 ChatService：
   - 从 DB 读取并解密 ApiConfig，缺失直接抛 `400`
   - `ensureExists(conversationId)` 补齐缺失对话（应对多实例/冷启动）
   - 存入 user message
   - `buildContext()`：一次 `loadContext()` 取回全部消息 + 摘要边界 → 扣除摘要自身占用后得到窗口预算 → `planWindow()` 从最新往回保留、旧轮次滑出 → 滑出部分 `buildRollingSummary()` 压缩并 `saveContext()` 推进边界（详见下节）
   - 保留的消息按 `toolCalls` 还原为 `assistant.tool_calls` + `role: tool` 消息，拼成 `[system, summary?, ...history]`，带上 `tools` 与 `stream: true`
   - 多轮循环（上限 `AGENT_MAX_TURNS`）：模型返回 tool_calls 就执行工具、结果回填后重新请求，直到产出纯文本
   - 逐 chunk 透传 SSE（`content` / `tool` / `notice` / `error`）
   - 流结束后存入 assistant message（含工具轨迹）
3. 前端回调更新 UI：正文逐字追加，工具步骤在气泡内单独展示状态

### 上下文窗口与滚动摘要

定义在 `functions/api/src/chat/`：`token-estimator.ts`（估算+裁剪）、`context-summarizer.ts`（压缩）、`llm-client.ts`（非流式内部调用）。

| 环节 | 做法 | 为什么这样选 |
|------|------|------|
| token 估算 | CJK 1 字/token、其他 4 字符/token、每条消息 +4、工具轨迹按 JSON 原文计入 | 不装 tiktoken/gpt-tokenizer：DeepSeek 分词器与 cl100k 并不一致，装一个“精确到别的模型”的库反而给人虚假安全感；这里只需决定“丢多少轮”，±20% 误差只影响窗口边界一两轮 |
| 滑窗 | `planWindow(messages, budget)` 从最新往回累加，超出即停 | **最新一条无条件保留**：丢了它本轮请求就没有用户问题，比撞上限更糟 |
| 摘要 | `SUMMARY_PROMPT` + `completeOnce()` 非流式调用，失败退回抽取式 `extractiveDigest` | 摘要边界 `summaryUntil` 随裁剪一起推进，同一段旧对话不会被反复压缩，也不会既在摘要里又原文重发 |
| 工具轨迹 | 不进摘要（它的结论已体现在 assistant 正文里） | 重复计入只会推高压缩成本 |
| 成本控制 | 摘要正文自身也要吃额度，先扣 `estimateTokens(priorSummary)` 再算窗口 | 否则摘要越长、窗口越窄会形成正反馈 |

环境变量：`CONTEXT_TOKEN_BUDGET`（默认 6000）、`CONTEXT_SUMMARY_ENABLED`（`false` 则只裁剪不压缩，旧上下文直接退出）。

### 工具并发执行

一轮返回多个 `tool_calls` 时，不再 `for...of await` 串行，而是先统一登记步骤并发出 `calling` 事件，再交给 `agent/tool-runner.ts` 的 `runWithConcurrency(items, limit, worker)`。

- 上限 `AGENT_TOOL_CONCURRENCY`（默认 4）。必须封顶：模型一次返回十几个 `fetch_url` 完全可能，不设上限等于**让模型决定实例的出站连接数**，在 256MB 内存的函数实例里很容易失控
- 不用裸 `Promise.allSettled(items.map(...))`：那样会一次性启动全部任务。这里用 N 条 worker 抢任务号，并发度可控，同时保留“单个失败不影响整体”的语义
- 保序：结果写入按 index 预分配的槽位，与完成先后无关，因此回填给上游的 `role: tool` 消息顺序与 `tool_calls` 一致
- 错误隔离：worker reject 仅体现为该槽位的 `{ok:false, reason}`（`executeTool` 内部已吃掉异常，这层只为未来可能 reject 的工具兼容）

### 提示词版本化与回归评测

SYSTEM_PROMPT / SUMMARY_PROMPT 从 service 里抽到 `chat/prompt.ts`，并导出 `PROMPT_VERSION`：

- 单独成文件是为了让评测脚本在**不启动服务**的前提下引用同一份提示词
- 版本号随 `/api/health` 暴露，`evals/cases.json` 钉住同一个版本；两边不一致时评测直接失败，强制“改提示词 → 确认预期 → 升版本”这个动作不被遗漏
- 正文含三块：工具使用准则、工具判定示例（few-shot，只示范该不该调、调哪个、参数怎么给）、输出格式规范

`npm run eval`（离线，21 条用例 + 结构不变量，无需网络与 Key）覆盖：工具计算与异常、SSRF 护栏（元数据端点/回环/私网/非 http 协议）、`planWindow` 裁剪语义、并发上限与保序、`baseUrl` 归一化。`npm run eval:online` 用 `EVAL_API_KEY` 做非流式请求，断言 `expectTool` 命中率，可用 `--min-accuracy` 卡下限。在线模式缺 Key 时报错退出而不是静默通过。

> 评测集已经发现过两个真实缺陷：calculator 的标识符正则不含数字，`log10(1000)` 被切成 `log`+`10` 报“需要括号参数”；另一个是用例自写错（期望“星期X”，工具实际输出“周日”）—— 后者提醒断言要对着实现写，而不是对着描述文字写。

### 安全设计

- API Key 经 AES-256-GCM 加密后落库，主密钥 `ENCRYPTION_KEY` 从环境变量注入；`GET /api/config` 只返回 `apiKeyMasked`
- 主密钥缺失或格式非法时拒绝保存，错误信息里直接给出生成命令；不会退化成明文落库。读到历史明文配置会在密钥可用时自动加密回写
- 前端不直连 DeepSeek，密钥不进入浏览器
- `fetch_url` 工具走 URL 校验（`security/url-guard.ts`）+ 超时与体积上限，防 SSRF 和超大响应；协议限制、域名黑名单、**字面量 IP 与 DNS 全量解析结果都不能落入内网**，且每跳重定向重新校验
- 本地开发由 Vite proxy 仅转发 `/api/*`；云端跨域只靠网关安全域名放行，函数侧 `CORS_ORIGINS` 留空

## 前端模块职责

| 文件 | 职责 |
|------|------|
| `frontend/src/client.ts` | 封装所有后端 HTTP/SSE 调用（含 `truncateConversation`） |
| `frontend/src/apiConfig.ts` | PROVIDER_PRESETS（给 Modal UI 渲染用）、表单校验工具 |
| `frontend/src/types.ts` | Message / Conversation / ApiConfig / ProviderType 类型 |
| `frontend/src/App.tsx` | 状态管理：对话列表、当前会话、配置状态、发送/停止；`rewindTo` 统一承载“重新生成”与“编辑重发”（先改后端再同步本地）；`pagehide`/卸载时 abort 在途 SSE |
| `frontend/src/components/ChatInterface.tsx` | 纯 UI：侧栏 + 气泡 + 输入框 + Markdown 渲染 + 工具步骤面板；“重新生成”仅给最后一条回答，“编辑重发”仅给历史用户消息 |
| `frontend/src/components/ApiConfigModal.tsx` | 配置弹窗 UI：供应商选择 + Key/Model/BaseURL 表单 |

## 启动命令

```bash
# 终端 1
npm run dev:api                    # NestJS :3001（functions/api）

# 终端 2
npm run dev                        # Vite :5173（自动 proxy /api → :3001）

# 改完提示词/工具后跑回归（先 build 再断言，不需要 Key）
npm run eval

# 只在改动提示词后跑：真实调模型测工具选择命中率
$env:EVAL_API_KEY="sk-..."; npm run eval:online
```

## 扩展方向

已落地（不再是待办）：工具并发执行、上下文窗口裁剪 + 滚动摘要、重新生成 / 编辑重发、提示词版本化 + 回归评测。

- 对话分支：`truncateFrom` 已经是它的地基，缺的是一份“父消息/分支树”数据模型与前端切换 UI
- 历史消息分页/虚拟滚动：现在一次 `GET :id` 拉全量；长对话需后端加分页 + 前端定高虚拟化
- 多路并发 SSE：单路流内能做的是工具并发；“一个请求开多路回答”需先把数据层切到 postgres（`/tmp` 不支持多实例共享）并调高 `InstanceConcurrency`
- 后台长任务：与 HTTP 请求生命周期不匹配（函数硬顶 300 秒、`pagehide` 语义恰好相反），需单独的任务队列
- 多供应商支持：在 `PROVIDER_PRESETS` 中新增条目，后端 ChatService 按 provider 切换请求逻辑
- 文生图：新增 CogView / DALL-E 接口，后端添加 `/api/images/generations` 代理
- 用户认证：加入 JWT + 多用户隔离
- 生产部署：已落地 CloudBase 静态托管 + HTTP 云函数（跨域直调，见上文「云端部署架构」与 README「云端部署」）
- 数据层根治：把 `DB_TYPE` 切到 `postgres`，消除多实例/冷启动导致的配置与历史丢失
