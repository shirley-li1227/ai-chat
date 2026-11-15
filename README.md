# AI 聊天助手

基于 React + NestJS 的全栈 AI 聊天应用，支持流式输出、多轮对话、Markdown 渲染和代码高亮。

## 功能特性

- 流式输出：AI 回答逐字显示（SSE）
- 多轮对话：自动携带历史消息上下文，可按 token 预算滑窗裁剪
- 多会话管理：创建、切换、删除对话
- 多轮管理：最后一轮可「重新生成」，历史提问可「编辑重发」（回退到该条再重来）
- Markdown 渲染：支持 GFM 表格、任务列表、代码高亮
- API 配置弹窗：运行时填写大模型 API Key，无需重启
- Agent 工具调用：内置时间查询、精确计算、网页抓取三类工具，模型自主调用并在气泡中展示执行步骤
- 工具并发：同一轮多个 tool_calls 并发执行（可封顶并发度），结果按原顺序回填
- 提示词版本化：集中定义 + `PROMPT_VERSION` 随 `/api/health` 暴露，附 21 条离线回归用例
- 后端持久化：对话历史与配置落库（本地 sql.js/SQLite，云端可切 PostgreSQL）
- 安全设计：API Key 仅存后端，AES-256-GCM 加密后落库，接口只返回脱敏值

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS 4 |
| 后端 | NestJS 11 + TypeORM 0.3 + sql.js (SQLite) / PostgreSQL |
| 大模型 | DeepSeek（兼容 OpenAI Chat Completions 协议，含 tools 调用） |
| Markdown | react-markdown + remark-gfm + react-syntax-highlighter |
| 部署 | 腾讯云 CloudBase：静态托管 + HTTP 云函数 + HTTP 网关 |

## 快速开始

### 环境要求

- Node.js >= 20
- npm >= 10

### 安装与启动

```bash
# 1. 一次安装前后端依赖（在仓库根目录执行）
npm run install:all

# 2. 启动后端（终端 1）
npm run dev:api

# 3. 启动前端（终端 2）
npm run dev
```

打开浏览器访问 `http://localhost:5173`。

### 首次配置

1. 页面会提示"未配置 API"，点击右上角徽章或"立即配置"按钮
2. 在弹窗中填入 DeepSeek API Key（从 https://platform.deepseek.com 获取）
3. 点击"保存并应用"，Key 经 AES-256-GCM 加密后写入后端数据库
4. 即可开始对话

> 主密钥 `ENCRYPTION_KEY`（64 位十六进制）缺失或格式非法时，保存会返回明确错误——为避免明文落库，后端不会降级成明文存储。

## 项目结构

```
ai-chat/
├── frontend/                   # 前端（Vite + React）
│   ├── src/                    # 前端源码
│   │   ├── client.ts           # 后端 API 调用层
│   │   ├── apiConfig.ts        # 供应商预设 & 表单校验
│   │   ├── types.ts            # TypeScript 类型定义
│   │   ├── App.tsx             # 根组件（状态管理）
│   │   └── components/
│   │       ├── ChatInterface.tsx    # 聊天主界面
│   │       └── ApiConfigModal.tsx   # API 配置弹窗
│   ├── dist/                   # 构建产物（npm run build:frontend）
│   ├── vite.config.ts          # /api proxy → :3001
│   └── package.json
├── functions/                  # 后端云函数目录
│   └── api/                    # 接口云函数（函数名：api，type: HTTP）
│       ├── src/
│       │   ├── main.ts         # 启动入口（本地 :3001）
│       │   ├── app.module.ts   # 根模块（TypeORM 配置）
│       │   ├── config/         # API 配置 CRUD（加密落库 / 明文迁移）
│       │   ├── conversations/  # 对话 & 消息实体/服务
│       │   ├── chat/           # SSE 代理转发大模型 + Agent 多轮工具循环
│       │   │   ├── prompt.ts           # 系统/摘要提示词 + PROMPT_VERSION
│       │   │   ├── token-estimator.ts  # token 估算与滑窗裁剪
│       │   │   ├── context-summarizer.ts # 旧轮次的滚动摘要
│       │   │   └── llm-client.ts       # baseUrl 归一 + 非流式内部调用
│       │   ├── agent/          # 工具定义与执行（时间 / 计算 / 网页抓取）+ 并发执行器
│       │   ├── security/       # AES-256-GCM 加解密、URL 内网拦截
│       │   └── health/         # 探活接口（含 promptVersion）
│       ├── evals/              # 提示词/工具回归集与运行脚本（不随函数包上传）
│       ├── dist/               # 构建产物，云函数实际执行的代码
│       ├── data/               # SQLite 数据库文件（仅本地，自动创建）
│       ├── scf_bootstrap       # HTTP 云函数启动入口（LF，监听 9000）
│       └── package.json
├── cloudbaserc.json            # CloudBase 部署配置（functionRoot: ./functions）
├── package.json                # 仓库根编排脚本（install:all / dev / build）
├── PRD.md                      # 产品需求
├── TECH_DESIGN.md              # 技术设计（数据模型 / 接口 / 云端架构）
└── AGENTS.md                   # AI 辅助开发指令
```

