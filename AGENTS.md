# AI 聊天助手 · 开发指令

给在本仓库工作的 AI 助手（也给人）看的。这里只放**违反就会出事**的约束和速查信息；原理与取舍写在各专项文档里，见「先读哪份」。

## 项目是什么

React 19 + TypeScript + Vite + Tailwind 4 前端，NestJS 11 + TypeORM 0.3 后端，上游 DeepSeek（兼容 OpenAI Chat Completions，含 tools），
部署在腾讯云 CloudBase（静态托管 + HTTP 云函数）。它是一个**工具型 Agent**：模型自主决定调不调工具、调哪个、调几次，不是一次性问答。

## 常用命令

```bash
npm run install:all     # 前后端依赖（仓库根执行）
npm run dev:api         # 后端 :3001，nest start --watch
npm run dev             # 前端 :5173，/api 走 Vite 代理
npm run build           # 前端 → frontend/dist，后端 → functions/api/dist
npm run lint            # 仅前端 eslint
npm run typecheck       # 仅后端 tsc --noEmit
npm run eval            # 离线回归（57 项断言，无需网络与 Key）
npm run eval:online     # 在线测工具选择命中率，需 EVAL_API_KEY
```

改后端 `src` 后必须先 `npm run build` 再谈部署：云函数跑的是包内 `dist/`，`src` 与 `evals` 都被 `ignore` 排除。

## 先读哪份

| 文档 | 管什么 |
|---|---|
| `README.md` | 上手、环境变量、部署与已知局限、本地演示步骤 |
| `PRD.md` | 需求 ↔ 实现对照 |
| `TECH_DESIGN.md` | 架构、数据模型、接口、每个设计取舍的**为什么** |
| `AGENT_CAPABILITIES.md` | 智能体具备 / 不具备什么、哪些参数可调 |
| `DEMO_CHECKLIST.md` | 线上此刻能演什么、怎么演、翻车怎么救 |

**动了一次改动，就要把它影响到过的文档一起改掉**，别留下和代码矛盾的段落。

## 代码地图

```
frontend/src/
  App.tsx                根组件：登录态 + 会话状态 + SSE 事件落地
  client.ts              唯一的后端调用层（token / SSE 解析 / 断线续传重连）
  apiConfig.ts           供应商预设与表单校验
  components/            AuthView / ChatInterface / ApiConfigModal / TaskPanel
functions/api/src/
  auth/                  注册登录、scrypt、Bearer 守卫、AUTH_ENABLED 免登录
  config/                API 配置 CRUD（加密落库 / 明文迁移）
  chat/                  SSE 代理 + Agent 循环 + 上下文裁剪摘要 + 模型路由 + 提示词版本
  agent/                 工具注册表（schema + 校验 + 执行）+ 并发执行器
  tasks/                 后台任务：实体、队列策略、kind 注册表、REST 接口（不含执行器）
  conversations/         会话与消息实体/服务
  security/              AES-256-GCM 加解密、URL 内网拦截
  health/                探活（promptVersion / auth / background / modelRouting）
```

## 硬性约束

### 密钥与凭据
- API Key 由用户在页面填，**只在后端内存里以明文存在，落库前 AES-256-GCM 加密，接口只回掩码**。明文不得进日志、响应、URL 或前端存储。
- `ENCRYPTION_KEY`（64 位十六进制）缺失或格式非法时报错，**不许降级成明文存储**。
- 数据库密码、主密钥只从环境变量注入；`.env` / `.env.local` / `functions/api/data/*.db` 必须留在 `.gitignore` 里。
- 敏感信息输入框固定 `type="password"`，不要因为「方便用户看」改成 text。

### 数据层
- 本地用 **sql.js**，不要换 `better-sqlite3`：Windows 上 node-gyp 编译过不去，这是当初选它的原因。
- 生产 Postgres 的 `synchronize` 默认关闭且**没有迁移目录**，改实体必须手写 `ALTER TABLE`（最近一次加的是 `messages.model`），否则新字段要到第一次写库才报错。
- TypeORM 0.3 的 `findOne()` 必须带 `where`；可空的联合类型列必须显式写 `type`，否则启动报 `DataTypeNotSupportedError`。

### 流式与断线
- SSE 完成**以 `data: [DONE]` 为准**，不是连接关闭。断线检测挂在 `res` 的 `close` 上用 `writableEnded` 区分正常收尾，挂 `req` 上没用（请求体读完就 close 了）。
- 续传是一次全新请求：浏览器把已渲染的前半段带回来，服务端只推增量，最后合成一条落库。上游返回码是否值得自动重连由 `retryableForStatus` 判——401/403/4xx 判死，重连只会再烧一次额度。
- **续传沿用中断那一轮的模型**（白名单外或库里没记才回退路由器），否则前后半段自相矛盾，而前端只看到文本，查不出是换了模型。

