# AI 聊天助手

前端 React 19 + TypeScript + Vite + Tailwind 4，后端 NestJS 11 + TypeORM 0.3（本地 sql.js/SQLite，云端可切 PostgreSQL），
上游 DeepSeek（兼容 OpenAI Chat Completions，含 tools），部署在腾讯云 CloudBase（静态托管 + HTTP 云函数）。
选型理由见 `TECH_DESIGN.md`「技术选型」。

## 功能特性

- 多用户账号：注册/登录后才进入聊天界面，API Key 与对话记录按账号隔离
- 免登录演示模式：`AUTH_ENABLED` 未设为 `true` 时跳过登录页，直接以既有账号身份使用（默认即此状态，详见「首次配置」）
- 流式输出：AI 回答逐字显示（SSE），工具调用步骤也在气泡内实时更新
- 多轮上下文：自动携带历史消息，超出 token 预算时滑窗裁剪 + 旧轮次滚动摘要
- 会话管理：创建/切换/删除；最后一轮可「重新生成」，历史提问可「编辑重发」
- Agent 工具：内置时间查询、精确计算、网页抓取三类工具，模型自主决策调用（能力边界见 `AGENT_CAPABILITIES.md`）
- 后台长任务：任务表、队列语义（租约/退避/重试/幂等）与 REST 接口已就绪，前端有「后台任务」面板；**执行器进程尚未部署**，所以默认关闭，此状态下提交的任务只会停在排队（详见「已知局限」）
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

登录方式由后端环境变量 `AUTH_ENABLED` 决定，**缺省即免登录**，本地 clone 下来不用配任何东西：

- `AUTH_ENABLED` 未设置或非 `true`（默认）：打开页面直接进主界面，顶栏显示当前身份并标注「免登录」，没有退出登录按钮。身份取库里**最早创建的那个账号**，所以它名下已保存的 API Key 与历史对话原样可见；空库时自动建一个 `demo` 账号（随机口令，真实登录永远进不来）并认领无主数据。
- `AUTH_ENABLED=true`：进入登录页，需注册/登录后才能使用。注册、登录、会话 token、401 过期回收这条链路一直保留着，切回真实登录只改变量、不改代码。

配好登录方式后：

1. 账号没有保存过 API Key 时，会自动弹出「大模型 API 设置」
2. 填入 DeepSeek API Key（从 https://platform.deepseek.com 获取），模型名与 Base URL 用默认值即可
3. 点击"保存并应用"，Key 经 AES-256-GCM 加密后写入后端数据库，并归属当前账号
4. 即可开始对话；下次打开同一账号会直接带出已保存的 Key，无需重新填写

> 主密钥 `ENCRYPTION_KEY`（64 位十六进制）缺失或格式非法时，保存会返回明确错误——为避免明文落库，后端不会降级成明文存储。
> 引入登录之前生成的对话与大模型配置没有归属，第一个注册的账号（或免登录时自动创建的 `demo`）会自动认领它们，之后各账号互相看不到。
> 免登录下所有访问者共用同一个身份，公开域名前先读「已知局限（免登录演示模式）」。

## 项目结构

```
ai-chat/
├── frontend/                   # 前端（Vite + React），产物 frontend/dist
│   ├── src/
│   │   ├── App.tsx             # 根组件：登录态与会话状态管理
│   │   ├── client.ts           # 后端 API 调用层（token / SSE）
│   │   ├── apiConfig.ts        # 供应商预设 & 表单校验
│   │   ├── types.ts            # TypeScript 类型定义
│   │   └── components/         # AuthView / ChatInterface / ApiConfigModal / TaskPanel
│   ├── vite.config.ts          # /api proxy → :3001
│   └── .env.production         # VITE_API_BASE（跨域部署用）
├── functions/
│   └── api/                    # 接口云函数（函数名：api，type: HTTP）
│       ├── src/
│       │   ├── main.ts         # 启动入口（本地 :3001）
│       │   ├── app.module.ts   # 根模块（TypeORM 配置 + 全局守卫）
│       │   ├── auth/           # 注册/登录、scrypt 散列、Bearer 会话守卫、AUTH_ENABLED 免登录模式
│       │   ├── config/         # API 配置 CRUD（加密落库 / 明文迁移）
│       │   ├── conversations/  # 对话 & 消息实体/服务
│       │   ├── chat/           # SSE 代理 + Agent 多轮循环 + 上下文裁剪/摘要 + 提示词版本
│       │   ├── agent/          # 工具注册表（schema + 校验 + 执行）+ 并发执行器
│       │   ├── tasks/          # 后台任务：实体、队列策略、类型注册表、REST 接口（不含执行器）
│       │   ├── security/       # AES-256-GCM 加解密、URL 内网拦截
│       │   └── health/         # 探活接口（含 promptVersion / auth / background 水位）
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
npm run eval                                       # 离线：46 项断言（19 条工具用例 + 提示词/上下文/并发/队列/鉴权模式不变量），不需要网络与 API Key
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
7. **`BACKGROUND_TASKS_ENABLED` 保持 `false`**，直到后台执行器（独立常驻进程）真的部署起来。设为 `true` 会把 `run_in_background` 广播给模型，模型随即开始提交没人执行的任务——队列只会堆积，界面永远显示「排队中」。全部可调变量的默认值与含义见 `functions/api/.env.example`
8. **`AUTH_ENABLED` 在 `cloudbaserc.json` 里显式写为 `false`**，发布上去直接就是免登录演示站：访客不用注册，进页面即用。这是有意选择而不是漏配，但它把域名变成了公共资源——任何人都能调 `/api/chat` 花掉你的大模型配额、`/api/config` 读写那份配置（Key 本身只回掩码，不回明文），全站数据共用同一账号，只剩 `THROTTLE_TTL/THROTTLE_LIMIT` 这一层 IP 限流。要按人隔离就把它改成 `true` 重新部署，登录页和账号隔离会原样回来。

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
curl https://<envId>.service.tcloudbase.com/api/health    # 200：database: up / encryption: enabled / auth: 当前登录模式 / promptVersion 为当前提示词版本
curl https://<envId>.service.tcloudbase.com/api/auth/mode # 免登录发布时 {"authEnabled":false,"user":{...}}，访客进页面即拿到身份
curl https://<envId>.service.tcloudbase.com/api/config    # 200 {"configured": ...}
curl -X POST https://<envId>.service.tcloudbase.com/api/chat -H "Content-Type: application/json" --data @body.json   # 未配 Key 时是 400 友好提示，不是 404
curl -X POST https://<envId>.service.tcloudbase.com/api/conversations/<id>/truncate -H "Content-Type: application/json" --data "{\"fromTimestamp\":1}"
curl https://<envId>.service.tcloudbase.com/api/tasks -H "Authorization: Bearer <token>"   # 带 token 应返回 {"items":[],"counts":{...},"runnerEnabled":false}
```

