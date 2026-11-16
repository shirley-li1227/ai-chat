# AI 聊天助手（演示分支 demo-stateless）

前端 React 19 + TypeScript + Vite + Tailwind 4，后端 NestJS 11，上游 DeepSeek（兼容 OpenAI Chat Completions，含 tools）。

本分支只演示 Agent 部分：**后端无状态、不连数据库**。注册登录、API Key 配置弹窗、对话落库全部去掉，
历史消息与工具轨迹存在浏览器 IndexedDB，每轮随请求上报给后端。
多用户 + 持久化的完整版本在 `main`；本文下方「云端部署」等章节仍以 main 的形态描述，涉及本分支差异处会单独标注。

## 功能特性

- 流式输出：AI 回答逐字显示（SSE），工具调用步骤也在气泡内实时更新
- Agent 工具：内置时间查询、精确计算、网页抓取三类工具，模型自主决策调用（能力边界见 `AGENT_CAPABILITIES.md`）
- 多轮上下文：历史由客户端上报，后端按 token 预算滑窗裁剪；没有地方存滚动摘要，超窗的旧轮次直接退出上下文
- 会话管理：创建/切换/删除；最后一轮可「重新生成」，历史提问可「编辑重发」，全部写本地 IndexedDB
- Markdown 渲染：支持 GFM 表格、任务列表、代码高亮
- 密钥不进浏览器：API Key 只存在于后端环境变量，接口不回传，前端也没有填写入口

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

本分支没有注册/登录，也不需要填 Key，只需告诉后端用哪个模型：

1. 在 `functions/api/.env` 写入（该文件已被 gitignore 排除）：
   ```bash
   LLM_API_KEY=sk-...          # 必填，缺失时发送消息会返回 400 提示
   LLM_BASE_URL=https://api.deepseek.com/v1   # 可省略
   LLM_MODEL=deepseek-chat                    # 可省略
   LLM_PROVIDER=DeepSeek                      # 仅用于错误提示里的供应商名，可省略
   ```
2. 重启后端，`curl http://localhost:3001/api/health` 应返回 `"llm":"configured"`
3. 打开 `http://localhost:5173` 直接对话；对话记录留在本机浏览器里，换浏览器/清缓存即清空

> 环境变量优先级：进程环境变量 > `functions/api/.env`。`DB_*`、`ENCRYPTION_KEY` 在本分支完全无用，留着也不生效。

## 项目结构

```
ai-chat/
├── frontend/                   # 前端（Vite + React），产物 frontend/dist
│   ├── src/
│   │   ├── App.tsx             # 根组件：会话状态与发送流程（本分支不再管登录态）
│   │   ├── client.ts           # 后端调用层：上报历史 + SSE 解析
│   │   ├── storage.ts          # IndexedDB 会话存储（本分支唯一的持久层）
│   │   ├── types.ts            # TypeScript 类型定义
│   │   └── components/         # ChatInterface（无登录页、无 API 配置弹窗）
│   ├── vite.config.ts          # /api proxy → :3001
│   └── .env.production         # VITE_API_BASE（跨域部署用）
├── functions/
│   └── api/                    # 接口云函数（函数名：api，type: HTTP）
│       ├── src/
│       │   ├── main.ts         # 启动入口（本地 :3001）
│       │   ├── app.module.ts   # 根模块（只剩限流 + chat + health，无 TypeORM）
│       │   ├── chat/           # SSE 代理 + Agent 多轮循环 + 上下文裁剪 + 环境变量配置
│       │   ├── agent/          # 工具定义与执行 + 并发执行器
│       │   ├── security/       # URL 内网拦截（SSRF）
│       │   └── health/         # 探活接口（上报 llm 与 promptVersion）
│       ├── evals/              # 提示词/工具回归集（不随函数包上传）
│       ├── dist/               # 构建产物，云函数实际执行的代码
│       ├── scf_bootstrap       # HTTP 云函数启动入口（LF，监听 9000）
│       └── package.json
├── cloudbaserc.json            # CloudBase 部署配置（functionRoot: ./functions）
├── package.json                # 仓库根编排脚本（install:all / dev / build）
├── PRD.md                      # 产品需求与实现对照
├── TECH_DESIGN.md              # 技术设计（描述 main 的多用户形态）
├── AGENT_CAPABILITIES.md       # 智能体能力清单
└── AGENTS.md                   # AI 辅助开发指令
```

> 入口为什么是 `scf_bootstrap`：CloudBase 官方示例常用 `functions/api/index.js`（事件函数），但事件函数无法流式回包，
> 所以 `api` 声明为 `type: HTTP` 自定义运行时，由 `scf_bootstrap` 导出 `PORT=9000` 后执行 `node dist/main`。

## 数据流

```
浏览器（IndexedDB 存全部会话）── /api/chat（本地同源走 Vite 代理；云端跨域直调函数网关）
  │  body: { content, messages: [{ role, content, toolCalls? }] }
  ▼
NestJS（无状态，不连数据库）── HTTPS + SSE（stream: true, tools）
  ▼
DeepSeek API
```

