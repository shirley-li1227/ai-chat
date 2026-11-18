# AI 聊天助手

前端 React 19 + TypeScript + Vite + Tailwind 4，后端 NestJS 11 + TypeORM 0.3（本地 sql.js/SQLite，云端可切 PostgreSQL），
上游 DeepSeek（兼容 OpenAI Chat Completions，含 tools），部署在腾讯云 CloudBase（静态托管 + HTTP 云函数）。
选型理由见 `TECH_DESIGN.md`「技术选型」。

## 功能特性

- 多用户账号：注册/登录后才进入聊天界面，API Key 与对话记录按账号隔离
- 免登录演示模式：`AUTH_ENABLED` 未设为 `true` 时跳过登录页，直接以既有账号身份使用（默认即此状态，详见「首次配置」）
- 流式输出：AI 回答逐字显示（SSE）；工具调用步骤也在气泡内实时更新——抓取边下边抽，卡片上直接长出一段段正文与「已下载 x / 上限 y 字节 · 已抽 z 字」的进度行
- 断线自动续传：连接中途断掉时，已生成的半截回答照样落库；浏览器带它重连，服务端只补后半段，用户看到的仍是一条完整回答（详见「本地演示：断线自动续传」）
- 多轮上下文：自动携带历史消息，超出 token 预算时滑窗裁剪 + 旧轮次滚动摘要
- 跨会话长期记忆：模型判断哪些是关于你的稳定事实并自主记下（`remember`/`forget`），下次开新会话仍然带着；前端有「长期记忆」面板可查、可手写、可逐条忘掉（详见 `AGENT_CAPABILITIES.md`「跨会话长期记忆」）
- 场景化模型选择：同一供应商内按问题复杂度在几档模型之间自动换档，顶栏与每条回答都标出「刚才是哪个模型答的、为什么选它」；断线续传沿用中断那一轮的模型，不会前后半段换人（详见「场景化模型选择」）
- 会话管理：创建/切换/删除；最后一轮可「重新生成」，历史提问可「编辑重发」
- Agent 工具：3 个常驻（时间查询、精确计算、网页抓取）+ 3 个按开关注册（记长期记忆、忘掉、提交后台任务），模型自主决策调不调、调哪个、调几次；开关一翻，模型这一轮看到的能力列表跟着变（能力边界见 `AGENT_CAPABILITIES.md`）
- 后台长任务：任务表、队列语义（租约/退避/重试/幂等）与 REST 接口已就绪，前端有「后台任务」面板；**执行器进程尚未部署**，所以默认关闭，此状态下提交的任务只会停在排队（详见「已知局限」）
- Markdown 渲染：支持 GFM 表格、任务列表、代码高亮
- API 配置弹窗：运行时填写大模型 API Key，无需重启；下次登录同一账号直接带出。一个账号可以同时保存多家（DeepSeek、智谱 GLM），每家一份 Key 与档位候选，同时只有一份在用，切换不用重填密钥
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

1. 账号没有保存过任何一家的 API Key 时，会自动弹出「大模型 API 设置」
2. 填入 DeepSeek API Key（从 https://platform.deepseek.com 获取），模型名与 Base URL 用默认值即可
3. 点击「保存 DeepSeek」，Key 经 AES-256-GCM 加密后写入后端数据库，并归属当前账号；此时这份就是「当前使用」
4. 即可开始对话；下次打开同一账号会直接带出已保存的 Key，无需重新填写

想再加一家（例如智谱 GLM）时，同一个弹窗里：

1. 上方「已保存的配置」列出这个账号存过的每一家，标着「当前使用」的那份才是对话真正用的
2. 切到「智谱 GLM」标签页填 Key（形如 `id.secret` 两段）与模型名，Base URL 默认已带上 `/api/paas/v4` 路径
3. 「保存后设为当前使用」不勾就是**先存着、回头再切**；勾上才把生效位挪过来。已存过 Key 的一家把密钥框留空即表示沿用库里那把，不用为了改模型名重新粘贴密钥
4. 「模型档位候选」只填这一家确实开通的模型，从低到高逗号分隔；填了别家的名字会在保存时直接被拒并点名，因为那种请求只会换来上游 4xx，而界面上只看得见「答不上来」
5. 「删除」只删这一家的配置；删掉的正好是当前使用时，剩下最近更新的那份自动顶上，不会出现没有 Key 可用的空档

