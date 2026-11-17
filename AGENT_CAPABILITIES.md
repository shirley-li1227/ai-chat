# 智能体能力清单

本文只覆盖聊天后端的工具型 Agent（自主决策循环），按能力域汇总它**具备什么、不具备什么、由哪些参数控制**。
行为锚定于提示词版本 `PROMPT_VERSION = 2026.11.4`（[functions/api/src/chat/prompt.ts:13](file:///D:/MyProject/ai-chat/functions/api/src/chat/prompt.ts#L13)），
评测结果钉在同一版本上，改提示词必须先升版本再改断言。

---

## 1. 工具集（3 个常驻 + 1 个条件注册）

工具定义与执行都在 [functions/api/src/agent/tools.ts](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts)。
注册表 `TOOL_REGISTRY` 是唯一事实来源：给模型的 JSON Schema、执行前的参数校验、按名字分发全部从同一份 `ToolSpec` 派生，
统一入口 `executeTool`（[tools.ts:538](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L538)），异常在内部消化成可读错误文本后再喂回模型。

| 工具 | 能力 | 定义位置 | 约束 |
|------|------|----------|------|
| `get_current_time` | 本地时区的日期、时间、星期 | [tools.ts:392](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L392) | 无参数；提示词禁止模型凭训练记忆回答时间 |
| `calculator` | 精确算术：`+ - * / % ^`、括号，`sin/cos/tan/asin/acos/atan/sqrt/cbrt/log/log2/log10/abs/round/ceil/floor/exp`，常量 `PI`、`E` | [tools.ts:408](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L408) | 自建解析器；表达式上限 500 字；非法表达式返回解析失败说明，不抛栈 |
| `fetch_url` | 抓取指定网页并抽取纯文本 | [tools.ts:428](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L428) | 返回截断到 3000 字；url 上限 2000 字；超时 15s；响应体上限 1MB（[tools.ts:298-299](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L298)）；可选域名白名单 `FETCH_ALLOWED_HOSTS`（[tools.ts:292](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L292)） |
| `run_in_background` | 把一次可后台执行的工具调用提交为后台任务，只回任务编号 | [tools.ts:455](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L455) | **条件注册**：`BACKGROUND_TASKS_ENABLED=true` 才出现在 `tools` 列表里；见「3. 后台长任务」 |

参数校验先于执行（`validateToolArgs`，[tools.ts:74](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L74)）。
模型的参数是自由 JSON，之前一律 `String(args.x ?? '')` 会把类型问题压成空串，工具只能报「不能为空」，模型据此反复猜。
现在缺什么、什么类型、可选值有哪些、多了哪个字段，一次说清再返回，未知参数名同样拒绝。

`fetch_url` 是本智能体唯一的出站网络入口，受 URL 护栏 [functions/api/src/security/url-guard.ts](file:///D:/MyProject/ai-chat/functions/api/src/security/url-guard.ts) 约束：
仅允许 `http/https`，字面量 IP 与 DNS 全量解析结果都不允许落入内网/回环/元数据端点，且每一跳重定向重新校验（`assertUrlSafe`，[url-guard.ts:76](file:///D:/MyProject/ai-chat/functions/api/src/security/url-guard.ts#L76)）。

---

## 2. 决策循环与并发

| 能力 | 实现 | 说明 |
|------|------|------|
| 工具选择完全由模型自主判断（调不调、调哪个、调几次） | [chat.service.ts:273](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L273) | 系统提示词只给「该不该调」的判定示例，不做关键词路由 |
| 单次请求内最多迭代 `AGENT_MAX_TURNS` 轮 | [chat.service.ts:17](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L17) | 默认 6，防止无限循环消耗额度 |
| 同一轮多个 `tool_calls` 并发执行 | [chat.service.ts:330](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L330) + [tool-runner.ts:16](file:///D:/MyProject/ai-chat/functions/api/src/agent/tool-runner.ts#L16) | 并发上限 `AGENT_TOOL_CONCURRENCY`（默认 4，[chat.service.ts:24](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L24)），为何必须封顶见 `TECH_DESIGN.md`「工具并发执行」 |
| 结果按 `tool_calls` 原顺序回填 | [chat.service.ts:339](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L339) | 展示顺序不受完成顺序影响，前端靠 `tool_call_id` 对位更新 |
| 失败后带错误结果继续收敛 | [chat.service.ts:362](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L362) | 工具异常文本回灌模型，提示词要求其说明原因并调整参数重试 |

---

## 3. 后台长任务

长任务与一次 HTTP 请求的生命周期不匹配（函数硬顶 300 秒、前端 `pagehide` 就 abort），因此拆成「队列 + 执行器」两半。
**本分支只交付队列那一半**：表结构、领取语义、REST 接口、前端面板都完成了，执行器进程还没部署，所以能力默认关闭。

| 状态 | 能力 | 位置 |
|------|------|------|
| ✅ | 任务实体与队列字段（状态 / 租约 / 退避门 / 幂等键 / 尝试次数） | [task.entity.ts](file:///D:/MyProject/ai-chat/functions/api/src/tasks/task.entity.ts) |
| ✅ | 纯函数策略层：状态机、`isClaimable`、指数退避、失败编排、文本截断 | [task-policy.ts:84](file:///D:/MyProject/ai-chat/functions/api/src/tasks/task-policy.ts#L84) |
| ✅ | kind 注册表：提交校验与执行解释共用 `resolve()`，不会出现「接口收下、执行器读不懂」 | [task-registry.ts:109](file:///D:/MyProject/ai-chat/functions/api/src/tasks/task-registry.ts#L109) |
| ✅ | 执行器侧 API：`claimNext`（CAS 领取）/ `renewLease` / `isCanceled` / `report` / `succeed` / `fail` | [task.service.ts:166](file:///D:/MyProject/ai-chat/functions/api/src/tasks/task.service.ts#L166) |
| ✅ | 用户侧 REST 接口（列表 / 提交 / 详情 / 取消 / kind 元信息），越权统一 404 | [tasks.controller.ts](file:///D:/MyProject/ai-chat/functions/api/src/tasks/tasks.controller.ts) |
| ✅ | `run_in_background`：模型自主提交长任务，只回任务编号，明确告知「本轮回答里还没有它」 | [tools.ts:476](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L476) |
| ✅ | 前端「后台任务」面板：轮询进度、展示结果与错误、可取消 | [TaskPanel.tsx](file:///D:/MyProject/ai-chat/frontend/src/components/TaskPanel.tsx) |
| ✅ | 队列水位与开关随 `/api/health` 暴露（`background` / `tasks`） | [health.controller.ts:44](file:///D:/MyProject/ai-chat/functions/api/src/health/health.controller.ts#L44) |
| ❌ | **执行器进程**：目前没有调用方，提交的任务会一直停在 `queued`；`BACKGROUND_TASKS_ENABLED` 因此保持 `false` | 部署形态与约束见 `TECH_DESIGN.md`「后台任务队列」 |

关闭时的行为是有意的：不广播 `run_in_background`，模型就只会直接调用工具或在回答里说明无法后台，而不是造出一堆无人执行的任务。
开关每轮请求重新读取（`buildToolDefinitions()` 不传参，[chat.service.ts:229](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L229)），改环境变量重启即生效，不必重新构建。

---

## 4. 上下文治理

| 能力 | 实现 | 说明 |
|------|------|------|
| token 估算与滑窗裁剪 | [token-estimator.ts:25](file:///D:/MyProject/ai-chat/functions/api/src/chat/token-estimator.ts#L25) / [:81](file:///D:/MyProject/ai-chat/functions/api/src/chat/token-estimator.ts#L81) | `planWindow` 保最新后缀，预算默认 `CONTEXT_TOKEN_BUDGET=6000`（[chat.service.ts:30](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L30)），下限 800 保证最近一问一定带得走（[chat.service.ts:36](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L36)） |
| 被裁掉的旧轮次压成滚动摘要 | [context-summarizer.ts:34](file:///D:/MyProject/ai-chat/functions/api/src/chat/context-summarizer.ts#L34) | 独立非流式调用，`maxTokens: 400`、20s 超时（[:62](file:///D:/MyProject/ai-chat/functions/api/src/chat/context-summarizer.ts#L62)） |
| 摘要边界落库，避免重复压缩/重复发送 | [chat.service.ts:172](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L172) | `summaryUntil` 记录已覆盖到的消息时间戳 |
| 工具轨迹不进摘要 | [chat.service.ts:167](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L167) | 结论已体现在 assistant 正文里，重复计入只会推高成本 |
| 摘要可整体关闭以对比测试 | [chat.service.ts:39](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L39) | `CONTEXT_SUMMARY_ENABLED=false` 时退回「只裁剪不压缩」 |
| 历史工具轨迹可还原为协议消息 | [chat.service.ts:108](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L108) | `assistant(tool_calls) → tool(结果) → assistant(正文)`，顺序不能错 |

---

## 5. 运行过程的前端可见性

- SSE 事件顺序：`tool(calling)`×N → `tool(done|error)`×N → `content` 逐字 → `notice?` → `data: [DONE]`
- 工具步骤在消息气泡内以面板形式展开，含入参、状态与返回文本
- 等待首个 token 期间有生成中的 loading 指示，避免空气泡看不出正在响应
- 后台任务进度走轮询而不是 SSE：任务比一次连接活得久，断线重连与多标签页都不该依赖长连接（面板 2s / 15s 两档）
- 上游流消费与 `tool_calls` 分片累积：[chat.service.ts:419](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L419)

---

## 6. 异常与边界处理

| 场景 | 行为 | 位置 |
|------|------|------|
| 上游 `finish_reason: length`（输出被截断） | 下发 `notice`，提示回复「继续」 | [chat.service.ts:488](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L488) |
| 循环耗尽仍无正文且末轮以 `tool_calls` 结束 | 明确报「连续调用工具达 N 轮上限」 | [chat.service.ts:382](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L382) |
| 循环耗尽且无任何文本（非工具结尾） | 报「可能被输出长度上限截断」 | [chat.service.ts:383](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L383) |
| 用户中断（`AbortError`） | 保留已生成的半截回答与工具轨迹并落库 | [chat.service.ts:400](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L400) |
| 上游 401/403/429/其他 | 翻译成中文可操作提示，附带状态码 | [chat.service.ts:509](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L509) |
| 模型给出注册表里没有的工具名 | `executeTool` 返回「未知工具：x」文本，不抛异常打断本轮 | [tools.ts:543](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L543) |
| 提交无人能执行的后台任务（未知 kind / 不可后台的工具 / 参数不合法 / payload 过大） | 接口直接 400，错误文本带上可用清单与上限 | [task.service.ts:52](file:///D:/MyProject/ai-chat/functions/api/src/tasks/task.service.ts#L52) |
| 任务被用户取消后执行器才跑完 | 终态不可回退，迟到结果被丢弃（`canTransition` 拒绝） | [task-policy.ts:105](file:///D:/MyProject/ai-chat/functions/api/src/tasks/task-policy.ts#L105) |

---

## 7. 提示词与评测

- 提示词与工具描述集中在 `chat/prompt.ts` 并版本化，[evals/cases.json](file:///D:/MyProject/ai-chat/functions/api/evals/cases.json) 钉住同一版本号：两边不一致评测直接失败
- 离线回归 `npm run eval`（[functions/api/package.json:14](file:///D:/MyProject/ai-chat/functions/api/package.json#L14)）：46 项断言覆盖工具结果、异常路径、SSRF 护栏、上下文裁剪、并发语义，工具注册表与任务队列的结构不变量，以及鉴权模式判定（只认字面 `true`、与后台任务开关互不串线），无需网络与 Key
- 在线评测 `npm run eval:online`（[functions/api/package.json:15](file:///D:/MyProject/ai-chat/functions/api/package.json#L15)）：只看模型选了哪个工具，按分类统计命中率；缺 `EVAL_API_KEY` 直接报错退出，不会静默通过

用例覆盖清单与“为什么这样设计”见 `TECH_DESIGN.md`「提示词版本化与回归评测」。

---

## 8. 当前不具备

- 联网搜索：只能抓用户或模型给出的确切 URL，无搜索引擎入口
- 代码执行、文件读写、命令调用
- 图像/语音的生成与理解（且配置层禁止把文生图模型用于聊天）
- 跨会话长期记忆：只有同一会话内的滚动摘要，没有知识库检索
- 多供应商：预设仍只有 DeepSeek（兼容 OpenAI Chat Completions + tools）
- 流式工具结果：工具返回值一次性给出，不边生成边推送
- **后台任务的执行器**：队列与接口已就绪，缺常驻进程领取并执行，因此任务只会排队（见「3. 后台长任务」）
- 定时任务：没有 cron 触发器，`tasks` 表也没有 `scheduledAt` 之类的字段
- 多智能体编排与子任务委派：单循环单模型
- 访客级隔离：`AUTH_ENABLED` 缺省为免登录，所有访问共用最早创建账号的身份、配额与会话记录；按人隔离需要显式开启真实登录（机制见 `TECH_DESIGN.md`「免登录演示模式」）

---

## 9. 可调参数（环境变量）

| 变量 | 默认 | 作用 |
|------|------|------|
| `AUTH_ENABLED` | false | 是否走真实登录。非 `true` 即免登录：所有请求以库里最早创建的账号身份执行，前端跳过登录页。它决定的是这些工具调用记在谁名下、消耗谁的配额，见 `TECH_DESIGN.md`「免登录演示模式」 |
| `AGENT_MAX_TURNS` | 6 | 单次请求最大工具迭代轮数 |
| `AGENT_TOOL_CONCURRENCY` | 4 | 一轮内并发执行的工具数上限 |
| `CONTEXT_TOKEN_BUDGET` | 6000 | 历史消息可用 token 预算（不含 system 与摘要本身） |
| `CONTEXT_SUMMARY_ENABLED` | true | 关闭则退回「只裁剪不压缩」 |
| `BACKGROUND_TASKS_ENABLED` | false | 是否向模型广播 `run_in_background`；执行器上线前必须保持关闭 |
| `TASK_LEASE_MS` | 120000 | 执行器存活证明有效期；崩溃后任务最长被占用这么久，之后可被别的实例回收 |
| `TASK_MAX_ATTEMPTS` | 3 | 单个任务最多执行几次（含首次），超过判 `failed` |
| `TASK_CLAIM_SCAN` | 20 | 领取时一次扫描的候选条数上限 |
| `TASK_PAYLOAD_MAX_BYTES` | 8192 | 任务参数序列化后的字节上限 |
| `TASK_RESULT_MAX_CHARS` | 20000 | 结果与错误文本的落库上限 |
| `FETCH_TIMEOUT_MS` | 15000 | `fetch_url` 超时 |
| `FETCH_MAX_BYTES` | 1048576 | `fetch_url` 响应体上限 |
| `FETCH_ALLOWED_HOSTS` | 空 | 非空时作为抓取域名白名单 |

> 上下文窗口下限 800 token 目前是常量（[chat.service.ts:36](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L36)），未开放配置。
> 队列类阈值都有代码内下限兜底（租约 5s、尝试 1 次、payload 256B、结果 200 字），配错成 0 或负数不会让队列停摆。完整变量清单见 `functions/api/.env.example`。
