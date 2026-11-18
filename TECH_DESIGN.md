# 技术设计文档

## 系统架构

```
浏览器  React 19 + TS + Tailwind 4
  ├─ ChatInterface / AuthView / ApiConfigModal / TaskPanel / MemoryPanel
  └─ src/client.ts（统一 API 层：token、SSE 解析、记忆清单）
       │ HTTP / SSE（本地同源 /api/*；云端跨域，见「云端部署架构」）
       ▼
Vite Dev Server :5173 ── proxy /api → :3001（仅本地开发）
       ▼
NestJS Backend :3001
  ├─ AuthModule          注册/登录、Bearer 会话守卫、AUTH_ENABLED 免登录模式
  ├─ ConfigModule        API 配置 CRUD（加密落库）
  ├─ ConversationsModule 对话 & 消息（CASCADE）
  ├─ ChatModule          SSE 代理 + Agent 多轮循环 + 上下文裁剪/摘要 + 模型路由 + 记忆注入
  ├─ MemoryModule        跨会话长期记忆（user_memories 表 + remember/forget 工具的后端）
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

| 项                | 说明                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| SSE 与函数超时    | 默认 5 秒会砍断流，必须 `timeout: 300`；响应头 `X-Accel-Buffering: no` 阻止网关缓冲                                                      |
| CORS 只能一层     | Nest `enableCors` 与网关安全域名会各加一份 ACAO；函数侧 `CORS_ORIGINS` 留空，只靠网关                                                    |
| 实例粘性 + `/tmp` | sqljs 下 config / 对话不跨实例共享；chat 先用 `ensureExists()` 补建对话规避 404，根治要切 postgres                                       |
| 限流              | `ThrottlerGuard` 计数在进程内存，实际放行量 ≈ limit × 实例数，需网关限频兜底                                                             |
| 摘要与多实例      | `contextSummary`/`summaryUntil` 跟着库走；sqljs 下冷启动会连同摘要一起丢失（切 postgres 根治），但不会造成“摘要覆盖不存在的消息”这类错乱 |

> 部署期操作约束（VPC 打通、控制台路径透传与安全域名、上线验收、sqljs 局限的根治步骤）统一写在 README「云端部署（腾讯云 CloudBase）」，此处不重复。

## 技术选型

| 层面     | 选择                                 | 理由                                     |
| -------- | ------------------------------------ | ---------------------------------------- |
| 前端框架 | React 19 + Vite 8                    | 快速 HMR、生态成熟                       |
| 样式     | Tailwind CSS 4                       | 原子化、无运行时开销                     |
| Markdown | react-markdown + remark-gfm          | 支持 GFM 表格/任务列表/删除线            |
| 代码高亮 | react-syntax-highlighter (Prism)     | 按需加载、100+ 语言                      |
| 后端框架 | NestJS 11                            | 模块化、DI、装饰器风格                   |
| ORM      | TypeORM 0.3                          | NestJS 官方推荐、装饰器实体              |
| 数据库   | sql.js (SQLite in WASM) / PostgreSQL | 本地零配置演示；多实例云端必须共享库     |
| 大模型   | DeepSeek                             | 官方 CORS 友好、兼容 OpenAI 协议、价格低 |

## 数据模型

### ApiConfig（按账号每家一行，其中一份标记为「当前使用」）

| 字段              | 类型                           | 说明                                                                                                                                                            |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                | uuid PK                        | 自动                                                                                                                                                            |
| userId            | varchar(36), nullable          | 归属账号。鉴权上线前的旧行是 NULL，由第一个注册账号认领                                                                                                         |
| provider          | varchar                        | 供应商标识，取值只能是 `providers.ts` 注册表里的 id（当前 `deepseek` / `zhipu`）                                                                                |
| active            | boolean NOT NULL DEFAULT false | 生效指针。同一账号内同时最多一份为 `true`，由服务层在一个事务里挪动，**库里不加唯一约束**（部分唯一索引在 sqlite/postgres 方言写法不一致，且 sqljs 那侧未必认） |
| apiKey            | varchar(512)                   | AES-256-GCM 密文，格式 `gcm1:<iv-hex>:<tag-hex>:<cipher-b64>`；主密钥缺失时拒绝保存，不退化成明文                                                               |
| baseUrl           | varchar                        | API 基地址，一律 https；是否允许带路径由该家的 `baseUrlRule` 决定（智谱的兼容端点必须带 `/api/paas/v4`）                                                        |
| model             | varchar                        | 主力模型名称                                                                                                                                                    |
| routingCandidates | varchar(512), nullable         | 这一家的场景化档位候选（从低到高逗号分隔）。属于「这家有几档」而非「全局开关」，所以放在行上；留空才回落到 `MODEL_ROUTING_CANDIDATES`                           |
| createdAt         | datetime                       | 创建时间                                                                                                                                                        |
| updatedAt         | datetime                       | 最后更新时间                                                                                                                                                    |

**为什么从「每人 upsert 最近一条」改成一人多行**：接第二家时如果继续复用同一行，保存智谱就把 DeepSeek 的 Key 覆盖了，用户来回切供应商要来回重贴密钥，
而免登录演示站上这等价于任何访客都能顶掉别人的凭据。`(userId, provider)` 复合唯一让「一人一家最多一份」，多份之间靠 `active` 指一个。
历史遗留的 NULL `userId` 与无 `active` 的存量行不需要回填：读路径本来就退回 `updatedAt` 最近的一条，第一次保存或切换时自然写入新列。

### User

| 字段                  | 类型                      | 说明                                                                           |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| id                    | uuid PK                   | 自动                                                                           |
| username              | varchar(32), unique index | 统一小写存储，注册/登录前先 `trim().toLowerCase()`，避免大小写变体各占一个账号 |
| passwordHash          | varchar(256)              | `scrypt$N$r$p$salt$hash`，参数随散列一起存，日后调参不影响老口令校验           |
| createdAt / updatedAt | datetime                  | 自动                                                                           |

口令用 Node 内置 `crypto.scrypt` 加盐散列（N=16384、r=8、p=1、16 字节随机盐、32 字节输出，约 16MB 内存，落在 Node 默认 maxmem 内）。校验前对输入做 NFKC 归一，避免同形字符导致“看着一样却登不进去”。明文口令既不落库也不写日志。

### Session

| 字段      | 类型                      | 说明                                                                                     |
| --------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| id        | uuid PK                   | 自动                                                                                     |
| token     | varchar(64), unique index | `randomBytes(32).toString('hex')`，前端存 localStorage 并以 `Authorization: Bearer` 发送 |
| userId    | varchar(36), index        | 所属账号。用 varchar 而不是 uuid FK，兼容 sqljs 与 PostgreSQL 两边建表                   |
| expiresAt | datetime                  | 固定 30 天，不做滑动续期：续期要写库，等于每次请求都碰一次会话表                         |
| createdAt | datetime                  | 自动                                                                                     |

过期会话在 `resolve()` 命中时顺手删除，不额外跑定时任务。

### Conversation

| 字段           | 类型                  | 说明                                                                                                    |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| id             | uuid PK               | 自动                                                                                                    |
| userId         | varchar(36), nullable | 归属账号；所有读写都先过 `owned(userId, id)`，越权访问统一按 404 处理                                   |
| title          | varchar               | 对话标题（自动取首条用户消息前 24 字）                                                                  |
| contextSummary | text, nullable        | 滑出上下文窗口的旧轮次归并成的**滚动摘要**；存库里而不是每轮重算，否则对话越长压缩成本反超节省量        |
| summaryUntil   | bigint, nullable      | 摘要已覆盖到的消息时间戳（含）。时间戳 ≤ 该值的消息视为“已在摘要里”，避免同一段对话既在摘要里又原文重发 |
| createdAt      | datetime              | 创建时间                                                                                                |
| updatedAt      | datetime              | 最后更新时间                                                                                            |

> `contextSummary` / `summaryUntil` 只在服务端组装上下文时使用，不随 `GET /api/conversations/:id` 返回给前端；`truncateFrom` 在删除消息时若发现摘要已覆盖被删范围（`summaryUntil >= fromTimestamp`）会一并作废，避免摘要里残留根本不存在的对话。

### Message

| 字段         | 类型                   | 说明                                                                                                                                                              |
| ------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id           | uuid PK                | 自动                                                                                                                                                              |
| role         | varchar                | 'user' 或 'assistant'                                                                                                                                             |
| content      | text                   | 消息正文                                                                                                                                                          |
| toolCalls    | text, nullable         | Agent 工具轨迹 JSON（id/name/arguments/result/ok），仅 assistant 消息有值；既供前端展示步骤，也供多轮还原 tool_calls 上下文                                       |
| model        | varchar(128), nullable | 本轮**实际作答**的模型 id，仅 assistant 消息有值。开了模型路由后配置里的名字不再等于答案来源，界面与续传都读这一列；改动之前的历史数据为 `null`，续传时回退路由器 |
| timestamp    | bigint                 | 毫秒时间戳（前端排序用）                                                                                                                                          |
| conversation | FK → Conversation      | 所属对话（CASCADE 删除）                                                                                                                                          |

> 生产 Postgres 关着 `synchronize`，`migrationsRun` 又没有可跑的迁移目录，所以**改实体必须手动补列**，否则新字段会在第一次写库时炸：
> `ALTER TABLE messages ADD COLUMN IF NOT EXISTS model varchar(128)`（可空；旧行留 `NULL`，续传遇到 `NULL` 回退路由器，不报错）。

### UserMemory（跨会话长期记忆）

实体在 `functions/api/src/memory/memory.entity.ts`，表名 `user_memories`。它记的是「关于这位用户的稳定事实」，与 `Conversation.contextSummary` 是两套东西：摘要只活在一场对话里、会被窗口裁掉，记忆每次请求都重新注入。

| 字段                  | 类型                  | 说明                                                                                                       |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| id                    | uuid PK               | 自动；给模型看的编号取它去连字符后的前 8 位（`memoryHandle()`），完整 uuid 太长且模型抄错一位就找不到      |
| userId                | varchar(36)           | 归属账号，所有读写以它过滤，越权统一 404                                                                   |
| content               | text                  | 记忆正文；单条长度在**服务层**按 `MEMORY_ITEM_MAX_CHARS` 拦，不交给数据库                                  |
| fingerprint           | varchar(64)           | 归一化（折叠空白 + 转小写）后的 sha256。存哈希而非归一化正文：长度可控，且「同一句话大小写不同」不该记两遍 |
| source                | varchar(16)           | `model`=模型在对话里自主记录，`user`=用户在面板里亲手写；联合类型列必须显式写 `type`                       |
| conversationId        | varchar(36), nullable | 只记录「在哪次对话里记下的」，供界面说明来处；检索与注入一律按账号，不建外键（删会话不该顺带删掉记忆）     |
| createdAt / updatedAt | datetime              | 排序、注入取舍与条数淘汰都只看 `updatedAt`                                                                 |

索引两条：`(userId, updatedAt)` 供列表与注入排序，`(userId, fingerprint)` **唯一**——去重压在数据库层，应用层再写一套判断就会有两份口径。

> 生产 Postgres 关着 `synchronize` 且没有迁移目录，这张表要手动建，DDL 见 README「生产库结构变更」。
> 缺表时读路径按「没有记忆」处理、只打一条 warn（[memory.service.ts:46](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.service.ts#L46)）——长期记忆是锦上添花，不该把一次对话钉在缺表的运维步骤上；写路径才会把失败回给用户。
> `/api/health` 的 `memoryTable` 三态 `disabled` / `up` / `missing` 就是「开关与 DDL 各跑到哪一步」的现成答案（只 `SELECT 1 FROM user_memories LIMIT 1`，不 COUNT）。

### Task（后台任务）

实体在 `functions/api/src/tasks/task.entity.ts`，表名 `tasks`。它是**请求侧与执行侧共用的唯一交接面**：接口只写状态，执行器只按状态领取。

| 字段                   | 类型                  | 说明                                                                                   |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| id                     | uuid PK               | 自动                                                                                   |
| userId                 | varchar(36), indexed  | 归属账号；所有读写过 `owned(userId, id)`，越权统一 404                                 |
| conversationId         | varchar(36), nullable | 可选关联会话，仅用于把任务归到某段对话下，不建立外键（删会话不该顺带删掉正在跑的任务） |
| kind                   | varchar(64)           | 任务类型，取值来自 `task-registry.ts`；当前只有 `tool_call`                            |
| status                 | varchar(16)           | `queued` / `running` / `succeeded` / `failed` / `canceled`                             |
| payload                | text                  | 该 kind 的参数 JSON 文本，入队前按 kind 的 `resolve()` 校验过                          |
| result                 | text, nullable        | 执行结果文本，落库前按 `TASK_RESULT_MAX_CHARS` 截断并留标记                            |
| error                  | text, nullable        | 失败原因或「用户已取消」                                                               |
| progress               | int                   | 0–100，为将来的分步任务预留；当前工具型任务只在完成时置 100                            |
| attempts               | int                   | 已尝试次数，领取时 +1，超过 `TASK_MAX_ATTEMPTS` 判失败                                 |
| dedupeKey              | varchar(64), nullable | 幂等键，与 `userId` 组成**唯一索引**；同键重复提交返回既有任务                         |
| runnerId               | varchar(64), nullable | 当前持有者（执行器实例标识），仅用于排查                                               |
| leaseUntil             | bigint, nullable      | 租约到期毫秒时间戳；`running` 且它已过期 = 持有者大概死了，可被别的实例回收            |
| notBefore              | bigint, nullable      | 退避门：早于此刻不可领取，避免失败后忙等重投                                           |
| startedAt / finishedAt | bigint, nullable      | 毫秒时间戳                                                                             |
| createdAt / updatedAt  | datetime              | 列表排序依据                                                                           |

> 时间字段一律用 bigint 毫秒而不是 datetime：`sqljs` 与 `postgres` 对日期列的序列化行为不同，跨驱动比较容易写错；毫秒整数两边同形，也和 `Message.timestamp` 保持一套坐标系。

## API 接口设计

### 认证

| Method | Path                 | 请求体                   | 响应                                                                                                                       |
| ------ | -------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/auth/register` | `{ username, password }` | `{ token, user: { id, username } }`，注册成功即登录                                                                        |
| POST   | `/api/auth/login`    | `{ username, password }` | 同上；用户名或密码错误统一返回 401「用户名或密码不正确」                                                                   |
| POST   | `/api/auth/logout`   | —                        | `{ success: true }`，删除当前 token 对应的会话                                                                             |
| GET    | `/api/auth/me`       | —                        | `{ id, username }`；无 token 时 401，免登录时直接返回演示身份                                                              |
| GET    | `/api/auth/mode`     | —                        | `{ authEnabled, user }`：真实登录时 `{ true, null }`，免登录时 `{ false, 演示身份 }`。前端首屏靠它决定渲染登录页还是主界面 |

