# 技术设计文档

## 系统架构

```
浏览器  React 19 + TS + Tailwind 4
  ├─ ChatInterface / AuthView / ApiConfigModal / TaskPanel
  └─ src/client.ts（统一 API 层：token、SSE 解析）
       │ HTTP / SSE（本地同源 /api/*；云端跨域，见「云端部署架构」）
       ▼
Vite Dev Server :5173 ── proxy /api → :3001（仅本地开发）
       ▼
NestJS Backend :3001
  ├─ AuthModule          注册/登录、Bearer 会话守卫、AUTH_ENABLED 免登录模式
  ├─ ConfigModule        API 配置 CRUD（加密落库）
  ├─ ConversationsModule 对话 & 消息（CASCADE）
  ├─ ChatModule          SSE 代理 + Agent 多轮循环 + 上下文裁剪/摘要
  ├─ TasksModule         后台任务队列与 REST 接口（执行器是**另一个进程**，尚未部署）
  └─ TypeORM + sql.js → functions/api/data/app.db
       │ HTTPS + SSE（stream: true, tools）
       ▼
DeepSeek API  https://api.deepseek.com/chat/completions
```

## 云端部署架构

```
浏览器  https://<envId>-<appid>.tcloudbaseapp.com   （CloudBase 静态托管，写在托管桶根目录）
  │  fetch https://<envId>.service.tcloudbase.com/api/*   ← 跨域，BASE 来自 VITE_API_BASE（frontend/.env.production）
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
| 摘要与多实例 | `contextSummary`/`summaryUntil` 跟着库走；sqljs 下冷启动会连同摘要一起丢失（切 postgres 根治），但不会造成“摘要覆盖不存在的消息”这类错乱 |

> 部署期操作约束（VPC 打通、控制台路径透传与安全域名、上线验收、sqljs 局限的根治步骤）统一写在 README「云端部署（腾讯云 CloudBase）」，此处不重复。

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

### ApiConfig（按账号一行）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| userId | varchar(36), nullable | 归属账号。鉴权上线前的旧行是 NULL，由第一个注册账号认领；同账号取 `updatedAt` 最近的一条 |
| provider | varchar | 供应商标识（'deepseek'） |
| apiKey | varchar(512) | AES-256-GCM 密文，格式 `gcm1:<iv-hex>:<tag-hex>:<cipher-b64>`；主密钥缺失时拒绝保存，不退化成明文 |
| baseUrl | varchar | API 基地址 |
| model | varchar | 模型名称 |
| createdAt | datetime | 创建时间 |
| updatedAt | datetime | 最后更新时间 |

### User

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| username | varchar(32), unique index | 统一小写存储，注册/登录前先 `trim().toLowerCase()`，避免大小写变体各占一个账号 |
| passwordHash | varchar(256) | `scrypt$N$r$p$salt$hash`，参数随散列一起存，日后调参不影响老口令校验 |
| createdAt / updatedAt | datetime | 自动 |

口令用 Node 内置 `crypto.scrypt` 加盐散列（N=16384、r=8、p=1、16 字节随机盐、32 字节输出，约 16MB 内存，落在 Node 默认 maxmem 内）。校验前对输入做 NFKC 归一，避免同形字符导致“看着一样却登不进去”。明文口令既不落库也不写日志。

### Session

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| token | varchar(64), unique index | `randomBytes(32).toString('hex')`，前端存 localStorage 并以 `Authorization: Bearer` 发送 |
| userId | varchar(36), index | 所属账号。用 varchar 而不是 uuid FK，兼容 sqljs 与 PostgreSQL 两边建表 |
| expiresAt | datetime | 固定 30 天，不做滑动续期：续期要写库，等于每次请求都碰一次会话表 |
| createdAt | datetime | 自动 |

过期会话在 `resolve()` 命中时顺手删除，不额外跑定时任务。

### Conversation

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| userId | varchar(36), nullable | 归属账号；所有读写都先过 `owned(userId, id)`，越权访问统一按 404 处理 |
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
| model | varchar(128), nullable | 本轮**实际作答**的模型 id，仅 assistant 消息有值。开了模型路由后配置里的名字不再等于答案来源，界面与续传都读这一列；改动之前的历史数据为 `null`，续传时回退路由器 |
| timestamp | bigint | 毫秒时间戳（前端排序用） |
| conversation | FK → Conversation | 所属对话（CASCADE 删除） |

> 生产 Postgres 关着 `synchronize`，`migrationsRun` 又没有可跑的迁移目录，所以**改实体必须手动补列**，否则新字段会在第一次写库时炸：
> `ALTER TABLE messages ADD COLUMN IF NOT EXISTS model varchar(128)`（可空；旧行留 `NULL`，续传遇到 `NULL` 回退路由器，不报错）。

### Task（后台任务）

实体在 `functions/api/src/tasks/task.entity.ts`，表名 `tasks`。它是**请求侧与执行侧共用的唯一交接面**：接口只写状态，执行器只按状态领取。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| userId | varchar(36), indexed | 归属账号；所有读写过 `owned(userId, id)`，越权统一 404 |
| conversationId | varchar(36), nullable | 可选关联会话，仅用于把任务归到某段对话下，不建立外键（删会话不该顺带删掉正在跑的任务） |
| kind | varchar(64) | 任务类型，取值来自 `task-registry.ts`；当前只有 `tool_call` |
| status | varchar(16) | `queued` / `running` / `succeeded` / `failed` / `canceled` |
| payload | text | 该 kind 的参数 JSON 文本，入队前按 kind 的 `resolve()` 校验过 |
| result | text, nullable | 执行结果文本，落库前按 `TASK_RESULT_MAX_CHARS` 截断并留标记 |
| error | text, nullable | 失败原因或「用户已取消」 |
| progress | int | 0–100，为将来的分步任务预留；当前工具型任务只在完成时置 100 |
| attempts | int | 已尝试次数，领取时 +1，超过 `TASK_MAX_ATTEMPTS` 判失败 |
| dedupeKey | varchar(64), nullable | 幂等键，与 `userId` 组成**唯一索引**；同键重复提交返回既有任务 |
| runnerId | varchar(64), nullable | 当前持有者（执行器实例标识），仅用于排查 |
| leaseUntil | bigint, nullable | 租约到期毫秒时间戳；`running` 且它已过期 = 持有者大概死了，可被别的实例回收 |
| notBefore | bigint, nullable | 退避门：早于此刻不可领取，避免失败后忙等重投 |
| startedAt / finishedAt | bigint, nullable | 毫秒时间戳 |
| createdAt / updatedAt | datetime | 列表排序依据 |

> 时间字段一律用 bigint 毫秒而不是 datetime：`sqljs` 与 `postgres` 对日期列的序列化行为不同，跨驱动比较容易写错；毫秒整数两边同形，也和 `Message.timestamp` 保持一套坐标系。

## API 接口设计

### 认证

| Method | Path | 请求体 | 响应 |
|--------|------|--------|------|
| POST | `/api/auth/register` | `{ username, password }` | `{ token, user: { id, username } }`，注册成功即登录 |
| POST | `/api/auth/login` | `{ username, password }` | 同上；用户名或密码错误统一返回 401「用户名或密码不正确」 |
| POST | `/api/auth/logout` | — | `{ success: true }`，删除当前 token 对应的会话 |
| GET | `/api/auth/me` | — | `{ id, username }`；无 token 时 401，免登录时直接返回演示身份 |
| GET | `/api/auth/mode` | — | `{ authEnabled, user }`：真实登录时 `{ true, null }`，免登录时 `{ false, 演示身份 }`。前端首屏靠它决定渲染登录页还是主界面 |

`register` / `login` / `mode` / `health` 用 `@Public()` 放行，其余接口由全局 `AuthGuard` 解析 `Authorization: Bearer <token>`，
把用户挂到 `request.user` 供控制器 `@CurrentUser()` 取用；token 缺失返回 401「请先登录」，
不存在或已过期返回 401「登录已过期，请重新登录」。

免登录（`AUTH_ENABLED` 不为 `true`）走的是守卫里的一个提前 return：解析出演示身份挂到 `request.user`、
`request.authToken` 置空后直接放行。控制器与服务层拿到的仍是正常用户对象，不感知模式，
因此鉴权与免登录共用同一套数据隔离代码，不存在「免登录专用分支」。
演示身份 = 库里最早创建的账号（空库时自动建 `demo` 并认领无主的配置与会话），进程内缓存一次，避免每请求多一趟查询。

守卫顺序：`ThrottlerGuard` → `AuthGuard`（先限流再查库，避免撞限流的请求白跑一次会话查询）。

### 健康检查

| Method | Path | 响应 |
|--------|------|------|
| GET | `/api/health` | `{ status, database: up/down, encryption: enabled/disabled, promptVersion, auth: enabled/disabled, background: enabled/disabled, tasks: { queued, running }, uptime, timestamp }`；数据库探测失败返回 503 |

全局：所有接口受 `ThrottlerGuard` 按 IP 限流（`THROTTLE_TTL` / `THROTTLE_LIMIT`），仅 `NODE_ENV=production` 生效——本地开发 StrictMode 双发请求会很快撞上限流。

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

### 后台任务

控制器 `functions/api/src/tasks/tasks.controller.ts`。`meta/kinds` 必须**先于 `:id` 声明**，否则 `meta/kinds` 会被当成任务 id 落到详情接口。

| Method | Path | 请求 | 响应 |
|--------|------|------|------|
| GET | `/api/tasks/meta/kinds` | — | `{ kinds: [{ kind, description, fields: [{ name, type, required, description, enum? }] }], runnerEnabled }`；前端表单与说明直接照此渲染，新增 kind 不用改前端 |
| GET | `/api/tasks` | query `status?`、`conversationId?` | `{ items, counts: { queued, running }, runnerEnabled }`，按 `createdAt DESC`，最多 100 条（`LIST_LIMIT`） |
| POST | `/api/tasks` | `{ kind, payload, conversationId?, dedupeKey? }` | 任务实体；`kind` 未知、`payload` 解析不过、超过 `TASK_PAYLOAD_MAX_BYTES` 均返回 400 且消息带可用清单 |
| GET | `/api/tasks/:id` | — | 任务实体；不存在或不属于当前账号统一 404 |
| POST | `/api/tasks/:id/cancel` | — | 置 `canceled`、清 `leaseUntil`、`error` 缺省填「用户已取消」；已是终态返回 400 |

- `dedupeKey` 幂等：命中 `(userId, dedupeKey)` 已有任务时直接返回既有那条；并发撞唯一索引也走“读回已存在”，不会造出两条
- `payload` 的内部形状**不过全局 `ValidationPipe` 的 whitelist**（它只裁剪 DTO 自身属性），因此未知顶层属性会被 400 拒掉，而 `payload` 内的键交给 kind 的 `resolve()` 判定
- `counts` 与 `runnerEnabled` 一起返回：界面据此区分「排队中」和「没人执行所以一直排队」。注意 `/api/tasks` 的 `counts` 是**当前账号**的水位，`/api/health` 里的是**全局**水位——前者给用户看，后者给运维看堆积

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
| 模型 | `{"model":{"id":"deepseek-flash","reason":"…","score":0.56}}` | 每轮开头发一次，说明**这条回答实际由哪个模型作答、为什么选它**；路由关闭时 `id` 就是配置里的主力模型、`score` 恒为 0 |
| 错误 | `{"error":"具体错误信息","retryable":true}` | 上游 4xx/5xx、轮数耗尽、网络异常；`retryable` 决定前端能不能拿已生成内容续传 |
| 结束 | `data: [DONE]` | 流终止信号 |

业务异常仍走 HTTP 状态码（在 SSE 头写出之前抛出）：未配置 Key → `400 尚未配置大模型 API…`。

`POST /api/chat/resume`

请求体：
```json
{ "conversationId": "uuid", "content": "本轮原始提问", "partial": "浏览器已渲染的前半段回答" }
```

响应与 `POST /api/chat` 完全同构，但**只推后半段增量**——前半段浏览器已经有了，重发一遍等于让用户看见两遍。

`partial` 的校验与续传上限同源（`continuation.ts` 的 `MAX_RESUME_PARTIAL_CHARS = 30000`）：空或纯空白 → `400`（没有已生成内容就该走「重新生成」）；超上限 → `400`，再长下去请求体本身就要吃掉一块函数内存，而且这种回答多半已经跑题。

### 断线续传

定义在 `functions/api/src/chat/continuation.ts`（纯函数，可直接进离线评测），服务端编排在 `chat.service.ts` 的 `resumeChat()`，首发与续传共用同一个 `runTurn()`。

| 环节 | 做法 | 为什么这样选 |
|------|------|------|
| 进度由谁携带 | **浏览器**把它已收到的文本原样带回，服务端不在内存里留「进行中」状态 | 云函数按连接调度实例，重连就是一条新连接，落到哪个实例不由我们决定，上个实例内存里的东西说没就没；浏览器手上那段反而是唯一稳定的进度 |
| 上游怎么「继续」 | 把 `partial` 当作 `assistant` 前缀重新发一次，让模型顺着写 | Chat Completions 没有「从第 N 个 token 继续」的语义。代价说清楚：续传是一次全新请求、会重新计入一遍上下文 token，换回来的是不必从头重答、已生成部分不重复产出 |
| 半截回答的去留 | 续传前 `dropPartialTail()` 撤掉中断那轮的半截记录，收尾时写回 `partial + 新增` 一条 | 不撤就会和续传后的完整回答并成两条；撤的条件是「末条 assistant 的内容正好是本次 partial 的前缀」，与本轮无关的既有回答一律不动 |
| 提问缺失时 | 历史里没有这条提问就临时补一份，**不入库** | sqljs 每实例一份 `/tmp` 库，重连很可能落到从没写过这条提问的实例上；补进去的那份若入库，回到原实例就会看到同一句话两遍 |
| 中断那轮的工具轨迹 | `mergeToolSteps()` 按 `id` 去重后接在新步骤前面 | 它们真的执行过、结果真的被用掉了，丢掉等于把已经花掉的成本从界面和下一轮上下文里抹掉 |
| 什么错误才自动重连 | `retryableForStatus()`：408 / 429 / 5xx 可续，其余 4xx 不可续；传输层异常一律可续 | 4xx（除限流/超时）是请求本身的问题——Key 失效、模型名写错——重连只会再烧一次额度并把同一个错误复述三遍 |
| 断线检测挂哪 | 挂 **`res` 的 `close`**，并用 `writableEnded` 区分「正常写完」与「半路被关」 | 挂 `req` 上没用：Node 在请求体读完时就发出 `req` 的 `close`，那时回答还没开始生成，控制器挂监听时事件早已过去，等于永远检测不到断线，服务端会闷头把整段跑完再落库（既继续烧额度，又让续传无从谈起） |
| 续传用哪个模型 | 沿用中断那轮落库的 `messages.model`（仍需在候选白名单内），否则回退路由器 | 上游没有「接着上一个模型继续写」的语义，换模型续写会让前后半段风格断裂甚至自相矛盾，而浏览器手上只有文本、看不出问题出在模型换了。库里为 `null` 的旧数据（这列加之前落库的）也走回退 |
| 前端重试节奏 | 最多 3 次，退避 `1200ms × 次数`，每次先等 `online` 事件（上限 15s） | 断网时立刻重试只会连着失败三轮；线性退避让「短暂抖动」和「真断了」在体验上区分开，耗尽后保留半截回答并提示改用「重新生成」 |

## 核心流程

### 发送消息

1. 前端调用 `streamChat(conversationId, content, handlers)`，回调统一收进 `ChatStreamHandlers`（`onChunk`/`onStep`/`onNotice`/`onModel`/`signal`）；`App.tsx` 在 `pagehide` 与组件卸载时主动 `abort()`，及时停掉后端对上游的请求
2. 后端 ChatService：
   - 从 DB 读取并解密 ApiConfig，缺失直接抛 `400`
   - `ensureExists(conversationId)` 补齐缺失对话（应对多实例/冷启动）
   - 存入 user message
   - `pickModel()` 按本轮提问算一次档位决策，**整轮（含每一轮工具迭代）都用这个模型**，并在流开头下发一条 `model` 事件（详见「场景化模型选择」）
   - `buildContext()`：一次 `loadContext()` 取回全部消息 + 摘要边界 → 扣除摘要自身占用后得到窗口预算 → `planWindow()` 从最新往回保留、旧轮次滑出 → 滑出部分 `buildRollingSummary()` 压缩并 `saveContext()` 推进边界（详见下节）
   - 保留的消息按 `toolCalls` 还原为 `assistant.tool_calls` + `role: tool` 消息，拼成 `[system, summary?, ...history]`，带上 `tools` 与 `stream: true`
   - 多轮循环（上限 `AGENT_MAX_TURNS`）：模型返回 tool_calls 就执行工具、结果回填后重新请求，直到产出纯文本
   - 逐 chunk 透传 SSE（`content` / `tool` / `notice` / `model` / `error`）
   - 流结束后存入 assistant message（含工具轨迹与本轮实际模型）
3. 前端回调更新 UI：正文逐字追加，工具步骤在气泡内单独展示状态
4. 中途断流（浏览器掉线、网关掐流、上游被掐）时，`runTurn()` 先把已生成的部分连同工具轨迹落库，再由前端拿它调 `/api/chat/resume` 续写，详见下节

### 场景化模型选择

定义在 `functions/api/src/chat/model-router.ts`（纯函数，可直接进离线评测），服务端编排只在 `chat.service.ts` 里调一次 `pickModel()`。
目标是**同一个供应商内的几档模型按本轮问题挑一档**：不新增供应商、不改协议、不动前端配置项。

| 环节 | 做法 | 为什么这样选 |
|------|------|------|
| 候选从哪来 | `MODEL_ROUTING_CANDIDATES` 逗号分隔，**按档位从低到高**；留空即整层关闭 | 模型名不写死在代码里：供应商的 id 会换，用户也未必开通了高那一档。配了不存在的名字会在上游拿到 4xx，宁可让配置者自己负责，也不在代码里替它兜底 |
| 谁来判定 | 服务端算复杂度分，而不是让模型自选 | 做成模型自选要多加一个「换模型再答一遍」的工具：多一跳、双份 token、失败难归因，还会白吃掉 `AGENT_MAX_TURNS` 的轮数预算。而这里的信号（长度、是否含代码、是否要推理）本来确定可得 |
| 判定信号 | 长度分档（≤40/≤200/≤800/更长 → 0/0.1/0.22/0.34）+ 四类关键词权重（要求深入 0.34、分析设计类 0.22、含代码 0.26、格式要求 0.12），求和封顶 1 | 「仔细/深入」这类显式要求权重最高，不该被长度压过去；封顶是为了信号叠满也不越过最高档，否则多候选时永远用最贵的 |
| 落档 | `index = min(候选数-1, floor(score × 候选数))` | 线性映射，加第三档不用改逻辑；`min` 保证越界也只会落在最高档而不是掉出白名单 |
| 生效范围 | 每轮请求算一次，本轮所有工具迭代沿用同一个模型 | 一次回答中途换模型，工具前后的口径会不一致；决策成本也就一次正则匹配 |
| 界面可见 | 流开头下发 `model` 事件（id/reason/score），顶栏显示最近一条回答的模型，气泡标注该条模型并把理由放悬停 | 配置里那个主力模型名不再等于答案来源。不说清「刚才是谁答的、为什么」，用户只会觉得同一句话有时快有时慢 |
| 落库 | 写进 `messages.model`，续传时优先沿用 | 见「断线续传」表里那一行：换模型续写会让前后半段自相矛盾 |
| 关掉的方式 | `MODEL_ROUTING_ENABLED=false` 或候选留空 | 留一个能一键回到「恒用主力模型」的口子，对比测试和排障都靠它，不必回滚代码 |

环境变量：`MODEL_ROUTING_CANDIDATES`（默认空＝关闭）、`MODEL_ROUTING_ENABLED`（默认 `true`，仅在候选非空时有意义）。
开关与候选同时暴露在 `GET /api/health` 的 `modelRouting` / `modelCandidates`，线上「这句为什么换了个模型答」不用重新发布就能查。

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

### 后台任务队列（执行器待部署）

长任务与 HTTP 请求的生命周期天然冲突：函数实例硬顶 300 秒、前端 `pagehide` 就会 abort，而“抓取十个页面再汇总”要跑得更久。所以这一能力拆成两半，**本次只交付不依赖常驻进程的那一半**。

已交付（`functions/api/src/tasks/`）：

| 部件 | 职责 |
|------|------|
| `task.entity.ts` | 队列的持久形状（见「Task」），状态/租约/退避/幂等字段一次配齐 |
| `task-policy.ts` | 纯函数策略层：状态机 `canTransition`、可领取判定 `isClaimable`、退避 `backoffMs`、失败编排 `planFailure`、文本上限 `clipText`、环境变量读取 |
| `task-registry.ts` | kind 注册表：有哪些 kind、payload 长什么样、领取后怎么解释 |
| `task.service.ts` | 面向请求的 CRUD + 面向执行器的 `claimNext` / `renewLease` / `isCanceled` / `report` / `succeed` / `fail` |
| `tasks.controller.ts` | REST 入口（见「后台任务」） |
| `agent/tools.ts` 的 `run_in_background` | 让模型自己提交长任务，只回任务编号不回结果 |

尚未交付：**执行器进程本身**。上面这套领取/续约/回报接口目前没有调用方，因此任务提交后会停在 `queued`。

队列语义的几条硬约束：

- **领取用 CAS 而不是 `SELECT … FOR UPDATE SKIP LOCKED`**：`sqljs` 驱动根本没有行锁，跨驱动写两套只会让本地与云端行为不一致。实现是「扫候选（`TASK_CLAIM_SCAN`，默认 20）→ 逐条 `UPDATE … WHERE id=? AND <资格条件>` → `affected` 为 0 就说明被别人抢走，换下一条」。冲突窗口只有一次 UPDATE 的量，对本项目这种量级足够
- **可领取性只有 `isClaimable` 一个事实来源**：SQL 里的 `status`/`notBefore`/`leaseUntil` 条件是它的预筛，判定仍在内存里做一遍。两边各写一套是这类队列最常见的漂移点
- **租约即存活证明**：`running` 且 `leaseUntil` 未过期表示还有实例在跑，不能被抢；过期才允许回收，否则执行器崩溃会让任务永久卡在 `running`。`renewLease` 由执行器周期性续约，续约失败（被别人接管或已取消）应当立即停手
- **退避 + 次数上限**：失败重投按 `5s·2^(n-1)` 递增、封顶 5 分钟，超过 `TASK_MAX_ATTEMPTS`（默认 3）直接判 `failed`。没有这两条，一个稳定失败的下游会变成无限重投的燃料泵
- **终态不可复活**：`succeeded` / `failed` / `canceled` 不再接受任何流转。用户取消后执行器才跑完，结果必须丢弃而不是把已取消的任务改回成功
- **取消是协作式的**：接口只改状态，正在跑的执行器在回报前后用 `isCanceled()` 自查——强杀线程会让租约与副作用状态对不上
- **幂等交给唯一索引**：`(userId, dedupeKey)` 上的唯一约束承担去重，先查后插只是省一次写；并发撞约束时读回既有任务

给执行器留的部署约束（写在这里以免下次重新踩）：它必须是常驻进程，不能塞进 HTTP 函数；用 Nest 时以 `NestFactory.createApplicationContext()` 起第二个入口（不 `listen()`），单副本才可用 `@nestjs/schedule` 做轮询/cron。若日后引入 Redis，`@nestjs/bullmq` 才需要；只靠这张 `tasks` 表轮询即可满足当前规模。

`BACKGROUND_TASKS_ENABLED` 控制的是**是否把这个能力广播给模型**：关掉时 `run_in_background` 不进 `tools` 列表，`/api/chat` 每轮请求都重新读取该开关（`buildToolDefinitions()` 不传参），所以切换它不需要重新构建。默认 `false`。

### 提示词版本化与回归评测

SYSTEM_PROMPT / SUMMARY_PROMPT 从 service 里抽到 `chat/prompt.ts`，并导出 `PROMPT_VERSION`：

- 单独成文件是为了让评测脚本在**不启动服务**的前提下引用同一份提示词
- 版本号随 `/api/health` 暴露，`evals/cases.json` 钉住同一个版本；两边不一致时评测直接失败，强制“改提示词 → 确认预期 → 升版本”这个动作不被遗漏
- 正文含三块：工具使用准则、工具判定示例（few-shot，只示范该不该调、调哪个、参数怎么给）、输出格式规范

`npm run eval`（离线，57 项断言：19 条工具用例 + 结构与队列、续传、路由不变量，无需网络与 Key）覆盖：工具计算与异常、SSRF 护栏（元数据端点/回环/私网/非 http 协议）、`planWindow` 裁剪语义、并发上限与保序、`baseUrl` 归一化、工具注册表自洽（每个 spec 都有 schema 与 handler、开关只影响 `run_in_background` 的可见性、参数校验一次说清缺参/错型/多参/超长）、后台任务队列语义（终态不可复活、过期租约可回收、退避门与次数上限、kind 注册表与工具注册表口径一致、`resolve` 拒绝无人能执行的任务）、鉴权模式判定（`AUTH_ENABLED` 缺省即免登录且只认字面 `true`、与 `BACKGROUND_TASKS_ENABLED` 互不串线、兜底账号名符合 `users.username` 存储约定）、断点续传的上下文拼装不变量（前缀顺序、半截去重、缺问补份、拒绝条件、可重试返回码、工具轨迹合并不重不漏）、模型路由分档不变量（未配置或显式关闭恒等主力、候选解析与低到高顺序、分数线性落档且封顶不越白名单、续传沿用白名单内的中断那轮模型、缺记录或模型已下架时回退路由器）。`npm run eval:online` 用 `EVAL_API_KEY` 做非流式请求，断言 `expectTool` 命中率，可用 `--min-accuracy` 卡下限；在线模式缺 Key 时报错退出而不是静默通过。运行命令见 README「回归评测」。

> 评测集已经发现过两个真实缺陷：calculator 的标识符正则不含数字，`log10(1000)` 被切成 `log`+`10` 报“需要括号参数”；另一个是用例自写错（期望“星期X”，工具实际输出“周日”）—— 后者提醒断言要对着实现写，而不是对着描述文字写。

### 免登录演示模式：一个开关，两条登录路径共存

需求是「原有真实登录不动，加个环境变量能跳过登录，且直接用现有数据」。落地时刻意只动了一处：

- **绕行的落点在守卫，不在业务**：`AuthGuard` 在 `isPublic` 之后、解析 token 之前判断 `authEnabled()`，为假就把演示身份挂上直接放行。控制器、服务层、数据隔离条件一行没改，也就不存在「免登录专用分支」日后与真实登录分支各自漂移的问题。`request.authToken` 置 null 是唯一的行为差异，而它只被 `logout` 用到。
- **演示身份 = 最早创建的账号，而不是新账号**：这样现有 API Key 与历史对话原样可见，不用为演示复制一份数据，也不用把用户的账号改名。空库时才兜底建 `demo`，走「第一个注册账号」同样的 `claimUnowned` 认领逻辑，两条路径的语义因此一致。查询用 `find({ order: { createdAt ASC, id ASC }, take: 1 })` 而非 `findOne({})`——TypeORM 0.3 的空 `where` 会直接抛错，id 作次级排序保证并发下选中的是同一条。
- **随机口令且不外泄**：兜底账号的密码是 32 字节随机值的 base64url，没人知道它，真实登录路径永远进不来，免登录也不依赖它。
- **模式探测放在首屏且 fail-closed**：前端 `fetchAuthMode()` 拿不到结果就按「需要真实登录」处理。把需要鉴权的部署误判成免登录（用户看到主界面却处处 401）比多显示一次登录页严重得多。
- **默认值是免登录，这是有意的方向性选择**：开关缺省为 `false`，发布上去不用配任何东西就能用；代价是漏配只会失效到「不鉴权」那一侧。所以线上处于哪一侧必须能不重新发布就查到——`/api/health` 的 `auth` 字段就是为此存在，README「上线验收」据此解释为什么免登录时 `/api/tasks` 不带 token 也返回 200。
- **判定只认字面 `'true'`**：与 `BACKGROUND_TASKS_ENABLED` 同一套约定，`1`/`TRUE`/`yes` 一律不算开启，避免两种开关对同一个值给出不同答案。

## 安全设计

- API Key 经 AES-256-GCM 加密后落库（密文格式见「ApiConfig」），主密钥 `ENCRYPTION_KEY` 从环境变量注入；`GET /api/config` 只返回 `apiKeyMasked`，明文仅在调用上游时存在于内存
- 主密钥缺失或格式非法时拒绝保存，错误信息里直接给出生成命令；不会退化成明文落库。读到历史明文配置会在密钥可用时自动加密回写
- 口令散列参数见「User」；登录接口无论用户是否存在都执行一次 scrypt（不存在时比对固定 `DUMMY_HASH`），避免用响应耗时枚举用户名
- 业务接口默认要求 Bearer token（`AUTH_ENABLED=true`）；所有会话读写以 `userId` 为过滤条件，越权访问一律 404，不区分“不存在”和“不是你的”
- **免登录是该约定的唯一例外，且例外只写在守卫里**：`AUTH_ENABLED` 不为 `true` 时全站共用最早创建的账号身份，`/api/chat`、`/api/config` 对所有能访问域名的人开放——配额被陌生人消耗、配置被改写都在所难免，只剩按 IP 限流一层。明文 Key 仍不会外泄（`GET /api/config` 只回掩码），`/api/health` 的 `auth` 字段负责把这个状态暴露在探活里而不是埋在部署配置里。对外收紧就设 `AUTH_ENABLED=true` 重新部署，代码不用动
- token 存 localStorage 而不是 Cookie：后端是独立的云函数域名，跨站 Cookie 需要 SameSite=None 且依赖网关配合；代价是 XSS 可读，依赖 React 转义兜底
- 前端不直连大模型，密钥不进入浏览器
- `fetch_url` 工具走 URL 校验（`security/url-guard.ts`）+ 超时与体积上限，防 SSRF 和超大响应；协议限制、域名黑名单、**字面量 IP 与 DNS 全量解析结果都不能落入内网**，且每跳重定向重新校验
- 本地开发由 Vite proxy 仅转发 `/api/*`；云端跨域只靠网关安全域名放行，函数侧 `CORS_ORIGINS` 留空

## 前端模块职责

| 文件 | 职责 |
|------|------|
| `frontend/src/client.ts` | 封装所有后端 HTTP/SSE 调用（含 `truncateConversation`、`resumeChat`）；`streamChat` 与 `resumeChat` 共用同一个 `runChatStream`，只有路径和请求体不同，回调统一收进 `ChatStreamHandlers` 对象——`onChunk`/`onNotice` 签名一模一样，再排位置参数就会悄悄接错而 TS 抓不到同类型的顺序错误；流没等到 `[DONE]` 就结束时抛 `ChatStreamError(…, retryable=true)`，把「网关掐流」和「正常写完」区分开；`model` 事件转成 `onModel`，界面据此说明「刚才是哪个模型答的」；统一管理 token（localStorage）与 `Authorization` 头，任一接口 401 时广播 `ai-chat:unauthorized` 让 App 收回登录态；`fetchAuthMode` 问后端当前是否免登录，拿不到结果就按需要真实登录处理 |
| `frontend/src/apiConfig.ts` | PROVIDER_PRESETS（给 Modal UI 渲染用）、表单校验工具 |
| `frontend/src/types.ts` | Message / Conversation / ApiConfig / ProviderType 类型；Message 上的 `model` 是本轮实际作答的模型（历史消息从库里读回，只有名字），`modelReason` 只在流式那一轮存在 |
| `frontend/src/App.tsx` | 状态管理：登录态、会话列表、当前会话、配置状态；首屏先问 `/api/auth/mode`，免登录时直接以返回的身份进入主界面，否则用 token 换登录态，未登录只渲染 `AuthView`；登录后没配 Key 自动弹设置窗；`rewindTo` 统一承载“重新生成”与“编辑重发”（先改后端再同步本地）；发送链路自带续传循环 `resumeFromBreak`：`generated` 累积本轮已渲染文本，遇到 `retryable` 错误就先等 `online` 再退避重试，把 `generated` 当 `partial` 续写，最多 3 次，耗尽或不可续时保留半截回答并给出明确结尾；`onModel` 把服务端的路由决策写进当前 assistant 气泡（`model` + `modelReason`），续传那轮收到的理由会覆盖首发那轮的，因为「沿用」才是此刻的事实；`pagehide`/卸载时 abort 在途 SSE |
| `frontend/src/components/AuthView.tsx` | 登录/注册页：模式切换、前置长度校验、错误提示、提交中禁用按钮 |
| `frontend/src/components/ChatInterface.tsx` | 纯 UI：侧栏 + 气泡 + 输入框 + Markdown 渲染 + 工具步骤面板；“重新生成”仅给最后一条回答，“编辑重发”仅给历史用户消息；顶栏展示当前账号与「退出登录」（生成中禁用）；那个模型名取**最近一条带模型标记的回答**（没有才退回配置里的主力模型），气泡下方标出该条自己的模型、悬停给理由——一次会话里不同问题的档位可以不同，逐条标注才答得出「这句是谁说的」；`demoMode` 下账号旁加「免登录」标记并收起退出登录按钮——没有 token 可清，留着按钮只会给出一个点了没反应的入口 |
| `frontend/src/components/ApiConfigModal.tsx` | 配置弹窗 UI：供应商选择 + Key/Model/BaseURL 表单 |
| `frontend/src/components/TaskPanel.tsx` | 后台任务面板（顶栏入口 + 抽屉）：自拉数据、不向 App 要 prop；有活跃任务且抽屉打开时 2s 轮询，否则降到 15s；`runnerEnabled=false` 时明确解释「任务只会排队」；提交表单按 `/api/tasks/meta/kinds` 的字段说明渲染；取消按钮只对进行中的任务出现，终态只展示结果 |

## 扩展方向

已落地（不再是待办）：多用户账号与数据隔离、免登录演示模式（`AUTH_ENABLED` 单开关，与真实登录共存）、CloudBase 静态托管 + HTTP 云函数部署、工具并发执行、上下文窗口裁剪 + 滚动摘要、重新生成 / 编辑重发、SSE 断线自动续传、同供应商内的场景化模型选择、提示词版本化 + 回归评测、后台任务的队列表与 REST 接口。

- 数据层根治：把 `DB_TYPE` 切到 `postgres`，消除多实例/冷启动导致的配置与历史丢失（当前所有“演示模式局限”的根因）
- 对话分支：`truncateFrom` 已经是它的地基，缺的是一份“父消息/分支树”数据模型与前端切换 UI
- 历史消息分页/虚拟滚动：现在一次 `GET :id` 拉全量；长对话需后端加分页 + 前端定高虚拟化
- 多路并发 SSE：单路流内能做的是工具并发；“一个请求开多路回答”需先把数据层切到 postgres 并调高 `InstanceConcurrency`
- 后台长任务的**执行器**：队列、租约/退避/重试/幂等与 REST 接口都已就位，缺一个调用 `claimNext()` 的常驻进程（不能塞进 HTTP 函数）。上线后把 `BACKGROUND_TASKS_ENABLED` 置 `true`，模型才会拿到 `run_in_background`；见「后台任务队列」
- 多供应商支持：在 `PROVIDER_PRESETS` 中新增条目，后端 ChatService 按 provider 切换请求逻辑
- 文生图：新增 CogView / DALL-E 接口，后端添加 `/api/images/generations` 代理