> 关于入口文件：CloudBase 官方示例常用 `functions/api/index.js`（事件函数）。本项目需要 SSE 逐字流式输出，事件函数无法流式回包，因此 `api` 声明为 `type: HTTP` 自定义运行时，入口改为 `scf_bootstrap`（导出 `PORT=9000` 后执行 `node dist/main`）。

## 数据流

**本地开发**（同源，走 Vite 代理）：

```
浏览器 (localhost:5173)
  │  /api/*  →  Vite proxy
  ▼
NestJS (:3001) ── sql.js ──> functions/api/data/app.db
  │  HTTPS + SSE（stream: true, tools）
  ▼
DeepSeek API
```

**云端部署**（跨域，前端写死后端绝对地址）：

```
浏览器  https://<envId>-<appid>.tcloudbaseapp.com
  │  fetch https://<envId>.service.tcloudbase.com/api/*
  ▼
CloudBase HTTP 网关 ── 路径透传 /api/*；安全域名注入 CORS 并直接应答 OPTIONS 预检
  ▼
HTTP 云函数 api（scf_bootstrap → NestJS :9000）
  ├─ /api/config | /api/conversations | /api/health  → TypeORM
  └─ /api/chat (SSE) → 存 user message → 按 token 预算裁剪历史（旧轮次进摘要）
                       → 注入 system prompt → fetch DeepSeek（stream + tools，最多 MAX_TURNS 轮）
                       → 透传 content / tool 事件 → 存 assistant message
```

一次对话的事件顺序：`tool(calling)`×N → `tool(done)`×N（同一轮多个工具**并发执行**，calling 先全部发出，done 按 `tool_calls` 原顺序回填）→ `content` 逐字 → `notice?`（截断提示）或 `error` → `data: [DONE]`。

## 构建生产包

```bash
# 前后端一起构建
npm run build

# 或单独构建
npm run build:frontend   # → frontend/dist
npm run build:api        # → functions/api/dist
```

## 回归评测

提示词改一个字，工具命中率就可能变。`functions/api/evals/` 是一份可重跑的固定集，用来把“我优化了提示词”变成可比较的数字。

```bash
npm run eval                      # 离线：先 build 再断言，不需要网络与 API Key
$env:EVAL_API_KEY="sk-..."; npm run eval:online   # 在线：真实调模型，会消耗 token
npm run eval:online -- --min-accuracy=0.9         # 卡命中率下限，低于阈值退出码非 0
```