`register` / `login` / `mode` / `health` 用 `@Public()` 放行，其余接口由全局 `AuthGuard` 解析 `Authorization: Bearer <token>`，
把用户挂到 `request.user` 供控制器 `@CurrentUser()` 取用；token 缺失返回 401「请先登录」，
不存在或已过期返回 401「登录已过期，请重新登录」。

免登录（`AUTH_ENABLED` 不为 `true`）走的是守卫里的一个提前 return：解析出演示身份挂到 `request.user`、
`request.authToken` 置空后直接放行。控制器与服务层拿到的仍是正常用户对象，不感知模式，
因此鉴权与免登录共用同一套数据隔离代码，不存在「免登录专用分支」。
演示身份 = 库里最早创建的账号（空库时自动建 `demo` 并认领无主的配置与会话），进程内缓存一次，避免每请求多一趟查询。

守卫顺序：`ThrottlerGuard` → `AuthGuard`（先限流再查库，避免撞限流的请求白跑一次会话查询）。

### 健康检查

| Method | Path          | 响应                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health` | `{ status, database: up/down, encryption: enabled/disabled, promptVersion, auth: enabled/disabled, background: enabled/disabled, modelRouting: enabled/disabled, modelCandidates: []（仅环境变量兜底那一份）, providers: []（注册表里的供应商 id）, memory: enabled/disabled, memoryTable: disabled/up/missing, memoryLimits: { maxEntries, itemMaxChars, injectMaxChars }, tasks: { queued, running }, uptime, timestamp }`；数据库探测失败返回 503 |

全局：所有接口受 `ThrottlerGuard` 按 IP 限流（`THROTTLE_TTL` / `THROTTLE_LIMIT`），仅 `NODE_ENV=production` 生效——本地开发 StrictMode 双发请求会很快撞上限流。

### 配置管理

一个账号可以保存多份配置（每家一份），下面这组接口描述的就是「列表 + 生效指针」，前端不自己推断哪份该显示成「当前使用」。

| Method | Path                             | 请求体                                                             | 响应                                                                                                                                                                                                                                                              |
| ------ | -------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/config`                    | —                                                                  | `{ configured, active, items }`：`items[]` 为每份配置的视图（`provider` / `label` / `baseUrl` / `model` / `apiKeyMasked` / `active` / `routingCandidates` / `updatedAt`），`active` 是其中 `active=true` 的那一份或 `null`；`configured` 等价于 `active !== null` |
| POST   | `/api/config`                    | `{ provider, apiKey, baseUrl, model, routingCandidates?, apply? }` | `{ success, config }`。`apiKey` 留空或仍是掩码＝沿用库里那把（首次保存该家除外）；`apply` 缺省 `true` 才把生效位挪过来                                                                                                                                            |
| POST   | `/api/config/:provider/activate` | —                                                                  | `{ success, config }`；该家没配过则报错                                                                                                                                                                                                                           |
| DELETE | `/api/config/:provider`          | —                                                                  | `{ success: true }`；删掉的正是生效那份时，剩下 `updatedAt` 最近的一份自动顶上                                                                                                                                                                                    |
| DELETE | `/api/config`                    | —                                                                  | `{ success: true }`，清空该账号的全部配置                                                                                                                                                                                                                         |

