# AI 聊天助手

前端 React 19 + TypeScript + Vite + Tailwind 4，后端 NestJS 11 + TypeORM 0.3（本地 sql.js/SQLite，云端可切 PostgreSQL），
上游 DeepSeek（兼容 OpenAI Chat Completions，含 tools），部署在腾讯云 CloudBase（静态托管 + HTTP 云函数）。
选型理由见 `TECH_DESIGN.md`「技术选型」。

## 功能特性

- 多用户账号：注册/登录后才进入聊天界面，API Key 与对话记录按账号隔离
- 流式输出：AI 回答逐字显示（SSE），工具调用步骤也在气泡内实时更新
- 多轮上下文：自动携带历史消息，超出 token 预算时滑窗裁剪 + 旧轮次滚动摘要
- 会话管理：创建/切换/删除；最后一轮可「重新生成」，历史提问可「编辑重发」
- Agent 工具：内置时间查询、精确计算、网页抓取三类工具，模型自主决策调用（能力边界见 `AGENT_CAPABILITIES.md`）
- Markdown 渲染：支持 GFM 表格、任务列表、代码高亮
- API 配置弹窗：运行时填写大模型 API Key，无需重启；下次登录同一账号直接带出
- 后端持久化：对话历史与配置落库（本地 sql.js/SQLite，云端可切 PostgreSQL）
- 安全设计：API Key 仅存后端，AES-256-GCM 加密后落库，接口只返回脱敏值

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

1. 打开页面先进入登录页，切到「注册」标签建一个账号（注册成功即自动登录）
2. 登录账号没有保存过 API Key 时，会自动弹出「大模型 API 设置」
3. 填入 DeepSeek API Key（从 https://platform.deepseek.com 获取），模型名与 Base URL 用默认值即可
4. 点击"保存并应用"，Key 经 AES-256-GCM 加密后写入后端数据库，并归属当前账号
5. 即可开始对话；下次登录同一账号会直接带出已保存的 Key，无需重新填写

> 主密钥 `ENCRYPTION_KEY`（64 位十六进制）缺失或格式非法时，保存会返回明确错误——为避免明文落库，后端不会降级成明文存储。
> 引入登录之前生成的对话与大模型配置没有归属，第一个注册的账号会自动认领它们，之后各账号互相看不到。

## 项目结构

```
ai-chat/
├── frontend/                   # 前端（Vite + React），产物 frontend/dist
│   ├── src/
│   │   ├── App.tsx             # 根组件：登录态与会话状态管理
│   │   ├── client.ts           # 后端 API 调用层（token / SSE）
│   │   ├── apiConfig.ts        # 供应商预设 & 表单校验
│   │   ├── types.ts            # TypeScript 类型定义
│   │   └── components/         # AuthView / ChatInterface / ApiConfigModal
│   ├── vite.config.ts          # /api proxy → :3001
│   └── .env.production         # VITE_API_BASE（跨域部署用）
├── functions/
│   └── api/                    # 接口云函数（函数名：api，type: HTTP）
│       ├── src/
│       │   ├── main.ts         # 启动入口（本地 :3001）
│       │   ├── app.module.ts   # 根模块（TypeORM 配置 + 全局守卫）
│       │   ├── auth/           # 注册/登录、scrypt 散列、Bearer 会话守卫
│       │   ├── config/         # API 配置 CRUD（加密落库 / 明文迁移）
│       │   ├── conversations/  # 对话 & 消息实体/服务
│       │   ├── chat/           # SSE 代理 + Agent 多轮循环 + 上下文裁剪/摘要 + 提示词版本
│       │   ├── agent/          # 工具定义与执行 + 并发执行器
│       │   ├── security/       # AES-256-GCM 加解密、URL 内网拦截
│       │   └── health/         # 探活接口（含 promptVersion）
│       ├── evals/              # 提示词/工具回归集（不随函数包上传）
│       ├── dist/               # 构建产物，云函数实际执行的代码
│       ├── data/               # SQLite 数据库文件（仅本地，自动创建）
│       ├── scf_bootstrap       # HTTP 云函数启动入口（LF，监听 9000）
│       └── package.json
├── cloudbaserc.json            # CloudBase 部署配置（functionRoot: ./functions）
├── package.json                # 仓库根编排脚本（install:all / dev / build）
├── PRD.md                      # 产品需求与实现对照
├── TECH_DESIGN.md              # 技术设计（架构 / 数据模型 / 接口 / 设计取舍）
├── AGENT_CAPABILITIES.md       # 智能体能力清单
└── AGENTS.md                   # AI 辅助开发指令
```

> 入口为什么是 `scf_bootstrap`：CloudBase 官方示例常用 `functions/api/index.js`（事件函数），但事件函数无法流式回包，
> 所以 `api` 声明为 `type: HTTP` 自定义运行时，由 `scf_bootstrap` 导出 `PORT=9000` 后执行 `node dist/main`。