> 主密钥 `ENCRYPTION_KEY`（64 位十六进制）缺失或格式非法时，保存会返回明确错误——为避免明文落库，后端不会降级成明文存储。
> 引入登录之前生成的对话与大模型配置没有归属，第一个注册的账号（或免登录时自动创建的 `demo`）会自动认领它们，之后各账号互相看不到。
> 免登录下所有访问者共用同一个身份，公开域名前先读「已知局限（免登录演示模式）」。

### 场景化模型选择

同一供应商里的几档模型，**服务端按本轮问题的复杂度挑一档**：不新增供应商、不换协议，只在已有配置里多一个候选输入框。

- 候选档位**从低到高**填在每份配置自己的「模型档位候选」输入框（逗号分隔，如 `deepseek-flash,deepseek-v4-pro`），落库到 `api_config.routingCandidates`。这一层只在一家的模型池里挑，所以候选必须与主力模型同属一家：填了别家的 id 保存时会被拒并点名是哪一条。留空等于不开启，回答恒用配置里的主力模型，行为与开启前完全一致；环境变量 `MODEL_ROUTING_CANDIDATES` 降级为全局兜底，只在配置没填时生效。`MODEL_ROUTING_ENABLED=false` 是总开关，用于对比测试或排障。
- 模型名不写死在代码里：供应商的 id 会换，用户也未必开通了高那一档。配什么用什么，白名单外的名字永远不会被选中。
- 判定用的是确定可得的信号——问题长度，加上「要求深入 / 分析设计类 / 含代码 / 格式要求」四类关键词，加权成 0~1 的复杂度分，再按候选数线性分档。刻意不让模型自己「换个模型再答一遍」：那要多一跳工具调用、双份 token、还会白吃掉 `AGENT_MAX_TURNS` 的轮数预算。
- 界面解释得清：每轮 SSE 开头下发一条 `model` 事件（模型 id、复杂度分、中文理由），顶栏显示最近一条回答实际用的模型，气泡下方标出该条的模型名，悬停看理由。assistant 消息也落库 `model`，刷新后仍知道是谁答的。
- **续传不换模型**：中断那轮用的档位随半截回答一起落库，`/api/chat/resume` 优先沿用它（前提是该模型还在候选白名单里）。否则前后半段风格断裂甚至自相矛盾，而浏览器手上只有文本，看不出问题出在模型换了。

> 这层只换「用哪个文本模型答」，不会因此获得图像理解能力——那需要供应商本身支持 `image_url`，属于另一件事。

### 本地演示：断线自动续传

这条链路只在本地演：它需要一个「故意把流掐断」的假上游，线上没法可控地制造断流。三个服务都跑在 `127.0.0.1`，不联网、不用真实密钥。
同一套假上游顺带也能演模型路由——它会把每次请求带的 `model` 打进日志，换档与「续传不换模型」都看得见。

1. 起一个假上游（几十行的 Node 脚本即可）：`POST /v1/chat/completions` 第一次请求吐两段就 `res.destroy()`，之后正常吐完并补 `finish_reason: stop` + `data: [DONE]`。
2. 后端指向**临时库**启动，别用 `functions/api/data/app.db`：
   `NODE_ENV=development DB_TYPE=sqljs DB_LOCATION=<临时目录>/demo.db ENCRYPTION_KEY=<64 位十六进制> AUTH_ENABLED=false MODEL_ROUTING_CANDIDATES=test-flash,test-pro PORT=3001 node dist/main.js`
   候选档位随手写两个假名字即可，假上游只认「请求里带的 model 是哪个」。这里走的是 env 兜底：播种的配置没填 `routingCandidates`，才会读到 `MODEL_ROUTING_CANDIDATES`。
3. 把配置写进那个临时库。`baseUrl` 有「必须 https」的产品级校验，本地假上游是 http，所以**不要为此放宽校验**，直接调 `ConfigService.save(userId, {...})` 播种（校验只在 DTO 层，运行时不再复查）。用户 id 从 `GET /api/auth/mode` 拿。
4. 起前端 `npm run dev`，浏览器先发一句短问候，再发一句「请仔细分析这段代码的性能问题，并给出优化方案（中途掐断一下）」。预期：前者气泡标 `test-flash`，后者标 `test-pro`；后者先逐字出现前半段，接着提示「连接中断，正在第 1/3 次自动续传…」，最后合并成一条完整回答并显示「网络曾中断，回答已从断点续写完成。」，模型标记不变。
5. 核对落库：`GET /api/conversations/:id` 应该只有一条 user + 一条 assistant，assistant 内容是完整回答且 `model` 仍是 `test-pro`；假上游日志应该恰好两次请求，两次的 `model` 相同。