- `encryption: disabled` 说明 `ENCRYPTION_KEY` 注入失败，保存 API Key 会返回 400
- `health` 里的 `auth` 表示登录模式：`disabled` 是免登录，`/api/tasks` 这类接口不带 token 也会返回 200 而**不是**鉴权失效的 bug；把它设成 `AUTH_ENABLED=true` 重新部署后，不带 token 应回到 401
- `health` 里的 `background` 表示后台任务开关，`tasks` 是排队/执行中的水位；`background: disabled` 而 `queued` 在涨，就说明任务正无人执行地堆积
- 浏览器 Network 里 `Access-Control-Allow-Origin` 只能有**一个值**（出现逗号拼两份就是 CORS 双重注入）
- 函数刚重新部署后的首个请求可能因冷启动瞬时 404/超时，硬刷新重试即可

### 已知局限（sqljs 演示模式）

`/tmp` 是**每个云函数实例私有**且冷启动即清空，而 CloudBase 会按需并发拉起多个实例并按客户端连接做粘性路由。因此：

- A 实例建了对话、B 实例没有，chat 曾返回 404「对话不存在」。后端已加 `ConversationsService.ensureExists()`：配置校验通过后若对话缺失就用前端传的 id 补建，消除 404。
- 但 **config 与历史消息仍不共享**，可能随机出现“刚配好又提示未配置”、“历史时多时少”。
- 限流计数存在进程内存，实际放行量约为 `THROTTLE_LIMIT × 实例数`，需靠网关限频兜底。

要稳定对外，把 `DB_TYPE` 改为 `postgres` 并填齐 `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE`（VPC 内网地址）后重新部署，所有实例共享一份库即可根治。

### 已知局限（免登录演示模式）

`AUTH_ENABLED=false` 时全站只有一个身份，后端把它绑定到**最早创建的账号**上。这不是过渡状态，而是设计上的取舍：

- **所有人共用一个账号**：访客之间共享同一份大模型配置与同一批会话记录，甲能翻到乙刚聊的内容。演示站可以接受，当成私人助理用不行。
- **配额与 Key 是公共资源**：`/api/chat` 对任何能访问域名的人开放，花的是配置里那把 Key 的余额；`/api/config` 也能被任意访客改写（返回值只有掩码，明文 Key 不会外泄，但可以被人替换成他自己的或清空）。防线只剩 `THROTTLE_TTL`/`THROTTLE_LIMIT` 的按 IP 限流，且云函数多实例会让实际放行量约为 `LIMIT × 实例数`。
- **免登录不等于关掉登录**：`/api/auth/register`、`/login` 仍然挂着，注册出来的账号在免登录模式下不会被自动选中——身份永远是那个最早创建的。真要按人隔离就设 `AUTH_ENABLED=true`。
- **实例重启后身份可能漂移**：sqljs 的 `/tmp/app.db` 冷启动即清空，届时兜底建的 `demo` 会成为「最早账号」，之前本地看到的数据不会回来。数据要稳，见上一节切 PostgreSQL。

### 已知局限（后台任务）

- **没有执行器**。HTTP 云函数按请求拉起、响应结束即回收，跑不了长任务，所以本分支只交付队列与接口：`tasks` 表、领取/租约/退避/重试/幂等语义、REST 接口、前端面板，以及默认关闭的 `run_in_background`。
- 因此现在提交的任务只会停在 `queued`，前端面板据此显示「执行器未启用」。要真正跑起来，需要一个常驻进程按 `TaskService.claimNext()` 领取并执行（设计见 `TECH_DESIGN.md`「后台任务队列」）。
- 本地 `data/app.db` 里出现空 `tasks` 表是正常的：`synchronize` 会随实体新增建表，不影响既有数据。

## 开发说明

- 后端使用 `nest start --watch` 热重载，修改 functions/api/src 下文件自动重启
- 前端 Vite HMR 即时更新；修改 `frontend/vite.config.ts` 需重启前端
- 本地 SQLite 数据库文件位于 `functions/api/data/app.db`，首次启动自动创建表结构（synchronize: true）
- 改了后端 `src` 必须 `npm run build:api` 再 `tcb fn deploy`：`ignore` 排除了 `src` 与 `evals`，云端跑的是包内 `dist/`（仅在明确要求时才发布）
- 改提示词要同时升 `PROMPT_VERSION` 并跑 `npm run eval`，否则版本不一致会直接判失败；仅注释/空白调整不必升版本
- Agent 相关的可调参数（上下文预算、工具并发、摘要开关、抓取超时）见 `AGENT_CAPABILITIES.md`「可调参数」，完整清单在 `functions/api/.env.example`