一次请求的处理顺序：按 token 预算裁剪上报历史 → 展开工具轨迹为 `assistant(tool_calls)` + `tool` 消息 → 注入 system prompt → 多轮工具循环 → 透传 `content` / `tool` 事件 → 前端自己把这一轮写回 IndexedDB。
云端逐跳链路（网关路径透传、安全域名）见 `TECH_DESIGN.md`「云端部署架构」，其中的数据层切换只适用于 `main`。

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
- 本分支**没有数据层**：不连 PostgreSQL、不写 `/tmp/app.db`，`DB_*` 与 `ENCRYPTION_KEY` 都不用配；唯一必需的是函数环境变量里的 `LLM_API_KEY`

### 部署配置

1. 仓库根创建 `.env.local`（已被 .gitignore 忽略），写入：
   ```bash
   LLM_API_KEY=<大模型 API Key，函数运行时唯一需要的密钥>
   ```
   `{{env.LLM_API_KEY}}` 由 CLI 在部署时从根目录 `.env.local` 插值进函数环境变量。
2. `cloudbaserc.json`（v2.1 schema）关键点：`envId`、`functionRoot: "./functions"`；函数不写 `dir`，由 `functionRoot/name` 推导为 `functions/api`（v2.1 中 `dir` 是相对项目根目录而非 functionRoot）。`envVariables` 已去掉全部 `DB_*`/`ENCRYPTION_KEY`，只留 `LLM_API_KEY` 与 Agent 调参
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
- **安全域名（网关级 CORS）**：把前端托管域名 `https://<envId>-<appid>.tcloudbaseapp.com` 加入白名单（`tcb cors list`）。网关会自动注入 CORS 头并直接应答 `OPTIONS` 预检（204），不拉起函数实例。本分支请求不带 `Authorization`，但请求体是 JSON，预检仍会检查 `Content-Type` 是否放行
- **静态托管**：错误页面设为 `index.html`（SPA 回退，深链接刷新不 404）；带 hash 的 CSS/JS 约 7 天缓存、`index.html` 约 1 小时，发布后本地要 Ctrl+F5
- **不要与云应用 WebApps 混淆**：`tcb hosting deploy` 只写托管桶，**不会产生“应用/部署记录”**（用 `tcb hosting list /` 查看文件）；控制台里带“部署版本/部署记录”、域名是 `*.webapps.tcloudbase.com` 的是另一个产品，本项目不用

### 上线验收

```bash
curl https://<envId>.service.tcloudbase.com/api/health    # 200：llm: configured / promptVersion 为当前提示词版本
curl -X POST https://<envId>.service.tcloudbase.com/api/chat -H "Content-Type: application/json" \
  --data '{"content":"现在几点","messages":[]}'           # 未配 Key 时是 400 友好提示，不是 404
```

- `llm: missing` 说明 `LLM_API_KEY` 没插值进函数环境变量，此时发消息一律 400
- 浏览器 Network 里 `Access-Control-Allow-Origin` 只能有**一个值**（出现逗号拼两份就是 CORS 双重注入）
- 函数刚重新部署后的首个请求可能因冷启动瞬时 404/超时，硬刷新重试即可

### 已知局限（演示模式）

- **历史只活在浏览器**：换设备、换浏览器、清站点数据即归零；`functions/api/data/app.db` 在本分支不再被读写。
- **接口无鉴权**：`/api/chat` 谁都能调，而它花的是你 `LLM_API_KEY` 的额度。进程内存里的 `THROTTLE_LIMIT` 只对单实例有效，实际放行量约为 `limit × 实例数`，对外演示必须在网关再配一层限频，或只把链接发给可信的人。
- **旧轮次没有摘要可回**：超出 `CONTEXT_TOKEN_BUDGET` 的更早内容直接退出上下文，模型会忘记开头聊过什么。

## 开发说明

- 后端使用 `nest start --watch` 热重载，修改 functions/api/src 下文件自动重启
- 前端 Vite HMR 即时更新；修改 `frontend/vite.config.ts` 需重启前端
- 会话数据在浏览器 IndexedDB 库 `ai-chat-demo` 的 `conversations` 对象仓库里；要清空演示记录，DevTools → Application → IndexedDB 删除即可
- 改了后端 `src` 必须 `npm run build:api` 再 `tcb fn deploy`：`ignore` 排除了 `src` 与 `evals`，云端跑的是包内 `dist/`（仅在明确要求时才发布）
- 改提示词要同时升 `PROMPT_VERSION` 并跑 `npm run eval`，否则版本不一致会直接判失败；仅注释/空白调整不必升版本
- Agent 相关的可调参数（上下文预算、工具并发、抓取超时）见 `AGENT_CAPABILITIES.md`「可调参数」；本分支不再有摘要开关与数据库相关变量