> 关键实现约束：断线检测挂在 **`res` 的 `close`** 上并用 `writableEnded` 区分「正常写完」与「半路被关」。挂在 `req` 上没用——Node 在请求体读完时就发出 `req` 的 `close`，那时回答还没开始生成，控制器挂监听时事件早已过去，等于永远检测不到断线，服务端会闷头把整段跑完再落库。

### 本地演示：跨会话长期记忆与工具实时进度

这两条要真实的上游模型（假上游不会自己决定调工具），所以用你自己那把 DeepSeek Key，但**仍然别用默认库**：按上一节的办法起在临时 `.db` + 非默认端口上，否则会往 `functions/api/data/app.db` 里写演示数据、覆盖你已保存的 Key。

1. 说「记一下，我以后都要中文回答，我在做一个 NestJS 项目」→ 预期两次 `remember` 调用，工具卡片终态文案「已记住（编号 a1b2c3d4）」；顶栏「长期记忆」面板出现两条，来源徽章都是「模型记的」
2. **开一个新会话**问「你还记得我在做什么吗」→ 不复述清单、不报编号，直接按记忆作答。这一步是「跨会话」唯一的可见证据
3. 说「你之前记的偏好不对，删掉」→ 模型从注入清单里取编号调 `forget`；编号只写前 3 位也认（该账号下不唯一时会反问，不会猜着删）
4. 面板里手动补一条 → 来源徽章是「用户手写的」；点「忘掉这条」→ 清单即时减少
5. 工具进度：让它「抓取 https://1.1.1.1/cdn-cgi/trace 并总结」→ 卡片先显示阶段行「开始接收响应 → 读取正文」，正文一段段长出来，终态换成完整结果且**不会跳字**（增量与终态由同一个抽取器产出）
6. 边界：让它同时抓两个地址 → 卡片显示「2 个进行中」，两条独立进度流按 `tool_call_id` 各归各卡；抓一个不存在的页面 → 非 2xx 判失败，错误文本带状态码，模型会解释而不是总结错误页
7. 关掉：`MEMORY_ENABLED=false` 重启 → 面板顶部出现琥珀色提示条、手动新增被禁用，模型这一轮的工具清单里不再有 `remember`/`forget`（问它「记一下我喜欢什么」，它会照常回答而不是许下一个做不到的承诺）

> **本机开着 fake-IP / TUN 代理（Clash 等）时 `fetch_url` 会报「禁止访问内网地址」**：代理把域名解析成 `198.18.0.0/15`，SSRF 护栏把这一段判为内网，这是护栏在正常工作，不是 bug。演示用**字面公网 IP**（如上面那个 `1.1.1.1`）即可绕开解析这一步；不要为了让演示跑通去放宽 `url-guard.ts`。

## 项目结构

```
ai-chat/
├── frontend/                   # 前端（Vite + React），产物 frontend/dist
│   ├── src/
│   │   ├── App.tsx             # 根组件：登录态与会话状态管理
│   │   ├── client.ts           # 后端 API 调用层（token / SSE）
│   │   ├── apiConfig.ts        # 供应商预设 & 表单校验
│   │   ├── types.ts            # TypeScript 类型定义
│   │   └── components/         # AuthView / ChatInterface / ApiConfigModal / TaskPanel / MemoryPanel
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
│       │   ├── chat/           # SSE 代理 + Agent 多轮循环 + 上下文裁剪/摘要 + 模型路由 + 提示词版本 + 请求上下文组装
│       │   ├── agent/          # 工具注册表（schema + 校验 + 执行）+ 并发执行器 + HTML 流式抽取器
│       │   ├── memory/         # 跨会话长期记忆：实体、去重与注入策略（纯函数）、REST 接口
│       │   ├── tasks/          # 后台任务：实体、队列策略、类型注册表、REST 接口（不含执行器）
│       │   ├── security/       # AES-256-GCM 加解密、URL 内网拦截
│       │   └── health/         # 探活接口（含 promptVersion / auth / background / modelRouting / memory 水位）
│       ├── evals/              # 提示词/工具回归集（不随函数包上传）
│       ├── dist/               # 构建产物，云函数实际执行的代码
│       ├── data/               # SQLite 数据库文件（仅本地，自动创建）
│       ├── scf_bootstrap       # HTTP 云函数启动入口（LF，监听 9000）
│       └── package.json
├── cloudbaserc.json            # CloudBase 部署配置（functionRoot: ./functions）
├── package.json                # 仓库根编排脚本（install:all / dev / build）
├── PRD.md                      # 产品需求与实现对照
├── DEMO_CHECKLIST.md           # 线上演示清单：能演什么、怎么演、哪些演不了
├── TECH_DESIGN.md              # 技术设计（架构 / 数据模型 / 接口 / 设计取舍）
├── AGENT_CAPABILITIES.md       # 智能体能力清单
└── AGENTS.md                   # 开发指令：约束、命令、验证规矩（AI 助手与人都读这份）
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

一次请求的处理顺序：存 user message → 按 token 预算裁剪历史（滑出的旧轮次进滚动摘要）→ 取该账号的长期记忆 → 组装 `[system, memory?, summary?, ...history]`（记忆与摘要都在请求层注入，**不进会话历史**）→ 多轮工具循环 → 透传 `content` / `tool`（含 `streaming` 增量）事件 → 存 assistant message。
断线时走 `/api/chat/resume`：浏览器把已渲染的前半段原样带回，服务端撤掉中断那轮的半截记录、以它为 assistant 前缀重新请求，只推增量，最后合成一条完整回答落库。
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
npm run eval                                       # 离线：79 项断言分 12 组（提示词/工具行为/上下文/并发/注册表/后台任务/鉴权模式/断点续传/模型路由/长期记忆/工具流式/多供应商），不需要网络与 API Key
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
- 切 Postgres 后 `synchronize` 默认关闭，**改实体必须手动执行 DDL**，否则新字段/新表要到第一次写库才报错；当前待补的结构见下一节

### 生产库结构变更

生产 Postgres 关着 `synchronize` 且仓库里没有迁移目录（`migrationsRun: true` 但无迁移可跑），所以每次改实体都要手动执行 DDL。下面是**已上线实体与库结构的差额清单**，按顺序执行；已经在跑的库执行到最新一条即可。

```sql
-- 1) 断点续传：记录每轮实际作答的模型（续传据此沿用，不换模型）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model varchar(128);