所有响应只回掩码，明文 Key 不出后端；`provider` 不在注册表内、Key 不符合该家形态、baseUrl 非 https 或候选跨家，都在 DTO 层拒掉并回中文说明。

### 对话管理

| Method | Path                              | 说明                                                                                                                                                                                                               |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/conversations`              | 列表（createdAt DESC，不含 messages）                                                                                                                                                                              |
| POST   | `/api/conversations`              | 新建，返回含 id 的完整对象                                                                                                                                                                                         |
| GET    | `/api/conversations/:id`          | 含完整 messages（timestamp ASC）                                                                                                                                                                                   |
| PATCH  | `/api/conversations/:id`          | 更新 title                                                                                                                                                                                                         |
| DELETE | `/api/conversations/:id`          | 级联删除所有 messages                                                                                                                                                                                              |
| POST   | `/api/conversations/:id/truncate` | 请求体 `{ fromTimestamp }`，删除 `timestamp >= fromTimestamp` 的消息，返回 `{ removed, summaryReset }`。“重新生成”与“编辑重发”共用此入口；按时间戳而非消息 id 删除，与前端列表以 timestamp 为 key 保持同一套坐标系 |

### 后台任务

控制器 `functions/api/src/tasks/tasks.controller.ts`。`meta/kinds` 必须**先于 `:id` 声明**，否则 `meta/kinds` 会被当成任务 id 落到详情接口。

| Method | Path                    | 请求                                             | 响应                                                                                                                                                          |
| ------ | ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/tasks/meta/kinds` | —                                                | `{ kinds: [{ kind, description, fields: [{ name, type, required, description, enum? }] }], runnerEnabled }`；前端表单与说明直接照此渲染，新增 kind 不用改前端 |
| GET    | `/api/tasks`            | query `status?`、`conversationId?`               | `{ items, counts: { queued, running }, runnerEnabled }`，按 `createdAt DESC`，最多 100 条（`LIST_LIMIT`）                                                     |
| POST   | `/api/tasks`            | `{ kind, payload, conversationId?, dedupeKey? }` | 任务实体；`kind` 未知、`payload` 解析不过、超过 `TASK_PAYLOAD_MAX_BYTES` 均返回 400 且消息带可用清单                                                          |
| GET    | `/api/tasks/:id`        | —                                                | 任务实体；不存在或不属于当前账号统一 404                                                                                                                      |
| POST   | `/api/tasks/:id/cancel` | —                                                | 置 `canceled`、清 `leaseUntil`、`error` 缺省填「用户已取消」；已是终态返回 400                                                                                |

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

| 事件     | 载荷                                                                     | 说明                                                                                                                                    |
| -------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 正文     | `{"content":"你"}`                                                       | 逐字增量，前端拼到当前气泡                                                                                                              |
| 工具开始 | `{"tool":{"id","name","args","status":"calling"}}`                       | 模型决定调用工具；**同一轮的多个调用会先全部发出再并发执行**，展示顺序与执行完成顺序无关                                                |
| 工具增量 | `{"tool":{"id","name","status":"streaming","delta":"…","progress":{…}}}` | 只在执行期出现，`delta` 与 `progress` **可以同时有、也可以只有其一**（纯阶段事件序列化后连 `delta` 键都不存在）；见「工具结果流式推送」 |
| 工具结束 | `{"tool":{"id","name","args","result","ok","status":"done\|error"}}`     | 结果按 `tool_calls` 原顺序回填；终态带**完整** `result`，前端据此覆盖已累加的 `delta`                                                   |
| 提示     | `{"notice":"…被截断…"}`                                                  | 非致命提示（如输出撞长度上限）                                                                                                          |
| 模型     | `{"model":{"id":"deepseek-flash","reason":"…","score":0.56}}`            | 每轮开头发一次，说明**这条回答实际由哪个模型作答、为什么选它**；路由关闭时 `id` 就是配置里的主力模型、`score` 恒为 0                    |
| 错误     | `{"error":"具体错误信息","retryable":true}`                              | 上游 4xx/5xx、轮数耗尽、网络异常；`retryable` 决定前端能不能拿已生成内容续传                                                            |
| 结束     | `data: [DONE]`                                                           | 流终止信号                                                                                                                              |