## 数据流

```
浏览器 ── /api/*（本地同源走 Vite 代理；云端跨域直调函数网关）
  ▼
NestJS ── TypeORM（本地 functions/api/data/app.db；云端 sqljs 或 PostgreSQL）
  │  HTTPS + SSE（stream: true, tools）
  ▼
DeepSeek API
```

一次请求的处理顺序：存 user message → 按 token 预算裁剪历史（滑出的旧轮次进滚动摘要）→ 注入 system prompt → 多轮工具循环 → 透传 `content` / `tool` 事件 → 存 assistant message。
云端逐跳链路（网关路径透传、安全域名、数据层切换）见 `TECH_DESIGN.md`「云端部署架构」。

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
npm run eval                                       # 离线：22 条用例 + 结构不变量，不需要网络与 API Key
$env:EVAL_API_KEY="sk-..."; npm run eval:online    # 在线：真实调模型测工具选择命中率，会消耗 token
npm run eval:online -- --min-accuracy=0.9          # 卡命中率下限，低于阈值退出码非 0
```

用例覆盖范围、`PROMPT_VERSION` 与用例版本互相钉死的机制见 `TECH_DESIGN.md`「提示词版本化与回归评测」。

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
- 数据层二选一：**演示**用 `DB_TYPE=sqljs` + `DB_LOCATION=/tmp/app.db`（零外部依赖，代价见「已知局限」）；**正式**用 `DB_TYPE=postgres`，云函数需开启 VPC 并与数据库同 VPC/子网

### 部署配置

1. 仓库根创建 `.env.local`（已被 .gitignore 忽略），写入：
   ```bash
   ENCRYPTION_KEY=<主密钥，64 位十六进制，用于加密落库的 API Key>
   DB_PASSWORD=<PostgreSQL 密码，仅 DB_TYPE=postgres 时需要>
   ```
   `{{env.XXX}}` 由 CLI 在部署时从根目录 `.env.local` 插值进函数环境变量。
2. `cloudbaserc.json`（v2.1 schema）关键点：`envId`、`functionRoot: "./functions"`；函数不写 `dir`，由 `functionRoot/name` 推导为 `functions/api`（v2.1 中 `dir` 是相对项目根目录而非 functionRoot）。切 PostgreSQL 时只需补齐 `DB_HOST`、`DB_USERNAME` 为内网连接信息
3. 函数声明为 `type: HTTP` + `runtime: Nodejs20.19` + `gatewayPath: "/api"` + `public: true`；HTTP 函数必须监听 9000
4. 云函数默认 5 秒超时会砍断 SSE，配置中已设为 300 秒；一次 SSE 连接占用一个函数实例
5. **`CORS_ORIGINS` 保持为空**：跨域响应头统一由网关「安全域名」注入。在这里填前端域名会导致 NestJS 与网关各加一份 `Access-Control-Allow-Origin`，浏览器因“多个值只允许一个”直接拦截
6. `frontend/.env.production` 写后端绝对地址（本地开发留空走 `/api` 代理），换环境时改这里并重新构建前端：
   ```bash
   VITE_API_BASE=https://<envId>.service.tcloudbase.com/api
   ```

### 部署命令

```bash
npm run build                                   # 必须先构建：ignore 排除了 src，包内需要 dist/
tcb fn deploy api --force --yes                  # 部署 HTTP 云函数（读 cloudbaserc.json）
tcb hosting deploy frontend/dist / -e <envId>    # 前端产物上传到托管桶根目录（第二个参数“/”不能省）
```

### 控制台关键配置

- **HTTP 网关 · 路径透传**：后端控制器自带 `/api` 前缀，网关不能剥掉。`/api` 路由关联的**每条域名**（通配 `*` 与环境专属域名）都要设 `enablePathTransmission: true`，否则所有请求 404。CLI：`tcb routes list`、`tcb routes edit`
- **安全域名（网关级 CORS）**：把前端托管域名 `https://<envId>-<appid>.tcloudbaseapp.com` 加入白名单（`tcb cors list`）。网关会自动注入 CORS 头并直接应答 `OPTIONS` 预检（204），不拉起函数实例。业务请求都带 `Authorization`，白名单必须放行该请求头，否则登录成功后的接口仍会在浏览器侧被拦下
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
- 改了后端 `src` 必须 `npm run build:api` 再 `tcb fn deploy`：`ignore` 排除了 `src` 与 `evals`，云端跑的是包内 `dist/`（仅在明确要求时才发布）
- 改提示词要同时升 `PROMPT_VERSION` 并跑 `npm run eval`，否则版本不一致会直接判失败；仅注释/空白调整不必升版本
- Agent 相关的可调参数（上下文预算、工具并发、摘要开关、抓取超时）见 `AGENT_CAPABILITIES.md`「可调参数」，完整清单在 `functions/api/.env.example`