-- 2) 跨会话长期记忆（user_memories 表）：整段执行
CREATE TABLE IF NOT EXISTS user_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" varchar(36) NOT NULL,
  content text NOT NULL,
  fingerprint varchar(64) NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'model',
  "conversationId" varchar(36),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "IDX_user_memories_user_updated" ON user_memories ("userId", "updatedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_memories_user_fingerprint" ON user_memories ("userId", fingerprint);

-- 3) 多供应商配置（api_config 两份新列 + 「一人一家最多一份」的复合唯一）
--    先查重再建索引：库里若已有同一账号同一供应商的两行，建唯一索引会直接失败
--    SELECT "userId", provider, count(*) FROM api_config GROUP BY 1,2 HAVING count(*) > 1;
ALTER TABLE api_config ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT false;
ALTER TABLE api_config ADD COLUMN IF NOT EXISTS "routingCandidates" varchar(512);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_api_config_user_provider" ON api_config ("userId", provider);
```

- 列名沿用实体的 camelCase 属性名（未配命名策略，Postgres 侧要带双引号），别改成 snake_case——那会让 TypeORM 找不到列
- 忘跑第 2 条的后果是可控的：读路径退化成「没有记忆」、对话照常，只有 `remember` 会失败；缺表状态直接暴露在 `GET /api/health` 的 `memoryTable: missing`，不用等用户报障
- 第 3 条不能跳：缺 `active` 或 `routingCandidates` 列时，**连读取都会挂**——TypeORM 按实体反推 SELECT 列表，`GET /api/config` 与登录后拉配置直接报「列不存在」，界面表现为「无法连接到后端服务」，缺 `routingCandidates` 同理。存量库只有一行且没有 `active=true`，读路径本来就会退回最近一条，所以补完列不用回填数据；`active` 的「同时只有一份生效」由服务层在一个事务里保证，库里没有唯一约束，重复保存不会互相顶掉
- 复合唯一索引只挡住「同一账号同一家存两份」，账号内跨家各存一份是正常状态，别把它改成 provider 单列唯一
- 逃生口 `DB_SYNCHRONIZE=true` 能让 TypeORM 自己建表，但**别在已有数据的库上开**：`synchronize` 会按实体反推 schema 并改动既有列，它只适合从零拉一个演示库
- 以后再加实体/字段，把语句追加到这份清单里，并在 `TECH_DESIGN.md`「数据模型」补对应说明

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
8. **`AUTH_ENABLED` 在 `cloudbaserc.json` 里显式写为 `false`**，发布上去直接就是免登录演示站：访客不用注册，进页面即用。这是有意选择而不是漏配，但它把域名变成了公共资源——任何人都能调 `/api/chat` 花掉你的大模型配额、`/api/config` 读写全部几家配置（Key 本身只回掩码，不回明文），全站数据共用同一账号，只剩 `THROTTLE_TTL/THROTTLE_LIMIT` 这一层 IP 限流。要按人隔离就把它改成 `true` 重新部署，登录页和账号隔离会原样回来。
9. **`MODEL_ROUTING_CANDIDATES` 默认留空**，它现在只是**全局兜底**：优先用每份配置里的 `routingCandidates`，配置留空才回落到它。两者都空就是线上恒用配置里的主力模型。要按场景换档，更推荐直接在页面「模型档位候选」里填该账号**确实开通了的**同家模型 id（从低到高，如 `deepseek-flash,deepseek-v4-pro`）——填了没开通的名字会在请求上游时拿到 4xx，界面直接报后端翻译过的错误。开关暴露在 `GET /api/health`（`modelRouting`），它报的 `modelCandidates` 只有环境变量那一份兜底候选——每份配置自带的候选属于账号数据，未登录的健康检查不该看到别人的配置，要看就登录后 `GET /api/config` 的 `items[].routingCandidates`。健康检查还列出 `providers`（线上「这家接没接」不用重新发布）。
10. **`MEMORY_ENABLED` 默认开启**（只认字面 `false`）。开 Postgres 时记得先跑「生产库结构变更」里的建表语句：缺表不会让对话挂掉（读路径退化成「没有记忆」），但 `remember` 会一直失败，`/api/health` 的 `memoryTable` 会显示 `missing`。要临时停掉这个能力就设 `MEMORY_ENABLED=false`——模型不会再看到 `remember`/`forget`，也就不会许下它做不到的事。

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
- `health` 里的 `memory` / `memoryTable` / `memoryLimits` 是长期记忆的三态口径：开关开没开、表在不在（`missing` = 建表 DDL 没跑）、当前生效的三类上限。界面与模型看到的都是同一份数
- 浏览器 Network 里 `Access-Control-Allow-Origin` 只能有**一个值**（出现逗号拼两份就是 CORS 双重注入）
- 函数刚重新部署后的首个请求可能因冷启动瞬时 404/超时，硬刷新重试即可

### 已知局限（sqljs 演示模式）

`/tmp` 是**每个云函数实例私有**且冷启动即清空，而 CloudBase 会按需并发拉起多个实例并按客户端连接做粘性路由。因此：

- A 实例建了对话、B 实例没有，chat 曾返回 404「对话不存在」。后端已加 `ConversationsService.ensureExists()`：配置校验通过后若对话缺失就用前端传的 id 补建，消除 404。
- 但 **config 与历史消息仍不共享**，可能随机出现“刚配好又提示未配置”、“历史时多时少”。
- 限流计数存在进程内存，实际放行量约为 `THROTTLE_LIMIT × 实例数`，需靠网关限频兜底。
- 断线续传的进度虽然由浏览器携带，但「撤掉中断那轮半截记录」这一步仍发生在当前实例的库里。若首发落在 A 实例、续传落到 B 实例，B 库里没有那条半截（于是续传结果在 B 看来只有一条完整回答），而回到 A 时可能同时看到那条半截。切 PostgreSQL 后各实例共享一份库，这个窗口就不存在了。

要稳定对外，把 `DB_TYPE` 改为 `postgres` 并填齐 `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE`（VPC 内网地址）后重新部署，所有实例共享一份库即可根治。

### 已知局限（免登录演示模式）

`AUTH_ENABLED=false` 时全站只有一个身份，后端把它绑定到**最早创建的账号**上。这不是过渡状态，而是设计上的取舍：

- **所有人共用一个账号**：访客之间共享同一批大模型配置（每家各一份 Key，加上「哪份在用」这个指针）与同一批会话记录，甲能翻到乙刚聊的内容。演示站可以接受，当成私人助理用不行。
- **长期记忆也是同一份**：`remember` 记进去的东西挂在演示账号下，所有访客都能看到（在下一次对话里被注入）、也都能用 `forget` 或面板删掉。对外演示前想清楚要不要让它开着——不想就设 `MEMORY_ENABLED=false`，这比事后清理别人记下的内容省事。
- **配额与 Key 是公共资源**：`/api/chat` 对任何能访问域名的人开放，花的是「当前使用」那家 Key 的余额；`/api/config` 也能被任意访客改写（返回值只有掩码，明文 Key 不会外泄，但每一家都可能被人替换成他自己的或删掉，「当前使用」也会被切走）。防线只剩 `THROTTLE_TTL`/`THROTTLE_LIMIT` 的按 IP 限流，且云函数多实例会让实际放行量约为 `LIMIT × 实例数`。
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