### Agent 与工具
- 加工具走固定流程：在 `agent/tools.ts` 的 `TOOL_REGISTRY` 加 `ToolSpec`（schema / 校验 / 执行同一份）→ 系统提示词补「什么时候该调」→ `evals/cases.json` 加用例（`expectTool` 走在线，`offline` 断言走离线）。结构类不变量（注册表自洽、队列语义、续传、路由）写在 `evals/run-evals.mjs` 里。注册表是唯一事实来源，不要在别处再写一份 schema。
- 历史里的工具轨迹顺序不能错：`assistant(tool_calls) → tool(结果) → assistant(正文)`，缺一条上游就报错。
- 任何出站网络请求必须过 `security/url-guard.ts`（SSRF：字面 IP、DNS 解析结果、每一跳重定向都要校验）。
- 一轮内并发执行工具有上限 `AGENT_TOOL_CONCURRENCY`，结果按原顺序回填。
- 工具异常在内部消化成可读文本再喂回模型，不要让一次工具失败打断整轮对话。

### 提示词与评测
- 提示词与工具描述只在 `chat/prompt.ts` 存一份，改动行为**必须同时升 `PROMPT_VERSION` 并跑 `npm run eval`**；版本不一致评测直接失败。仅注释/空白调整不必升版本。
- 评测断言的是**不变量**（结构、顺序、边界、开关口径），不是模型措辞。加能力时补断言，别只改代码。

### 上下文
- 系统提示在请求层注入，**不写进会话历史**，因此不会被裁剪、摘要或前端编辑污染。
- 工具轨迹不进滚动摘要：结论已在 assistant 正文里，重复计入只推高成本。

### 上线开关
- `BACKGROUND_TASKS_ENABLED` 在执行器真正部署前保持 `false`，否则模型会提交一堆没人执行的任务。
- `CORS_ORIGINS` 线上保持为空：跨域头由网关「安全域名」注入，填了会双重注入被浏览器拦截。
- `AUTH_ENABLED` 缺省免登录。它是「这些调用记在谁名下、花谁的额度」的开关，改成 `true` 才按人隔离。

## 改完怎么验

1. `npm run typecheck` + `npm run lint` + `npm run build`，再 `npm run eval`。绿了只说明**代码能跑**，不说明功能对了。
2. 界面改动必须真在浏览器里走一遍主路径和边界（空态、错误态、加载中），做不到就明说没做，不要声称成功。
3. **验证不得污染真实数据**：不碰 `functions/api/data/app.db`，不覆盖用户已保存的 API Key。用临时目录里的独立 `.db` + 假密钥 + 非默认端口 + 进程内假上游；端口占用时先查属主，别误杀用户正在跑的开发服务。
4. 需要写库的校验逻辑（例如 `baseUrl` 必须 https）属于产品约束，**不要为了演示放宽**，改走服务层直接播种。
5. **部署、发布、上线只在用户明确要求时执行。** 默认交付到本地验证通过为止。

## 代码风格

- TypeScript 严格类型，不用 `any` 兜底；从 `localStorage` 等处读出的 union 字段要**校验后收窄**，不要 `as` 硬转。
- 注释默认不写。只在写「为什么」的时候写（隐藏约束、反直觉的取舍、绕过某个具体 bug）。
- 面向用户的错误提示一律中文、可操作（说清下一步做什么），不要把上游原始报错直接抛给用户。
- 样式用 Tailwind，不引入组件库。回答正文一律走 `react-markdown` + `remark-gfm` + 语法高亮，不要换成自研解析器；Markdown 表格要限宽不溢出；流式输出时滚动跟随要防抖，别让用户往上翻时被强行拽回。
- 发送期间禁用输入框与发送按钮；等待首个 token 要有明确的加载指示。
- 提示词里要求模型输出表格时给出格式约束，否则前端 GFM 渲染不出来。

## Git 约定

- Conventional Commits，类型和 scope 用中文也能接受，例如 `feat(chat): 新增上下文裁剪、工具并发与提示词评测体系`。
- 提交前用 `git status` 核对暂存了什么：配置文件里的示例密钥、`.env*`、`data/*.db`、构建产物都不该出现。
- 一次改动对应一个主题，别把无关的重构混进来。

## 现在还没有的（别顺手实现）

联网搜索、代码执行、文件读写、图像/语音的理解与生成、跨会话长期记忆、多供应商、后台任务执行器、定时任务、多智能体编排。
边界与解锁条件见 `AGENT_CAPABILITIES.md`「当前不具备」。用户明确要时才做，做之前先读那份确认不会和既有约束打架。
