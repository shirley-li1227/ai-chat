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
| 部署产物 | `ignore` 排除 `src`，云端执行包内 `dist/`，改源码必须重新 build + deploy |
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
| createdAt | datetime | 创建时间 |
| updatedAt | datetime | 最后更新时间 |

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
| GET | `/api/health` | `{ status, database: up/down, encryption: enabled/disabled }` |

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
| 工具开始 | `{"tool":{"id","name","args","status":"calling"}}` | 模型决定调用工具 |
| 工具结束 | `{"tool":{"id","name","result","ok","status":"done"}}` | 结果回填后模型继续推理 |
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
   - 查询该对话全部历史，按 `toolCalls` 还原为 `assistant.tool_calls` + `role: tool` 消息
   - 构造请求：`[system_prompt, ...history]`，带上 `tools` 与 `stream: true`
   - 多轮循环（上限 `AGENT_MAX_TURNS`）：模型返回 tool_calls 就本地执行工具、结果回填后重新请求，直到产出纯文本
   - 逐 chunk 透传 SSE（`content` / `tool` / `notice` / `error`）
   - 流结束后存入 assistant message（含工具轨迹）
3. 前端回调更新 UI：正文逐字追加，工具步骤在气泡内单独展示状态

### 系统提示注入

SYSTEM_PROMPT 定义在 `functions/api/src/chat/chat.service.ts`，仅在构造 API 请求时注入，不写入 DB、不出现在前端消息列表中。内容约束模型输出格式（表格必须逐行换行、代码块带语言标记等）。

### 安全设计

- API Key 经 AES-256-GCM 加密后落库，主密钥 `ENCRYPTION_KEY` 从环境变量注入；`GET /api/config` 只返回 `apiKeyMasked`
- 主密钥缺失或格式非法时拒绝保存，错误信息里直接给出生成命令；不会退化成明文落库。读到历史明文配置会在密钥可用时自动加密回写
- 前端不直连 DeepSeek，密钥不进入浏览器
- `fetch_url` 工具走 URL 白名单（`security/url-guard.ts`）+ 超时与体积上限，防 SSRF 和超大响应
- 本地开发由 Vite proxy 仅转发 `/api/*`；云端跨域只靠网关安全域名放行，函数侧 `CORS_ORIGINS` 留空

## 前端模块职责

| 文件 | 职责 |
|------|------|
| `frontend/src/client.ts` | 封装所有后端 HTTP/SSE 调用 |
| `frontend/src/apiConfig.ts` | PROVIDER_PRESETS（给 Modal UI 渲染用）、表单校验工具 |
| `frontend/src/types.ts` | Message / Conversation / ApiConfig / ProviderType 类型 |
| `frontend/src/App.tsx` | 状态管理：对话列表、当前会话、配置状态、发送/停止；`pagehide`/卸载时 abort 在途 SSE |
| `frontend/src/components/ChatInterface.tsx` | 纯 UI：侧栏 + 气泡 + 输入框 + Markdown 渲染 |
| `frontend/src/components/ApiConfigModal.tsx` | 配置弹窗 UI：供应商选择 + Key/Model/BaseURL 表单 |

## 启动命令

```bash
# 终端 1
npm run dev:api                    # NestJS :3001（functions/api）

# 终端 2
npm run dev                        # Vite :5173（自动 proxy /api → :3001）
```

## 扩展方向

- 多供应商支持：在 `PROVIDER_PRESETS` 中新增条目，后端 ChatService 按 provider 切换请求逻辑
- 文生图：新增 CogView / DALL-E 接口，后端添加 `/api/images/generations` 代理
- 用户认证：加入 JWT + 多用户隔离
- 生产部署：已落地 CloudBase 静态托管 + HTTP 云函数（跨域直调，见上文「云端部署架构」与 README「云端部署」）
- 数据层根治：把 `DB_TYPE` 切到 `postgres`，消除多实例/冷启动导致的配置与历史丢失