- **离线（默认）**：21 条用例直接调用编译产物里的 `executeTool`，断言计算结果、参数缺失/非法表达式异常、时间输出格式、SSRF 护栏（元数据端点/回环/私网/非 http 协议必须被拒）；外加几个结构不变量：提示词与工具定义对齐、`PROMPT_VERSION` 与用例钉住的版本一致、`planWindow` 保留最新后缀且永不丢弃最新一条、并发上限与保序。改完代码随手跑。
- **在线（`--online`）**：非流式 + `tool_choice: auto`，只看模型选了哪个工具（不判正文），输出按分类统计命中率。缺 `EVAL_API_KEY` 时直接报错退出，不会静默“通过”。
- 用例集里 `promptVersion` 与 `src/chat/prompt.ts` 不一致时评测直接失败：升提示词版本必须同时确认预期，两边不会越漂越远。

## 云端部署（腾讯云 CloudBase）

架构：前端走**静态托管**，后端走 **HTTP 云函数**，两者是**不同域名**，前端跨域直调函数网关（不是同域路径转发）。

| 资源 | 地址 |
|------|------|
| 前端（静态托管，写在托管桶根目录） | `https://<envId>-<appid>.tcloudbaseapp.com` |
| 后端（HTTP 云函数网关） | `https://<envId>.service.tcloudbase.com/api` |
| 本项目当前环境 | envId `lucky-lxy-d1g5yv28gd1a13d29` |

### 前置条件

- `npm i -g @cloudbase/cli` 并执行 `tcb login`
- 开通 CloudBase 环境；默认域名有限流，仅适合验证；自定义域名需 ICP 备案（约 7–20 天）
- 数据层二选一：
  - **演示**：`DB_TYPE=sqljs` + `DB_LOCATION=/tmp/app.db`，零外部依赖，但多实例不共享、冷启动清空（见「已知局限」）
  - **正式**：`DB_TYPE=postgres`（环境内置 PostgreSQL 或 TencentDB for PostgreSQL）；云函数访问数据库需开启 VPC，与数据库同 VPC/子网

### 部署配置

1. 仓库根创建 `.env.local`（已被 .gitignore 忽略），写入：
   ```bash
   ENCRYPTION_KEY=<主密钥，64 位十六进制，用于加密落库的 API Key>
   DB_PASSWORD=<PostgreSQL 密码，仅 DB_TYPE=postgres 时需要>
   ```
   `{{env.XXX}}` 由 CLI 在部署时从根目录 `.env.local` 插值进函数环境变量。
2. `cloudbaserc.json`（v2.1 schema）关键点：`envId`、`functionRoot: "./functions"`；函数不写 `dir`，由 `functionRoot/name` 推导为 `functions/api`（v2.1 中 `dir` 是相对项目根目录而非 functionRoot）。切 PostgreSQL 时只需补齐 `DB_HOST`、`DB_USERNAME` 为内网连接信息
3. 函数声明为 `type: HTTP` + `runtime: Nodejs20.19` + `gatewayPath: "/api"` + `public: true`；入口是 `scf_bootstrap`（导出 `PORT=9000` 后 `exec node dist/main`），HTTP 函数必须监听 9000
4. 云函数默认 5 秒超时会砍断 SSE，配置中已设为 300 秒；一次 SSE 连接占用一个函数实例
5. **`CORS_ORIGINS` 保持为空**：跨域响应头统一由网关「安全域名」注入。在这里填前端域名会导致 NestJS 与网关各加一份 `Access-Control-Allow-Origin`，浏览器因“多个值只允许一个”直接拦截

### 前端访问地址

`frontend/src/client.ts` 顶部的 `BASE` 写死后端网关地址（跨域部署不能依赖相对路径）：

```ts
const BASE = 'https://<envId>.service.tcloudbase.com/api'
```

换环境时改这一行并重新构建前端。

### 部署命令

```bash
npm run build                                   # 必须先构建：ignore 排除了 src，包内需要 dist/
tcb fn deploy api --force --yes                  # 部署 HTTP 云函数（读 cloudbaserc.json）
tcb hosting deploy frontend/dist / -e <envId>    # 前端产物上传到托管桶根目录（第二个参数“/”不能省）
```

### 控制台关键配置

