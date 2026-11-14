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
                         │ HTTP / SSE (同源 /api/*)
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

## 技术选型

| 层面 | 选择 | 理由 |
|------|------|------|
| 前端框架 | React 19 + Vite 8 | 快速 HMR、生态成熟 |
| 样式 | Tailwind CSS 4 | 原子化、无运行时开销 |
| Markdown | react-markdown + remark-gfm | 支持 GFM 表格/任务列表/删除线 |
| 代码高亮 | react-syntax-highlighter (Prism) | 按需加载、100+ 语言 |
| 后端框架 | NestJS 11 | 模块化、DI、装饰器风格 |
| ORM | TypeORM 0.3 | NestJS 官方推荐、装饰器实体 |
| 数据库 | sql.js (SQLite in WASM) | 零配置、无需 C++ 编译、文件即数据库 |
| 大模型 | DeepSeek | 官方 CORS 友好、兼容 OpenAI 协议、价格低 |

## 数据模型

### ApiConfig（单行表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | 自动 |
| provider | varchar | 供应商标识（'deepseek'） |
| apiKey | varchar | 明文 Key，仅存后端 |
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
| timestamp | bigint | 毫秒时间戳（前端排序用） |
| conversation | FK → Conversation | 所属对话（CASCADE 删除） |

## API 接口设计

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

响应：SSE 流
```
data: {"content":"你"}
data: {"content":"好"}
...
data: [DONE]
```

错误时：
```
data: {"error":"具体错误信息"}
```

## 核心流程

### 发送消息

1. 前端调用 `streamChat(conversationId, content, onChunk, signal)`
2. 后端 ChatService：
   - 从 DB 读取 ApiConfig
   - 存入 user message
   - 查询该对话全部历史 messages
   - 构造请求：`[system_prompt, ...history]`
   - fetch DeepSeek（stream: true）
   - 逐 chunk 透传 SSE 给前端
   - 流结束后存入 assistant message
3. 前端 onChunk 回调更新 UI 中 assistant 气泡内容

### 系统提示注入

SYSTEM_PROMPT 定义在 `functions/api/src/chat/chat.service.ts`，仅在构造 API 请求时注入，不写入 DB、不出现在前端消息列表中。内容约束模型输出格式（表格必须逐行换行、代码块带语言标记等）。

### 安全设计

- API Key 明文仅存后端 SQLite，`GET /api/config` 返回脱敏值
- 前端不直连 DeepSeek，不存在 Key 泄露风险
- Vite proxy 仅转发 `/api/*`，不暴露后端其他端口

## 前端模块职责

| 文件 | 职责 |
|------|------|
| `frontend/src/client.ts` | 封装所有后端 HTTP/SSE 调用 |
| `frontend/src/apiConfig.ts` | PROVIDER_PRESETS（给 Modal UI 渲染用）、表单校验工具 |
| `frontend/src/types.ts` | Message / Conversation / ApiConfig / ProviderType 类型 |
| `frontend/src/App.tsx` | 状态管理：对话列表、当前会话、配置状态、发送/停止 |
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
- 生产部署：CloudBase 静态托管 + HTTP 云函数同域部署（/api 路径转发，见 README「云端部署」）