事件体不在循环里现拼，统一由 `chat/sse-events.ts` 的三个组装函数产出（[sse-events.ts:31](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/sse-events.ts#L31)）：这是前后端的接口契约，散着写没人能保证每个事件都带 `id`——漏一次，并发执行的几个工具就把进度画到同一张卡上；抽成纯函数后评测也能在不启动服务的前提下断言这条契约。

业务异常仍走 HTTP 状态码（在 SSE 头写出之前抛出）：未配置 Key → `400 尚未配置大模型 API…`。

`POST /api/chat/resume`

请求体：

```json
{
  "conversationId": "uuid",
  "content": "本轮原始提问",
  "partial": "浏览器已渲染的前半段回答"
}
```

响应与 `POST /api/chat` 完全同构，但**只推后半段增量**——前半段浏览器已经有了，重发一遍等于让用户看见两遍。

`partial` 的校验与续传上限同源（`continuation.ts` 的 `MAX_RESUME_PARTIAL_CHARS = 30000`）：空或纯空白 → `400`（没有已生成内容就该走「重新生成」）；超上限 → `400`，再长下去请求体本身就要吃掉一块函数内存，而且这种回答多半已经跑题。

### 断线续传

定义在 `functions/api/src/chat/continuation.ts`（纯函数，可直接进离线评测），服务端编排在 `chat.service.ts` 的 `resumeChat()`，首发与续传共用同一个 `runTurn()`。

| 环节               | 做法                                                                                | 为什么这样选                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进度由谁携带       | **浏览器**把它已收到的文本原样带回，服务端不在内存里留「进行中」状态                | 云函数按连接调度实例，重连就是一条新连接，落到哪个实例不由我们决定，上个实例内存里的东西说没就没；浏览器手上那段反而是唯一稳定的进度                                                                |
| 上游怎么「继续」   | 把 `partial` 当作 `assistant` 前缀重新发一次，让模型顺着写                          | Chat Completions 没有「从第 N 个 token 继续」的语义。代价说清楚：续传是一次全新请求、会重新计入一遍上下文 token，换回来的是不必从头重答、已生成部分不重复产出                                       |
| 半截回答的去留     | 续传前 `dropPartialTail()` 撤掉中断那轮的半截记录，收尾时写回 `partial + 新增` 一条 | 不撤就会和续传后的完整回答并成两条；撤的条件是「末条 assistant 的内容正好是本次 partial 的前缀」，与本轮无关的既有回答一律不动                                                                      |
| 提问缺失时         | 历史里没有这条提问就临时补一份，**不入库**                                          | sqljs 每实例一份 `/tmp` 库，重连很可能落到从没写过这条提问的实例上；补进去的那份若入库，回到原实例就会看到同一句话两遍                                                                              |
| 中断那轮的工具轨迹 | `mergeToolSteps()` 按 `id` 去重后接在新步骤前面                                     | 它们真的执行过、结果真的被用掉了，丢掉等于把已经花掉的成本从界面和下一轮上下文里抹掉                                                                                                                |
| 什么错误才自动重连 | `retryableForStatus()`：408 / 429 / 5xx 可续，其余 4xx 不可续；传输层异常一律可续   | 4xx（除限流/超时）是请求本身的问题——Key 失效、模型名写错——重连只会再烧一次额度并把同一个错误复述三遍                                                                                                |
| 断线检测挂哪       | 挂 **`res` 的 `close`**，并用 `writableEnded` 区分「正常写完」与「半路被关」        | 挂 `req` 上没用：Node 在请求体读完时就发出 `req` 的 `close`，那时回答还没开始生成，控制器挂监听时事件早已过去，等于永远检测不到断线，服务端会闷头把整段跑完再落库（既继续烧额度，又让续传无从谈起） |
| 续传用哪个模型     | 沿用中断那轮落库的 `messages.model`（仍需在候选白名单内），否则回退路由器           | 上游没有「接着上一个模型继续写」的语义，换模型续写会让前后半段风格断裂甚至自相矛盾，而浏览器手上只有文本、看不出问题出在模型换了。库里为 `null` 的旧数据（这列加之前落库的）也走回退                |
| 前端重试节奏       | 最多 3 次，退避 `1200ms × 次数`，每次先等 `online` 事件（上限 15s）                 | 断网时立刻重试只会连着失败三轮；线性退避让「短暂抖动」和「真断了」在体验上区分开，耗尽后保留半截回答并提示改用「重新生成」                                                                          |

## 核心流程

### 发送消息

1. 前端调用 `streamChat(conversationId, content, handlers)`，回调统一收进 `ChatStreamHandlers`（`onChunk`/`onStep`/`onNotice`/`onModel`/`signal`）；`App.tsx` 在 `pagehide` 与组件卸载时主动 `abort()`，及时停掉后端对上游的请求
2. 后端 ChatService：
   - 从 DB 读取**生效那一份** ApiConfig（`active=true`；存量数据一条都没标就退回 `updatedAt` 最近的那份）并解密 Key，缺失直接抛 `400`。这一份同时决定用哪家的 baseUrl、主力模型与档位候选
   - `ensureExists(conversationId)` 补齐缺失对话（应对多实例/冷启动）
   - 存入 user message
   - `pickModel()` 按本轮提问算一次档位决策，**整轮（含每一轮工具迭代）都用这个模型**，并在流开头下发一条 `model` 事件（详见「场景化模型选择」）
   - `buildContext()`：一次 `loadContext()` 取回全部消息 + 摘要边界 → 扣除摘要自身占用后得到窗口预算 → `planWindow()` 从最新往回保留、旧轮次滑出 → 滑出部分 `buildRollingSummary()` 压缩并 `saveContext()` 推进边界（详见下节）
   - `renderForPrompt(userId)` 取该账号的长期记忆文本，与 system 提示、摘要一起交给 `buildRequestMessages()` 拼成 `[system, memory?, summary?, ...history]`——**记忆不来自历史，也不进历史**（详见「跨会话长期记忆」）
   - 保留的消息按 `toolCalls` 还原为 `assistant.tool_calls` + `role: tool` 消息，`tools` 用 `buildToolDefinitions()` **每次请求现算**（带开关的工具随开随关），带上 `stream: true`
   - 多轮循环（上限 `AGENT_MAX_TURNS`）：模型返回 tool_calls 就并发执行工具（每个工具绑定一个 `report` 闭包用于推进度）、结果按原顺序回填后重新请求，直到产出纯文本
   - 逐 chunk 透传 SSE（`content` / `tool` / `notice` / `model` / `error`）
   - 流结束后存入 assistant message（含工具轨迹与本轮实际模型）
3. 前端回调更新 UI：正文逐字追加，工具步骤在气泡内单独展示状态，并按 `tool_call_id` 归位各自的增量与进度
4. 中途断流（浏览器掉线、网关掐流、上游被掐）时，`runTurn()` 先把已生成的部分连同工具轨迹落库，再由前端拿它调 `/api/chat/resume` 续写，详见下节

### 场景化模型选择

定义在 `functions/api/src/chat/model-router.ts`（纯函数，可直接进离线评测），服务端编排只在 `chat.service.ts` 里调一次 `pickModel()`。
目标是**同一份配置内的几档模型按本轮问题挑一档**：不新增供应商、不改协议，前端只在配置弹窗里把模型改成可多选的下拉。

「档位」是服务端内部口径：界面上用户只勾选要用的模型（不出现「第几档」），浏览器按供应商预设「从省到强」的顺序把勾选结果落成 `routingCandidates`，最后一档同时写入 `model` 作为无候选时的主力。

| 环节       | 做法                                                                                                                                       | 为什么这样选                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候选从哪来 | 先取生效配置的 `api_config.routingCandidates`（**按档位从低到高**逗号分隔），留空才回落到 `MODEL_ROUTING_CANDIDATES`；两者都空即整层关闭   | 候选名属于某一家：把 `deepseek-v4-pro` 挂在环境变量上，切到智谱后这一档就会发给它的网关拿 4xx，而界面只看得见「答不上来」。所以归属做成「每份配置自带 + 全局兜底」，DTO 层再按该家的 `modelHint` 拒掉跨家候选。模型名不写死在代码里：供应商的 id 会换，用户也未必开通了高那一档。配了不存在的名字会在上游拿到 4xx，宁可让配置者自己负责，也不在代码里替它兜底 |
| 谁来判定   | 服务端算复杂度分，而不是让模型自选                                                                                                         | 做成模型自选要多加一个「换模型再答一遍」的工具：多一跳、双份 token、失败难归因，还会白吃掉 `AGENT_MAX_TURNS` 的轮数预算。而这里的信号（长度、是否含代码、是否要推理）本来确定可得                                                                                                                                                                             |
| 判定信号   | 长度分档（≤40/≤200/≤800/更长 → 0/0.1/0.22/0.34）+ 四类关键词权重（要求深入 0.34、分析设计类 0.22、含代码 0.26、格式要求 0.12），求和封顶 1 | 「仔细/深入」这类显式要求权重最高，不该被长度压过去；封顶是为了信号叠满也不越过最高档，否则多候选时永远用最贵的                                                                                                                                                                                                                                               |
| 落档       | `index = min(候选数-1, floor(score × 候选数))`                                                                                             | 线性映射，加第三档不用改逻辑；`min` 保证越界也只会落在最高档而不是掉出白名单                                                                                                                                                                                                                                                                                  |
| 生效范围   | 每轮请求算一次，本轮所有工具迭代沿用同一个模型                                                                                             | 一次回答中途换模型，工具前后的口径会不一致；决策成本也就一次正则匹配                                                                                                                                                                                                                                                                                          |
| 界面可见   | 流开头下发 `model` 事件（id/reason/score），顶栏显示最近一条回答的模型，气泡标注该条模型并把理由放悬停                                     | 配置里那个主力模型名不再等于答案来源。不说清「刚才是谁答的、为什么」，用户只会觉得同一句话有时快有时慢                                                                                                                                                                                                                                                        |
| 落库       | 写进 `messages.model`，续传时优先沿用                                                                                                      | 见「断线续传」表里那一行：换模型续写会让前后半段自相矛盾                                                                                                                                                                                                                                                                                                      |
| 关掉的方式 | `MODEL_ROUTING_ENABLED=false` 或候选留空                                                                                                   | 留一个能一键回到「恒用主力模型」的口子，对比测试和排障都靠它，不必回滚代码                                                                                                                                                                                                                                                                                    |

环境变量：`MODEL_ROUTING_CANDIDATES`（默认空，只作配置未填时的兜底）、`MODEL_ROUTING_ENABLED`（默认 `true`，仅在最终候选非空时有意义）。
`GET /api/health` 报的 `modelRouting` 是总开关、`modelCandidates` 是环境变量那一份兜底候选——每份配置自带的候选属于账号数据，未登录的健康检查不该看到别人的配置，登录后看 `GET /api/config` 的 `items[].routingCandidates`。

### 上下文窗口与滚动摘要

定义在 `functions/api/src/chat/`：`token-estimator.ts`（估算+裁剪）、`context-summarizer.ts`（压缩）、`llm-client.ts`（非流式内部调用）。

| 环节       | 做法                                                                              | 为什么这样选                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| token 估算 | CJK 1 字/token、其他 4 字符/token、每条消息 +4、工具轨迹按 JSON 原文计入          | 不装 tiktoken/gpt-tokenizer：DeepSeek 分词器与 cl100k 并不一致，装一个“精确到别的模型”的库反而给人虚假安全感；这里只需决定“丢多少轮”，±20% 误差只影响窗口边界一两轮 |
| 滑窗       | `planWindow(messages, budget)` 从最新往回累加，超出即停                           | **最新一条无条件保留**：丢了它本轮请求就没有用户问题，比撞上限更糟                                                                                                  |
| 摘要       | `SUMMARY_PROMPT` + `completeOnce()` 非流式调用，失败退回抽取式 `extractiveDigest` | 摘要边界 `summaryUntil` 随裁剪一起推进，同一段旧对话不会被反复压缩，也不会既在摘要里又原文重发                                                                      |
| 工具轨迹   | 不进摘要（它的结论已体现在 assistant 正文里）                                     | 重复计入只会推高压缩成本                                                                                                                                            |
| 成本控制   | 摘要正文自身也要吃额度，先扣 `estimateTokens(priorSummary)` 再算窗口              | 否则摘要越长、窗口越窄会形成正反馈                                                                                                                                  |

环境变量：`CONTEXT_TOKEN_BUDGET`（默认 6000）、`CONTEXT_SUMMARY_ENABLED`（`false` 则只裁剪不压缩，旧上下文直接退出）。

### 跨会话长期记忆

策略层 `functions/api/src/memory/memory-policy.ts` 是纯函数（开关、三类上限、归一化与指纹、注入挑选与渲染、编号解析），服务层 `memory.service.ts` 只管读写与淘汰，编排层 `chat/request-context.ts` 只管把它拼进请求。**分成三层同一条理由**：这些判定既要在 Nest 里跑，也要能被评测脚本在没有数据库、没有容器的条件下直接断言。

| 环节               | 做法                                                                                                                                                                   | 为什么这样选                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注入位置           | 独立一条 `system`，顺序为 提示词 → **记忆** → 摘要 → 历史（[request-context.ts:30](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/request-context.ts#L30)） | 越靠近历史的部分越该是「这一场对话特有的」：记忆是跨会话的稳定事实，摘要只是本会话早期内容的压缩。合并进提示词那条 `system` 会让版本对比和裁剪口径都变糊 |
| 为什么不写进历史   | 一律不入库、不入 `messages`                                                                                                                                            | 进了历史就会被滑窗裁剪、被滚动摘要压缩、被用户在前端编辑，还会每轮重复计入 token。评测里「记忆只进 system 段」断言的正是这条                             |
| 写入路径           | 模型 `remember` / 面板手写，共用同一个 `remember()`，只差 `source`                                                                                                     | 两份实现必然漂移成「面板里看到的和模型记的不一样」；去重、长度拦截、淘汰也只需写一遍                                                                     |
| 去重               | 归一化（折叠空白 + 转小写）后 sha256，配 `(userId, fingerprint)` 唯一索引；命中就**刷新时间并回原编号**                                                                | 归一化让「多打两个空格、大小写不同」不至于记成两条；刷新而不是拒绝，是因为用户重说一遍同一偏好时他的意图是「强调」，不是报错                             |
| 超上限             | 条数超出按 `updatedAt` **淘汰最旧**，而不是拒绝写入                                                                                                                    | 刚说的一条新偏好重于半年前的旧习惯；让写入失败只会换来模型反复重试，配额照样花掉                                                                         |
| 注入取舍           | 新→旧取整条，成本按**渲染后整行**（编号 + 正文 + 分隔符）算；被挡掉的条数在文本里如实写「另有 N 条未列出」                                                             | 预算若只按正文算，几十条记忆的编号与换行会悄悄把字符数顶上去。不写「另有 N 条」，模型会以为自己看到了全部，进而断言「你从没说过 X」                      |
| 给模型的编号       | uuid 去连字符后前 8 位，`forget` 允许前缀匹配，前提是在该账号条目里唯一                                                                                                | 完整 uuid 太长且模型抄错一位就找不到；放宽到前缀的兜底是「不唯一就报歧义并列出候选」，绝不猜一个删掉——误删用户偏好比多花一轮对话严重                     |
| 注入文本的行为约束 | 三句话：本轮明确说法优先 / 冲突时用 `forget` 删过时那条 / 不要复述清单、不要在回答里标编号                                                                             | 缺第一条它会拿旧偏好压过用户刚提的要求；缺第二条纠正只能靠用户手动；缺第三条它会把清单原样吐回界面                                                       |
| 读失败             | `list()` 捕获一切异常退化成「没有记忆」+ 一条 warn                                                                                                                     | 长期记忆是锦上添花，不该把一次对话钉在「生产库 DDL 还没跑」这种运维步骤上。缺表由 `/api/health` 的 `memoryTable` 与日志暴露                              |

环境变量：`MEMORY_ENABLED`（默认 `true`，只认字面 `false`）、`MEMORY_ITEM_MAX_CHARS`（200）、`MEMORY_MAX_ENTRIES`（100）、`MEMORY_INJECT_MAX_CHARS`（1500），三者都有代码内下限兜底。
`/api/health` 暴露 `memory` / `memoryTable` / `memoryLimits`，线上「到底记没记进去」不重新发布就能查。

> **免登录演示模式下这份记忆是共享的**：`AUTH_ENABLED` 不为 `true` 时所有访客挂在同一个演示账号上，共用同一份记忆、也都能删掉彼此记下的内容。这是免登录既有的代价面之一，不是记忆引入的新洞，但记之前要想清楚（见「免登录演示模式」）。

### 工具并发执行

一轮返回多个 `tool_calls` 时，不再 `for...of await` 串行，而是先统一登记步骤并发出 `calling` 事件，再交给 `agent/tool-runner.ts` 的 `runWithConcurrency(items, limit, worker)`。

- 上限 `AGENT_TOOL_CONCURRENCY`（默认 4）。必须封顶：模型一次返回十几个 `fetch_url` 完全可能，不设上限等于**让模型决定实例的出站连接数**，在 256MB 内存的函数实例里很容易失控
- 不用裸 `Promise.allSettled(items.map(...))`：那样会一次性启动全部任务。这里用 N 条 worker 抢任务号，并发度可控，同时保留“单个失败不影响整体”的语义
- 保序：结果写入按 index 预分配的槽位，与完成先后无关，因此回填给上游的 `role: tool` 消息顺序与 `tool_calls` 一致
- 错误隔离：worker reject 仅体现为该槽位的 `{ok:false, reason}`（`executeTool` 内部已吃掉异常，这层只为未来可能 reject 的工具兼容）

### 工具结果流式推送

以前工具卡片只有「执行中 → 突然全文」，一次十几秒的 `fetch_url` 期间界面没有任何反馈，用户分不清是在跑还是卡死。现在工具在执行期间就能推增量。

| 环节             | 做法                                                                                                                                                                                                                         | 为什么这样选                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 回调怎么进工具   | `ToolContext.report?: (patch) => void`（[tools.ts:47](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L47)），由 `chat.service` 在每次 `executeTool` 时按该次调用现绑一个闭包，闭包里带着 `tool_call_id` | 工具不该认识 SSE，也不该自己拼事件体；后台执行器与评测脚本走同一条代码路径，只是不传 `report`，工具必须照常跑完（[tools.ts:322](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L322)） |
| 事件形态         | 三段式 `calling → streaming* → done\|error`；`streaming` 里 `delta` 与 `progress` 可以只有其一                                                                                                                               | 「校验第 N 跳地址」「开始接收响应」这类阶段没有正文可推，硬造一个空 `delta` 会让前端多累加一次空串，序列化时干脆不带这个键                                                                                  |
| HTML → 纯文本    | `agent/html-text.ts` 的 `HtmlTextStream`：增量喂字节、增量出正文，**任意切分下拼起来与整篇 `htmlToText` 逐字相同**                                                                                                           | 这是整个功能成立的前提。抽取结果与切分方式有关，界面就会先长出一段又被终态 `result` 改写，比不流式更糟。跨块的多字节字符用 `TextDecoder({stream:true})`，标签名、实体、`<script>` 块都可能正好被切开        |
| 谁被抽出来       | 丢弃 `<script>` / `<style>` / 注释，折叠空白与换行，还原 HTML 实体；正文满 `FETCH_TEXT_LIMIT=3000` 字后停止产出并置 `full`                                                                                                   | 脚本源码混进正文既污染模型输入又白吃 token；到上限还继续下载只会把带宽花在丢弃的内容上，阶段名会如实变成「正文已读满，停止下载」                                                                            |
| 终态与增量的关系 | 终态 `done` 带**完整** `result`，前端用 `step.result ?? step.delta` 覆盖                                                                                                                                                     | 两边由同一份抽取器产出，所以是同一串文本：覆盖不是改写，用户看不见跳变。缺了这条不变量，累加逻辑就不能这么写                                                                                                |
| 多工具交错       | 每个事件都带 `tool_call_id`，前端按 id 归位到对应卡片；一行的「N 个进行中」按未终态计数                                                                                                                                      | 一轮并发几个工具就有几条独立事件流交错到达，靠事件顺序无法区分是哪张卡的进度                                                                                                                                |
| 界面呈现         | 卡片执行中显示已累加的正文 + 一行量化进度（阶段名、已下载字节/上限、已抽取字数），终态换成完整结果（[ChatInterface.tsx:41](file:///D:/MyProject/ai-chat-gitee/frontend/src/components/ChatInterface.tsx#L41)）               | 只写「加载中」等于没写；给出字节与字数，用户才知道慢在哪、还要等多久                                                                                                                                        |
| 非 2xx           | 目标返回非 2xx 直接判失败，错误文本带状态码                                                                                                                                                                                  | 错误页也是一段 HTML，抓下来当正文喂给模型，模型会一本正经地总结「502 Bad Gateway 表示……」                                                                                                                   |

评测 `tool-streaming`（5 项）钉住的就是这几条不变量：三段式每条带 `id`/`name`、切分无关性（8 个样本 × 7 种切分）、抽取口径、上限处停止产出且 delta 累加不超过 `result`、跨块多字节解码。

### 后台任务队列（执行器待部署）

长任务与 HTTP 请求的生命周期天然冲突：函数实例硬顶 300 秒、前端 `pagehide` 就会 abort，而“抓取十个页面再汇总”要跑得更久。所以这一能力拆成两半，**本次只交付不依赖常驻进程的那一半**。

已交付（`functions/api/src/tasks/`）：

| 部件                                    | 职责                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.entity.ts`                        | 队列的持久形状（见「Task」），状态/租约/退避/幂等字段一次配齐                                                                               |
| `task-policy.ts`                        | 纯函数策略层：状态机 `canTransition`、可领取判定 `isClaimable`、退避 `backoffMs`、失败编排 `planFailure`、文本上限 `clipText`、环境变量读取 |
| `task-registry.ts`                      | kind 注册表：有哪些 kind、payload 长什么样、领取后怎么解释                                                                                  |
| `task.service.ts`                       | 面向请求的 CRUD + 面向执行器的 `claimNext` / `renewLease` / `isCanceled` / `report` / `succeed` / `fail`                                    |
| `tasks.controller.ts`                   | REST 入口（见「后台任务」）                                                                                                                 |
| `agent/tools.ts` 的 `run_in_background` | 让模型自己提交长任务，只回任务编号不回结果                                                                                                  |

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
- 正文含三块：工具使用准则、工具判定示例（few-shot，只示范该不该调、调哪个、参数怎么给）、输出格式规范。记忆能力加的是**判定口径**而不是新段落：什么算「关于用户的长期事实」（称呼、职业、长期偏好）、什么不算（本轮临时问题、任务细节、对话里已写明的事实、未经确认的猜测）、编号对不上时要先问不许猜、工具清单里没有 `remember`/`forget` 就说明功能已关闭、不要臆造调用

`npm run eval`（离线，79 项断言分 12 组：prompt 6 / tool-behavior 21 / context-window 5 / tool-concurrency 3 / tool-registry 4 / background-task 7 / auth-mode 3 / resume 5 / model-routing 6 / long-term-memory 7 / tool-streaming 5 / multi-provider 7，无需网络与 Key）覆盖：工具计算与异常、SSRF 护栏（元数据端点/回环/私网/非 http 协议）、`planWindow` 裁剪语义、并发上限与保序、`baseUrl` 归一化、工具注册表自洽（每个 spec 都有 schema 与 handler、开关只影响 `run_in_background` 的可见性、参数校验一次说清缺参/错型/多参/超长）、后台任务队列语义（终态不可复活、过期租约可回收、退避门与次数上限、kind 注册表与工具注册表口径一致、`resolve` 拒绝无人能执行的任务）、鉴权模式判定（`AUTH_ENABLED` 缺省即免登录且只认字面 `true`、与 `BACKGROUND_TASKS_ENABLED` 互不串线、兜底账号名符合 `users.username` 存储约定）、断点续传的上下文拼装不变量（前缀顺序、半截去重、缺问补份、拒绝条件、可重试返回码、工具轨迹合并不重不漏）、模型路由分档不变量（未配置或显式关闭恒等主力、候选解析与低到高顺序、分数线性落档且封顶不越白名单、续传沿用白名单内的中断那轮模型、缺记录或模型已下架时回退路由器）、长期记忆不变量（开关只认字面 `false` 且三类上限带兜底、去重看归一化后的内容、注入按新→旧且超预算计入 omitted 并如实说明、注入文本自带编号与三条行为约束、编号解析的完整/前缀/歧义/不存在四态、`remember`+`forget` 随开关一起广播、**记忆只进 system 段绝不混进会话历史**）、工具流式不变量（三段式事件每条带 id 与 name、HTML 抽取与切分方式无关、抽取口径、正文到上限即停止产出且 delta 累加不超过终态 result、跨块多字节字符按 stream 模式解码）、多供应商不变量（注册表自洽且 id 不重复、Key 形态规则按家取且样例互斥、留空放行＝沿用库里那把、baseUrl 强制 https 且允许带路径、前端 presets/`ProviderType`/`PROVIDER_ORDER` 与后端注册表逐家对齐、候选优先级配置 > 环境变量、跨家候选保存即被拒且点名、路由不依赖环境变量也能用配置候选）。`npm run eval:online` 用 `EVAL_API_KEY` 做非流式请求，断言 `expectTool` 命中率，可用 `--min-accuracy` 卡下限；在线模式缺 Key 时报错退出而不是静默通过。运行命令见 README「改完怎么验（三层）」。

> 评测集已经发现过两个真实缺陷：calculator 的标识符正则不含数字，`log10(1000)` 被切成 `log`+`10` 报“需要括号参数”；另一个是用例自写错（期望“星期X”，工具实际输出“周日”）—— 后者提醒断言要对着实现写，而不是对着描述文字写。

### 验证为什么分三层

离线断言吃的是纯函数与编译产物，它**结构上看不见**这几类东西：SSE 帧的真实切分、DTO 装配之后到底返回什么状态码、事务里挪生效指针的实际效果、续传时上游一共收到几次请求。这些原先每次验证都要临时搭一套链路演一遍，脚本用完就删，下次从头再写——三层就是把这件事固定下来：

| 层   | 命令                  | 实测                    | 证到哪                                                                                                                                                      |
| ---- | --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 静态 | `npm run verify`      | 3.8s（同口径串行 8.2s） | 类型、构建、79 项离线不变量、前端构建；前端 lint 跑但只报不判                                                                                               |
| 协议 | `npm run verify:live` | 4.9s                    | 49 项装配后的行为：SSE 顺序与 `[DONE]` 收尾、断线半截落库与续传只补增量、按家校验与生效指针、记忆注入与开关、工具事件带 id、SSRF、明文 Key 不进响应也不进库 |
| 界面 | 浏览器真点            | —                       | 文案、空态/错误态、进度条长得对不对；以及「模型会不会自己决定调工具」（`eval:online`）                                                                      |

- **`verify:live` 直接 `node` 起 runner，不套一层 npm**：npm 会把 `--only=...` 当成自己的 config（`--only` 还是 npm 的真有选项），根脚本里再套 `npm --prefix ... run eval:live` 时参数根本到不了 `run-live.mjs`——表现是「指定了子集却全跑一遍」且不报错。要跑子集得写成 `npm run verify:live -- --only=chat-core`，而这条能成立的前提是根脚本最后一段就是那条 node 命令。
- **lint 在静态那层只报不判**：仓库里挂着一条与当次改动无关的既有 eslint 报错（`ChatInterface.tsx` 的 `react-hooks/preserve-manual-memoization`），只要它还在，`npm run verify` 就恒返回 1——一条永远红的命令不能当闸门，否则第一次真回归时没人看得出区别。所以 `scripts/verify.mjs` 把 lint 标成 advisory：照旧并行跑、照旧打完整输出、结果行标 `exit 1（只报不判）`，但不计进退出码；其余四步任一失败仍返回 1。要把 lint 当硬门的地方（比如 CI）单独跑 `npm run lint`，返回码不变。等那条报错修掉，去掉 `advisory: true` 就恢复全判。
- **静态那层为什么分道而不是全并行**：两个 `tsc` 同时写 `dist/` 与 `.tsbuildinfo`，产物来自哪一次都不确定，会得到假绿。于是后端一条道（typecheck → nest build → 离线断言）、前端 lint 与前端构建各占一条道。后端道里省掉了 `npm run eval` 自带的第二次 `nest build`——同一条道刚刚构建过，省 2~3 秒且不改变被测代码。
- **协议那层的假上游是独立进程而不是 mock 库**：断线、上游 401、一轮内并发两个工具这些边界，只有真的把 socket 毁掉才演得像。掐流前先等 60ms 让前半段真的落进 socket，否则后端什么都没收到，演的就成了「上游一次都没回话」——这不是细节，是这条断言的全部意义。
- **播种走数据层，不走 HTTP**：`baseUrl` 必须 https 是产品约束，为了演通把它放宽等于把要验的东西本身改掉。所以假 Key + `http://127.0.0.1:4102` 的配置由 `evals/live/seed.mjs` 直接落库（校验只在 DTO 层），而 https 的拦截由 `config` 组那条 400 断言在 HTTP 层负责。两家配置的 baseUrl 指向同一个假上游的两条路径，「切家后真的换了 Key、走了那条路径」才在上游日志里看得见。
- **不污染真实数据由脚本结构兜住**：库在 `os.tmpdir()`、主密钥每次随机、密钥是假串、跑完自动清理（失败才保留现场打印路径），端口被占只报属主不杀进程。以前这条要靠人每次都记得，现在不用记。
- 上游日志 `upstream.jsonl`（每条请求的 model / Key 尾 4 位 / 路径 / system 段摘要）是续传与切家这类断言唯一的证人；断言失败时它连同后端 stdout 一起留在临时目录里。

### 免登录演示模式：一个开关，两条登录路径共存

需求是「原有真实登录不动，加个环境变量能跳过登录，且直接用现有数据」。落地时刻意只动了一处：

- **绕行的落点在守卫，不在业务**：`AuthGuard` 在 `isPublic` 之后、解析 token 之前判断 `authEnabled()`，为假就把演示身份挂上直接放行。控制器、服务层、数据隔离条件一行没改，也就不存在「免登录专用分支」日后与真实登录分支各自漂移的问题。`request.authToken` 置 null 是唯一的行为差异，而它只被 `logout` 用到。
- **演示身份 = 最早创建的账号，而不是新账号**：这样现有 API Key 与历史对话原样可见，不用为演示复制一份数据，也不用把用户的账号改名。空库时才兜底建 `demo`，走「第一个注册账号」同样的 `claimUnowned` 认领逻辑，两条路径的语义因此一致。查询用 `find({ order: { createdAt ASC, id ASC }, take: 1 })` 而非 `findOne({})`——TypeORM 0.3 的空 `where` 会直接抛错，id 作次级排序保证并发下选中的是同一条。
- **随机口令且不外泄**：兜底账号的密码是 32 字节随机值的 base64url，没人知道它，真实登录路径永远进不来，免登录也不依赖它。
- **模式探测放在首屏且 fail-closed**：前端 `fetchAuthMode()` 拿不到结果就按「需要真实登录」处理。把需要鉴权的部署误判成免登录（用户看到主界面却处处 401）比多显示一次登录页严重得多。
- **默认值是免登录，这是有意的方向性选择**：开关缺省为 `false`，发布上去不用配任何东西就能用；代价是漏配只会失效到「不鉴权」那一侧。所以线上处于哪一侧必须能不重新发布就查到——`/api/health` 的 `auth` 字段就是为此存在，README「上线验收」据此解释为什么免登录时 `/api/tasks` 不带 token 也返回 200。
- **判定只认字面 `'true'`**：与 `BACKGROUND_TASKS_ENABLED` 同一套约定，`1`/`TRUE`/`yes` 一律不算开启，避免两种开关对同一个值给出不同答案。

## 安全设计

- API Key 经 AES-256-GCM 加密后落库（密文格式见「ApiConfig」），主密钥 `ENCRYPTION_KEY` 从环境变量注入；`GET /api/config` 只返回每份配置的 `apiKeyMasked`，明文仅在调用上游时存在于内存。多家并存不改变这条：每个 provider 各存各的密文，接口从不回明文
- 更新已有那一份时 Key 留空（或仍填掩码）表示「沿用库里那把」，由服务层判断并保留原密文——把它当新 Key 加密入库会存进一把空密钥，上游只回 401 而界面上看不出原因
- 主密钥缺失或格式非法时拒绝保存，错误信息里直接给出生成命令；不会退化成明文落库。读到历史明文配置会在密钥可用时自动加密回写
- 口令散列参数见「User」；登录接口无论用户是否存在都执行一次 scrypt（不存在时比对固定 `DUMMY_HASH`），避免用响应耗时枚举用户名
- 业务接口默认要求 Bearer token（`AUTH_ENABLED=true`）；所有会话读写以 `userId` 为过滤条件，越权访问一律 404，不区分“不存在”和“不是你的”
- **免登录是该约定的唯一例外，且例外只写在守卫里**：`AUTH_ENABLED` 不为 `true` 时全站共用最早创建的账号身份，`/api/chat`、`/api/config`、`/api/memories` 对所有能访问域名的人开放——配额被陌生人消耗、配置被改写、**长期记忆被彼此看见与删除**都在所难免，只剩按 IP 限流一层。明文 Key 仍不会外泄（`GET /api/config` 只回掩码），`/api/health` 的 `auth` 字段负责把这个状态暴露在探活里而不是埋在部署配置里。对外收紧就设 `AUTH_ENABLED=true` 重新部署，代码不用动
- token 存 localStorage 而不是 Cookie：后端是独立的云函数域名，跨站 Cookie 需要 SameSite=None 且依赖网关配合；代价是 XSS 可读，依赖 React 转义兜底
- 前端不直连大模型，密钥不进入浏览器
- `fetch_url` 工具走 URL 校验（`security/url-guard.ts`）+ 超时与体积上限，防 SSRF 和超大响应；协议限制、域名黑名单、**字面量 IP 与 DNS 全量解析结果都不能落入内网**，且每跳重定向重新校验
- 本地开发由 Vite proxy 仅转发 `/api/*`；云端跨域只靠网关安全域名放行，函数侧 `CORS_ORIGINS` 留空

## 前端模块职责

| 文件                                         | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/client.ts`                     | 封装所有后端 HTTP/SSE 调用（含 `truncateConversation`、`resumeChat`）；`streamChat` 与 `resumeChat` 共用同一个 `runChatStream`，只有路径和请求体不同，回调统一收进 `ChatStreamHandlers` 对象——`onChunk`/`onNotice` 签名一模一样，再排位置参数就会悄悄接错而 TS 抓不到同类型的顺序错误；流没等到 `[DONE]` 就结束时抛 `ChatStreamError(…, retryable=true)`，把「网关掐流」和「正常写完」区分开；`model` 事件转成 `onModel`，界面据此说明「刚才是哪个模型答的」；`tool` 事件整体转成 `onStep`（含 `delta`/`progress`/`status`），客户端不理解增量语义，只在 App 里合流；长期记忆三个调用 `fetchMemories` / `createMemory` / `deleteMemory`，返回体统一是 `{ items, limits }` 信封（写入也回整份清单：一次写入可能连带淘汰旧条目，只回新增那条会显示成少了一条）；`updatedAt` 在这里收窄成 `number`——后端 `Date` 会序列化成 ISO 串，而 sqljs 与 Postgres 也可能直接给毫秒数，界面只该看到一种；统一管理 token（localStorage）与 `Authorization` 头，任一接口 401 时广播 `ai-chat:unauthorized` 让 App 收回登录态；`fetchAuthMode` 问后端当前是否免登录，拿不到结果就按需要真实登录处理                                                                                                                                                              |
| `frontend/src/apiConfig.ts`                  | PROVIDER_PRESETS（给 Modal UI 渲染用，id 与默认值必须和后端 `PROVIDER_REGISTRY` 逐家一致，由 `multi-provider` 断言钉住）、`PROVIDER_ORDER`、表单校验工具（`isHttpsBaseUrl`、`isProviderType` 收窄外部字符串）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `frontend/src/types.ts`                      | Message / Conversation / ApiConfig / ProviderType 类型；Message 上的 `model` 是本轮实际作答的模型（历史消息从库里读回，只有名字），`modelReason` 只在流式那一轮存在                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `frontend/src/App.tsx`                       | 状态管理：登录态、会话列表、当前会话、配置状态；首屏先问 `/api/auth/mode`，免登录时直接以返回的身份进入主界面，否则用 token 换登录态，未登录只渲染 `AuthView`；登录后没配 Key 自动弹设置窗；配置状态是一份 `ConfigListResponse`（`configured` / `active` / `items`），保存、切换、删除后统一 `refreshConfigs()` 重取——生效指针由后端决定，前端不自己推断「哪份该显示成当前使用」，弹窗也只在打开时挂载以免留着上次编辑的残值；`rewindTo` 统一承载“重新生成”与“编辑重发”（先改后端再同步本地）；发送链路自带续传循环 `resumeFromBreak`：`generated` 累积本轮已渲染文本，遇到 `retryable` 错误就先等 `online` 再退避重试，把 `generated` 当 `partial` 续写，最多 3 次，耗尽或不可续时保留半截回答并给出明确结尾；`onModel` 把服务端的路由决策写进当前 assistant 气泡（`model` + `modelReason`），续传那轮收到的理由会覆盖首发那轮的，因为「沿用」才是此刻的事实；`pagehide`/卸载时 abort 在途 SSE；`onStep` 按 `tool_call_id` 合流进行中的步骤（同 id 覆盖，新 id 追加），`delta` 只在执行期累加、终态一律以 `result` 为准并把 `delta`/`progress` 清掉——留着会显示两遍；`remember`/`forget` 落到终态时自增 `memoryRevision`，记忆面板据此重拉清单：清单是模型改的，界面只能从工具终态得知，不重取的话用户看不到「它到底记了什么」，也就没机会纠正 |
| `frontend/src/components/AuthView.tsx`       | 登录/注册页：模式切换、前置长度校验、错误提示、提交中禁用按钮                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `frontend/src/components/ChatInterface.tsx`  | 纯 UI：侧栏 + 气泡 + 输入框 + Markdown 渲染 + 工具步骤面板；“重新生成”仅给最后一条回答，“编辑重发”仅给历史用户消息；顶栏展示当前账号与「退出登录」（生成中禁用）；那个模型名取**最近一条带模型标记的回答**（没有才退回配置里的主力模型），前面拼上生效那一份的供应商标（`智谱 GLM · glm-air`），一次配多家之后「刚才这句是谁答的」才有主语；气泡下方标出该条自己的模型、悬停给理由——一次会话里不同问题的档位可以不同，逐条标注才答得出「这句是谁说的」；`demoMode` 下账号旁加「免登录」标记并收起退出登录按钮——没有 token 可清，留着按钮只会给出一个点了没反应的入口；工具步骤卡片执行中显示累加正文与一行量化进度（`describeProgress`：阶段名 + 已下载字节/上限 + 已抽取字数），同批多个未完成时标「N 个进行中」，终态换成完整 `result`；顶栏并排挂「后台任务」与「长期记忆」两个抽屉入口                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `frontend/src/components/ApiConfigModal.tsx` | 配置弹窗 UI：**多家并陈**——上半区列出这个账号存过的每一家（「当前使用」徽章 / 「正在编辑」/ 编辑 / 设为使用 / 删除），下半区是所选那一家的 Key、模型、档位候选与 Base URL。Key 框留空即「沿用库里那把」，占位与掩码提示一起写清楚，改模型名不用重贴密钥；「保存后设为当前使用」勾选对应 `apply`，不勾就是先存着、回头再切。保存/切换/删除共用一个 `busy`，否则连点两次「设为使用」会把生效指针翻回前一份；表单初值在挂载时从 props 取一次快照（父组件只在打开时挂载本组件），挂在 effect 里重置会让列表刷新把用户正在编辑的内容一起覆盖掉；错误一律走 `role="alert"` 的中文提示条，不把上游原文抛给用户                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `frontend/src/components/MemoryPanel.tsx`    | 「长期记忆」面板（顶栏入口 + 右侧抽屉，由 ChatInterface 挂载）：自拉数据、不向 App 要清单，只接一个 `revision` 作为「模型刚改过」的信号；**不轮询**——清单只会被本浏览器发起的操作改动，定时拉取只会白占按 IP 的限流额度（和聊天接口同一个桶）；每行显示来源徽章（模型记的 / 用户手写的）、`[a1b2c3]` 短编号、更新时间与「忘掉这条」；副标题把当前口径摊开（`最多 N 条 · 单条 M 字`，来自服务端 `limits`，改环境变量后界面跟着变）；空态给出可直接照做的示范话术，读取失败带「重试」，手动补一条时实时校验字数并拦在 `MEMORY_ITEM_MAX_CHARS` 之内                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `frontend/src/components/TaskPanel.tsx`      | 后台任务面板（顶栏入口 + 抽屉）：自拉数据、不向 App 要 prop；有活跃任务且抽屉打开时 2s 轮询，否则降到 15s；`runnerEnabled=false` 时明确解释「任务只会排队」；提交表单按 `/api/tasks/meta/kinds` 的字段说明渲染；取消按钮只对进行中的任务出现，终态只展示结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 扩展方向

已落地（不再是待办）：多用户账号与数据隔离、免登录演示模式（`AUTH_ENABLED` 单开关，与真实登录共存）、CloudBase 静态托管 + HTTP 云函数部署、工具并发执行、上下文窗口裁剪 + 滚动摘要、跨会话长期记忆（`remember`/`forget` + 管理面板）、工具结果流式推送（三段式事件 + 边下边抽）、重新生成 / 编辑重发、SSE 断线自动续传、同供应商内的场景化模型选择、**多供应商配置（provider 注册表 + 每人每家一份 + 生效指针）**、提示词版本化 + 回归评测、后台任务的队列表与 REST 接口。

- 数据层根治：把 `DB_TYPE` 切到 `postgres`，消除多实例/冷启动导致的配置与历史丢失（当前所有“演示模式局限”的根因）
- 记忆的作用域与检索升级：现在只有「按账号 + 注入预算内全量塞进 system」这一档，条目到几百条或想按话题召回时，需要向量检索或按会话/标签过滤；`user_memories` 目前没有 embedding 列，也没有按相似度召回的路径
- 免登录下的记忆隔离：`AUTH_ENABLED=false` 时全站共用一份记忆，谁都能删别人的条目。要么开真实登录，要么给演示模式加浏览器侧分区（各有代价，见「免登录演示模式」）
- 更多工具接入流式：`report` 通道与事件契约是通用的，但目前只有 `fetch_url` 真用它推进度；工具若要支持「边生成边给结果」（如代码执行、长文档解析），照 `fetchUrlSpec` 的写法接 `ctx.report` 即可，前端不需要改
- 对话分支：`truncateFrom` 已经是它的地基，缺的是一份“父消息/分支树”数据模型与前端切换 UI
- 历史消息分页/虚拟滚动：现在一次 `GET :id` 拉全量；长对话需后端加分页 + 前端定高虚拟化
- 多路并发 SSE：单路流内能做的是工具并发；“一个请求开多路回答”需先把数据层切到 postgres 并调高 `InstanceConcurrency`
- 后台长任务的**执行器**：队列、租约/退避/重试/幂等与 REST 接口都已就位，缺一个调用 `claimNext()` 的常驻进程（不能塞进 HTTP 函数）。上线后把 `BACKGROUND_TASKS_ENABLED` 置 `true`，模型才会拿到 `run_in_background`；见「后台任务队列」
- 多供应商 / 多模态的落地顺序（2026-11 复盘，**别跳步**）：下面 1→2→3 是硬依赖，4 之后才谈得上传输入模态
  1. **供应商规则与「每人多份配置」**（已交付，2026-11）：接第二家真正拦路的是三条写死的全局校验——`@IsIn(['deepseek'])`、Key 必须 `^sk-` 开头、baseUrl 必须 `^https://[^/]+$`（**不允许带路径**，而智谱的 OpenAI 兼容端点恰好要填 `https://open.bigmodel.cn/api/paas/v4`）。出站拼 URL 的 `resolveCompletionsUrl()` 早就支持「根 / `/v1` / 完整路径」三种填法，是入口校验把能力挡住了。落地的形态：后端一份 provider 注册表（Key 形态、baseUrl 形态、默认模型、`modelHint`），DTO 按 provider 取规则；`api_config` 从「每人 upsert 最近一条」改成 `(userId, provider)` 一行 + 一个 `active` 生效指针；前端 `PROVIDER_PRESETS` 与后端注册表重复的那份供应商 id，由 `multi-provider` 离线断言钉住一致，没有新加一个接口让前端去拉。**没做的**：供应商故障转移、按家分开限流与额度口径（现在所有 `/api` 共用一个桶），以及第 2 步的能力目录。
  2. **模型能力目录**（待办，且必须先于任何模态落地）：候选（每份配置的 `routingCandidates`，留空退回 `MODEL_ROUTING_CANDIDATES`）现在是手打的裸模型名，路由器只会按复杂度打分，完全不知道哪个档位能看图、能听声、能不能调工具。这里有个**反直觉的真实冲突**：往高档换不等于能力更多——`deepseek-flash` 支持图片输入而 `deepseek-v4-pro` **不支持**，所以带图的轮次一旦被判成「复杂问题」升级到 pro，读图能力就被换掉了，而前端只看到文本，查不出是这么丢的。有了能力位（vision / audioInput / tools / 上下架），候选挑选才能被约束成「本轮需要哪些能力 → 只在满足的档位里选」，界面也才有依据列可选模型。落库形态建议 `model_catalog(provider, modelId, capabilities, tier)`，同时取代手打环境变量。
  3. **消息内容从 string 变成「文本 + 附件引用」**：三处都要动——`ChatRequestDto.content`（`@IsString()` + `@MaxLength(8000)`）、`OutboundMessage.content: string | null`、`messages.content` text。附件**不要 base64 内联**：云函数有请求体上限，且把几 MB 图片当文本存进 `messages` 会把历史裁剪与 token 估算整个算歪；二进制走对象存储或上游 Files API，库里只存引用（mime / bytes / sha256 / 存储 key）。连带要改的还有：`token-estimator` 按字符估的口径要容纳「图片另计」，否则 `CONTEXT_TOKEN_BUDGET` 会「一张图当 8000 字」把上下文挤没；外链图片是一条**新的出站路径**，必须过 `security/url-guard.ts`；续传的 `partial` 只是文本前半段，带图轮次续传时附件怎么带回要重新定。
  4. **语音输入分两种，前置差很远**：ASR 旁路（录音 → 转写 → 转写文本走现在这条链路）**不需要** 3 的附件改造，是最快能演的「语音输入」；音频作为 input part 直接进模型才依赖 2 + 3，而且要逐个模型核对官方形态——智谱的图像生成、OCR 是专用接口，不在 chat completions 里。两者共同的新增前提：麦克风权限在非 localhost 只有 https 才给（CloudBase 域名满足）、上传与转写要单独限流口径（现在所有 `/api` 共用 `THROTTLE_LIMIT` 一个桶，上传会把聊天额度挤掉）。
  5. **跟着改的**：新能力要进 `evals`（能力位过滤、注册表自洽、附件不落日志）并升 `PROMPT_VERSION`；把校验按 provider 挪进注册表这件事已经在做，每挪一条都要跟着补断言，否则「为了让演示跑通而放宽校验」迟早出事。多家 Key 落在免登录站上等于公共资源——对外前先开 `AUTH_ENABLED=true`。
- 文生图：新增 CogView / DALL-E 接口，后端添加 `/api/images/generations` 代理（这类**生成**接口不在 OpenAI 兼容的 chat completions 形态里，属独立入口）