- **HTTP 网关 · 路径透传**：后端控制器自带 `/api` 前缀，网关不能剥掉。`/api` 路由关联的**每条域名**（通配 `*` 与环境专属域名）都要设 `enablePathTransmission: true`，否则所有请求 404。CLI：`tcb routes list`、`tcb routes edit`
- **安全域名（网关级 CORS）**：把前端托管域名 `https://<envId>-<appid>.tcloudbaseapp.com` 加入白名单（`tcb cors list`）。网关会自动注入 CORS 头并直接应答 `OPTIONS` 预检（204），不拉起函数实例
- **静态托管**：错误页面设为 `index.html`（SPA 回退，深链接刷新不 404）；带 hash 的 CSS/JS 约 7 天缓存、`index.html` 约 1 小时，发布后本地要 Ctrl+F5
- **不要与云应用 WebApps 混淆**：`tcb hosting deploy` 只写托管桶，**不会产生“应用/部署记录”**（用 `tcb hosting list /` 查看文件）；控制台里带“部署版本/部署记录”、域名是 `*.webapps.tcloudbase.com` 的是另一个产品，本项目不用

### 上线验收

```bash
curl https://<envId>.service.tcloudbase.com/api/health    # 200：database: up / encryption: enabled / promptVersion 为当前提示词版本
curl https://<envId>.service.tcloudbase.com/api/config    # 200 {"configured": ...}
curl -X POST https://<envId>.service.tcloudbase.com/api/chat -H "Content-Type: application/json" --data @body.json   # 未配 Key 时是 400 友好提示，不是 404
curl -X POST https://<envId>.service.tcloudbase.com/api/conversations/<id>/truncate -H "Content-Type: application/json" --data "{\"fromTimestamp\":1}"
```

- `encryption: disabled` 说明 `ENCRYPTION_KEY` 注入失败，保存 API Key 会返回 400
- 浏览器 Network 里 `Access-Control-Allow-Origin` 只能有**一个值**（出现逗号拼两份就是 CORS 双重注入）
- 函数刚重新部署后的首个请求可能因冷启动瞬时 404/超时，硬刷新重试即可

### 已知局限（sqljs 演示模式）

`/tmp` 是**每个云函数实例私有**且冷启动即清空，而 CloudBase 会按需并发拉起多个实例并按客户端连接做粘性路由。因此：

- A 实例建了对话、B 实例没有，chat 曾返回 404「对话不存在」。后端已加 `ConversationsService.ensureExists()`：配置校验通过后若对话缺失就用前端传的 id 补建，消除 404。
- 但 **config 与历史消息仍不共享**，可能随机出现“刚配好又提示未配置”、“历史时多时少”。
- 限流计数存在进程内存，实际放行量约为 `THROTTLE_LIMIT × 实例数`，需靠网关限频兜底。

要稳定对外，把 `DB_TYPE` 改为 `postgres` 并填齐 `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE`（VPC 内网地址）后重新部署，所有实例共享一份库即可根治。

## 开发说明

- 后端使用 `nest start --watch` 热重载，修改 functions/api/src 下文件自动重启
- 前端 Vite HMR 即时更新；修改 `frontend/vite.config.ts` 需重启前端
- 本地 SQLite 数据库文件位于 `functions/api/data/app.db`，首次启动自动创建表结构（synchronize: true）
- API Key 以密文落库（前缀 `gcm1:`），接口只返回脱敏值 `apiKeyMasked`，明文仅在调用上游时内存中存在
- 改了后端 `src` 必须 `npm run build:api` 再 `tcb fn deploy`：`ignore` 排除了 `src` 与 `evals`，云端跑的是包内 `dist/`（仅在明确要求时才发布）
- 改提示词要同时升 `PROMPT_VERSION` 并跑 `npm run eval`，否则版本不一致会直接判失败；仅注释/空白调整不必升版本
- 上下文窗口、工具并发、摘要开关分别由 `CONTEXT_TOKEN_BUDGET`、`AGENT_TOOL_CONCURRENCY`、`CONTEXT_SUMMARY_ENABLED` 控制，见 `functions/api/.env.example` 与 `cloudbaserc.json`
