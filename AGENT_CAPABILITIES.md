# 智能体能力清单

本文只覆盖聊天后端的工具型 Agent（自主决策循环），按能力域汇总它**具备什么、不具备什么、由哪些参数控制**。
行为锚定于提示词版本 `PROMPT_VERSION = 2026.11.5`（[functions/api/src/chat/prompt.ts:13](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/prompt.ts#L13)），
评测结果钉在同一版本上，改提示词必须先升版本再改断言。

---

## 1. 工具集（3 个常驻 + 3 个按开关注册）

工具定义与执行都在 [functions/api/src/agent/tools.ts](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts)。
注册表 `TOOL_REGISTRY` 是唯一事实来源：给模型的 JSON Schema、执行前的参数校验、按名字分发全部从同一份 `ToolSpec` 派生，
统一入口 `executeTool`（[tools.ts:660](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L660)），异常在内部消化成可读错误文本后再喂回模型。

| 工具 | 能力 | 定义位置 | 约束 |
|------|------|----------|------|
| `get_current_time` | 本地时区的日期、时间、星期 | [tools.ts:457](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L457) | 无参数；提示词禁止模型凭训练记忆回答时间 |
| `calculator` | 精确算术：`+ - * / % ^`、括号，`sin/cos/tan/asin/acos/atan/sqrt/cbrt/log/log2/log10/abs/round/ceil/floor/exp`，常量 `PI`、`E` | [tools.ts:473](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L473) | 自建解析器；表达式上限 500 字；非法表达式返回解析失败说明，不抛栈 |
| `fetch_url` | 抓取指定网页并抽取纯文本，**边下边抽边推** | [tools.ts:493](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L493) | 正文截断到 3000 字；url 上限 2000 字；超时 15s；响应体上限 1MB；目标非 2xx 直接判失败，不把错误页当正文；可选域名白名单 `FETCH_ALLOWED_HOSTS` |
| `remember` | 把一条关于用户的长期事实写进 `user_memories`，跨会话生效 | [tools.ts:511](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L511) | **条件注册**：`MEMORY_ENABLED=false` 时不广播，调用直接被拒；单条 ≤ `MEMORY_ITEM_MAX_CHARS`，同一事实重复记返回已有编号而不是新增 |
| `forget` | 按编号忘掉一条记忆 | [tools.ts:538](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L538) | **条件注册**：同上。编号支持完整 uuid 与前缀，前缀在本账号条目里不唯一时报歧义并列出候选，绝不猜着删 |
| `run_in_background` | 把一次可后台执行的工具调用提交为后台任务，只回任务编号 | [tools.ts:578](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L578) | **条件注册**：`BACKGROUND_TASKS_ENABLED=true` 才出现在 `tools` 列表里；见「3. 后台长任务」 |

参数校验先于执行（`validateToolArgs`，[tools.ts:74](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L74)）。
模型的参数是自由 JSON，之前一律 `String(args.x ?? '')` 会把类型问题压成空串，工具只能报「不能为空」，模型据此反复猜。
现在缺什么、什么类型、可选值有哪些、多了哪个字段，一次说清再返回，未知参数名同样拒绝。

带开关的工具不进常驻清单 `TOOL_DEFINITIONS`，改由 `buildToolDefinitions()` **每次请求现算**
（[tools.ts:646](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L646)）：`MEMORY_ENABLED` / `BACKGROUND_TASKS_ENABLED` 一翻，
模型这一轮看到的能力列表就跟着变，被关掉的工具同时进 `disabledHintOf()`（[tools.ts:635](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L635)）——
调用它不会静默失败，而是拿回一句「此能力当前未开启」，模型据此向用户解释而不是反复重试。改环境变量重启即生效，不必重新构建。

`fetch_url` 是本智能体唯一的出站网络入口，受 URL 护栏 [functions/api/src/security/url-guard.ts](file:///D:/MyProject/ai-chat-gitee/functions/api/src/security/url-guard.ts) 约束：
仅允许 `http/https`，字面量 IP 与 DNS 全量解析结果都不允许落入内网/回环/元数据端点，且每一跳重定向重新校验（`assertUrlSafe`，[url-guard.ts:76](file:///D:/MyProject/ai-chat-gitee/functions/api/src/security/url-guard.ts#L76)）。
因此**本机开着 fake-IP 代理时抓不到任何域名**（代理把域名解析成 `198.18.0.0/15`，护栏判内网），要用字面公网 IP 才测得通。

---

## 2. 决策循环与并发

| 能力 | 实现 | 说明 |
|------|------|------|
| 工具选择完全由模型自主判断（调不调、调哪个、调几次） | [chat.service.ts:386](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L386) | 系统提示词只给「该不该调」的判定示例，不做关键词路由 |
| 单次请求内最多迭代 `AGENT_MAX_TURNS` 轮 | [chat.service.ts:33](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L33) | 默认 6，防止无限循环消耗额度 |
| 同一轮多个 `tool_calls` 并发执行 | [chat.service.ts:519](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L519) + [tool-runner.ts:16](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tool-runner.ts#L16) | 并发上限 `AGENT_TOOL_CONCURRENCY`（默认 4，[chat.service.ts:40](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L40)），为何必须封顶见 `TECH_DESIGN.md`「工具并发执行」 |
| 结果按 `tool_calls` 原顺序回填 | [chat.service.ts:541](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L541) | 展示顺序不受完成顺序影响，前端靠 `tool_call_id` 对位更新 |
| 失败后带错误结果继续收敛 | [chat.service.ts:529](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L529) | 工具异常文本回灌模型，提示词要求其说明原因并调整参数重试 |
| 本轮用哪个模型由服务端按问题复杂度分档挑 | [model-router.ts:82](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/model-router.ts#L82) | 候选**优先取该份配置的 `routingCandidates`**，留空才退回 `MODEL_ROUTING_CANDIDATES`（都**从低到高**）；两者都空即恒用主力模型；一次请求只决策一次，本轮所有工具迭代沿用同一个模型 |

**接的是哪几家**：[config/providers.ts](file:///D:/MyProject/ai-chat-gitee/functions/api/src/config/providers.ts) 的 `PROVIDER_REGISTRY` 目前列 DeepSeek 与智谱 GLM，两家都走 OpenAI Chat Completions + tools，
协议层不需要任何分支——分岔的是入口校验（Key 形态、baseUrl 是否允许带路径，智谱的兼容端点要填 `https://open.bigmodel.cn/api/paas/v4`）。
一个账号可以同时保存多份配置，同时只有一份「当前使用」，对话、路由候选、配额都跟着这份走；生效指针由服务层在一个事务里挪，接口只回掩码。
加一家改注册表那一份，外加前端 `PROVIDER_PRESETS` 的对应项，两边一致由 `multi-provider` 断言钉住。

---

## 3. 后台长任务

长任务与一次 HTTP 请求的生命周期不匹配（函数硬顶 300 秒、前端 `pagehide` 就 abort），因此拆成「队列 + 执行器」两半。
**本分支只交付队列那一半**：表结构、领取语义、REST 接口、前端面板都完成了，执行器进程还没部署，所以能力默认关闭。

| 状态 | 能力 | 位置 |
|------|------|------|
| ✅ | 任务实体与队列字段（状态 / 租约 / 退避门 / 幂等键 / 尝试次数） | [task.entity.ts](file:///D:/MyProject/ai-chat-gitee/functions/api/src/tasks/task.entity.ts) |
| ✅ | 纯函数策略层：状态机、`isClaimable`、指数退避、失败编排、文本截断 | [task-policy.ts:84](file:///D:/MyProject/ai-chat-gitee/functions/api/src/tasks/task-policy.ts#L84) |
| ✅ | kind 注册表：提交校验与执行解释共用 `resolve()`，不会出现「接口收下、执行器读不懂」 | [task-registry.ts:109](file:///D:/MyProject/ai-chat-gitee/functions/api/src/tasks/task-registry.ts#L109) |
| ✅ | 执行器侧 API：`claimNext`（CAS 领取）/ `renewLease` / `isCanceled` / `report` / `succeed` / `fail` | [task.service.ts:166](file:///D:/MyProject/ai-chat-gitee/functions/api/src/tasks/task.service.ts#L166) |
| ✅ | 用户侧 REST 接口（列表 / 提交 / 详情 / 取消 / kind 元信息），越权统一 404 | [tasks.controller.ts](file:///D:/MyProject/ai-chat-gitee/functions/api/src/tasks/tasks.controller.ts) |
| ✅ | `run_in_background`：模型自主提交长任务，只回任务编号，明确告知「本轮回答里还没有它」 | [tools.ts:578](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L578) |
| ✅ | 前端「后台任务」面板：轮询进度、展示结果与错误、可取消 | [TaskPanel.tsx](file:///D:/MyProject/ai-chat-gitee/frontend/src/components/TaskPanel.tsx) |
| ✅ | 队列水位与开关随 `/api/health` 暴露（`background` / `tasks` / `modelRouting` / `modelCandidates`（仅环境变量兜底那一份）/ `providers`（注册表里的供应商 id）） | [health.controller.ts:54](file:///D:/MyProject/ai-chat-gitee/functions/api/src/health/health.controller.ts#L54) |
| ❌ | **执行器进程**：目前没有调用方，提交的任务会一直停在 `queued`；`BACKGROUND_TASKS_ENABLED` 因此保持 `false` | 部署形态与约束见 `TECH_DESIGN.md`「后台任务队列」 |

关闭时的行为是有意的：不广播 `run_in_background`，模型就只会直接调用工具或在回答里说明无法后台，而不是造出一堆无人执行的任务。
开关每轮请求重新读取（`buildToolDefinitions()` 不传参，[chat.service.ts:386](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L386)），改环境变量重启即生效，不必重新构建。

---

## 4. 跨会话长期记忆

关于某个账号的**稳定事实**（叫什么、做什么、偏好什么格式），跨会话生效，与「会话内滚动摘要」是两套东西：摘要只活在一场对话里，会被裁剪掉；记忆每次请求都重新注入。

| 能力 | 实现 | 说明 |
|------|------|------|
| 模型自主记录 / 遗忘 | [tools.ts:511](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L511) / [:538](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L538) → [memory.service.ts:77](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.service.ts#L77) | 服务层方法经 `toolContextFor()`（[chat.service.ts:201](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L201)）注入 `ToolContext`，工具拿不到仓库句柄，只拿得到这两个回调 |
| 用户亲手写 / 删 | [memory.controller.ts:26](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.controller.ts#L26)（列表）· [:32](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.controller.ts#L32)（新增）· [:41](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.controller.ts#L41)（删除） | `POST`/`DELETE /api/memories`，手写条目 `source='user'`，越权与不存在一律 404 |
| 归属只到账号 | [memory.entity.ts:33](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.entity.ts#L33) | `conversationId` 仅记录「在哪次对话里记下的」，用于界面说明来处；检索与注入一律按 `userId` |
| 同一句话不记两遍 | [memory-policy.ts:60](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory-policy.ts#L60) + [entity 唯一索引:26](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.entity.ts#L26) | 指纹 = 折叠空白并转小写后的 sha256；命中已有条目时**刷新时间并回原编号**，不新增（[memory.service.ts:105](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.service.ts#L105)） |
| 条数封顶后淘汰最旧 | [memory.service.ts:207](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory.service.ts#L207) | 每次写入后 `trimToLimit`，按 `updatedAt` 从新到旧保留 `MEMORY_MAX_ENTRIES` 条 |
| 注入预算与「新→旧」取整条 | [memory-policy.ts:88](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory-policy.ts#L88) | 成本按**渲染后整行**算（编号 + 正文 + 分隔符），预算不够先牺牲陈旧那些；被挡掉的条数在文本里如实写「另有 N 条未列出」 |
| 注入文本本身 | [memory-policy.ts:115](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory-policy.ts#L115) → [request-context.ts:33](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/request-context.ts#L33) | 独立一条 `system`，位置是 提示词 → **记忆** → 摘要 → 历史；记忆比摘要更稳定，摘要比记忆更贴近本轮话题 |
| 给模型的短编号 | [memory-policy.ts:71](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory-policy.ts#L71) | uuid 去连字符后前 8 位。完整 uuid 太长且模型抄错一位就找不到；`forget` 允许前缀匹配，前提是在该账号条目里唯一，否则报歧义并列出候选（[:144](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory-policy.ts#L144)） |
| 总开关 | [memory-policy.ts:32](file:///D:/MyProject/ai-chat-gitee/functions/api/src/memory/memory-policy.ts#L32) | `MEMORY_ENABLED` 只认字面 `false`；关掉后既不广播 `remember`/`forget`，也不注入任何记忆，行为退回「只有会话内摘要」 |

**为什么记忆绝不写进会话历史**：进了历史就会被滑窗裁剪、被滚动摘要压缩、被用户在前端编辑，还会在每一轮重复计入 token。放在请求层注入，这三件事都不会发生——评测里「记忆不出现在裁剪与落库里」就是断言这一条（见「8. 提示词与评测」）。

**免登录演示模式下这是共享的**：`AUTH_ENABLED` 非 `true` 时所有访客挂在同一个演示账号上，也就是共用同一份记忆、且任何人都能删掉别人记下的内容。按人隔离要显式开启真实登录。

---

## 5. 上下文治理

| 能力 | 实现 | 说明 |
|------|------|------|
| token 估算与滑窗裁剪 | [token-estimator.ts:25](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/token-estimator.ts#L25) / [:81](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/token-estimator.ts#L81) | `planWindow` 保最新后缀，预算默认 `CONTEXT_TOKEN_BUDGET=6000`（[chat.service.ts:46](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L46)），下限 800 保证最近一问一定带得走（[:52](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L52)）；先扣掉已有摘要自身占用的 token 再算窗口（[:153](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L153)） |
| 被裁掉的旧轮次压成滚动摘要 | [context-summarizer.ts:84](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/context-summarizer.ts#L84) | 独立非流式调用，`maxTokens: 400`、20s 超时（[:62](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/context-summarizer.ts#L62)） |
| 摘要边界落库，避免重复压缩/重复发送 | [chat.service.ts:181](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L181) | `summaryUntil` 记录已覆盖到的消息时间戳（[conversation.entity.ts:33](file:///D:/MyProject/ai-chat-gitee/functions/api/src/conversations/conversation.entity.ts#L33)）；前端删消息时会跟着回退边界（[conversations.service.ts:144](file:///D:/MyProject/ai-chat-gitee/functions/api/src/conversations/conversations.service.ts#L144)） |
| 工具轨迹不进摘要 | [chat.service.ts:177](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L177) | 结论已体现在 assistant 正文里，重复计入只会推高成本 |
| 摘要可整体关闭以对比测试 | [chat.service.ts:55](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L55) | `CONTEXT_SUMMARY_ENABLED=false` 时退回「只裁剪不压缩」（[:166](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L166)） |
| 历史工具轨迹可还原为协议消息 | [chat.service.ts:92](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L92) | `assistant(tool_calls) → tool(结果) → assistant(正文)`，顺序不能错 |
| 记忆与摘要都不进历史 | [request-context.ts:30](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/request-context.ts#L30) | 组装顺序 提示词 → 长期记忆 → 摘要 → 历史；正因为摆在这里，裁剪/摘要/前端编辑都碰不到它们，见「4. 跨会话长期记忆」 |

---

## 6. 运行过程的前端可见性

- SSE 事件顺序：`model`（本轮实际模型与理由）→ 每个工具 `calling → streaming* → done|error`（`streaming` 可完全没有）→ `content` 逐字 → `notice?` → `data: [DONE]`
- **工具结果是流式的**：`fetch_url` 边下边抽，每读一块推一个 `tool(streaming)`，带正文增量与量化进度（阶段名、已下载字节、已抽取字数）。事件体的唯一组装处是
  [chat/sse-events.ts:31](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/sse-events.ts#L31)，
  纯进度事件不带 `delta` 字段，终态事件带完整 `result` 供前端整段覆盖
- 每个工具事件都带 `tool_call_id`，前端按它归位到对应卡片（[ChatInterface.tsx:68](file:///D:/MyProject/ai-chat-gitee/frontend/src/components/ChatInterface.tsx#L68)）：一轮并发执行几个工具就有几条独立事件流交错到达，不会画到同一张卡上
- 卡片执行中显示累加的 delta 与进度行（[ChatInterface.tsx:41](file:///D:/MyProject/ai-chat-gitee/frontend/src/components/ChatInterface.tsx#L41)），终态换成 `result`。两者由同一份抽取器保证逐字相同（[agent/html-text.ts:45](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/html-text.ts#L45)），所以不会先长出来又被改写
- 顶栏显示最近一条回答**实际用的模型**，前面带生效那一份的供应商标（`智谱 GLM · glm-air`），每条回答自己标一份（悬停给理由）；配置里那个主力模型名不再等于答案来源，多家并存后「刚才这句是谁答的」也不会糊
- 「长期记忆」面板（顶栏入口 + 右侧抽屉）列出该账号记住的每条事实：来源徽章（模型记的 / 用户手写的）、`[a1b2c3]` 短编号（悬停说明「Agent 用这个编号忘掉它」）、更新时间，逐条可「忘掉这条」；底部可手动补一条并实时显示字数/上限
- 面板副标题把当前口径摊开：`跨会话生效 · 最多 100 条 · 单条 200 字`（读的是 `/api/memories` 返回的 `limits`，改环境变量后界面跟着变，不用重新发布）；空态与读取失败各自有明确文案，失败带「重试」（[MemoryPanel.tsx](file:///D:/MyProject/ai-chat-gitee/frontend/src/components/MemoryPanel.tsx)）
- 模型 `remember`/`forget` 成功后前端即时重拉面板，用户看到的清单与模型口中的清单不留不一致窗口
- 等待首个 token 期间有生成中的 loading 指示，避免空气泡看不出正在响应
- 后台任务进度走轮询而不是 SSE：任务比一次连接活得久，断线重连与多标签页都不该依赖长连接（面板 2s / 15s 两档）
- 聊天流断掉时界面先保留已渲染的半截，再显示「连接中断，正在第 N/3 次自动续传…」，续写完成后合并成一条回答并标注「网络曾中断，回答已从断点续写完成」；重试次数耗尽则保留半截并提示改用「重新生成」
- 上游流消费与 `tool_calls` 分片累积：[chat.service.ts:559](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L559)

---

## 7. 异常与边界处理

| 场景 | 行为 | 位置 |
|------|------|------|
| 上游 `finish_reason: length`（输出被截断） | 下发 `notice`，提示回复「继续」 | [chat.service.ts:672](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L672) |
| 循环耗尽仍无正文且末轮以 `tool_calls` 结束 | 明确报「连续调用工具达 N 轮上限」 | [chat.service.ts:571](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L571) |
| 循环耗尽且无任何文本（非工具结尾） | 报「可能被输出长度上限截断」 | [chat.service.ts:572](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L572) |
| 用户中断（`AbortError`） | 保留已生成的半截回答与工具轨迹并落库 | [chat.service.ts:585](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L585) |
| 浏览器掉线 / 网关掐断连接 | `res` 的 `close` 触发中止，上游那次请求随即停掉，半截回答照样落库 | [chat.controller.ts:19](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.controller.ts#L19) |
| 传输层异常（上游被掐、读流抛错） | 落库半截 + 下发 `error` 且 `retryable: true`，前端据此自动续传 | [chat.service.ts:596](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L596) |
| 上游返回码是否值得自动重连 | 408 / 429 / 5xx 可续，其余 4xx 判死（Key 失效、模型名写错重连只会再烧一次额度） | [continuation.ts:73](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/continuation.ts#L73) |
| 续传带回的半截回答 | 以它为 assistant 前缀只补后半段；撤掉中断那轮的重复记录，收尾合成一条 | [chat.service.ts:328](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L328) |
| `partial` 为空 / 纯空白 / 超 30000 字符 | 直接 400 并说明「请重新生成」，不做无意义续传 | [chat-request.dto.ts:24](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat-request.dto.ts#L24) |
| 续传那轮用哪个模型 | 沿用中断那轮落库的 `messages.model`（仍需在候选白名单内），库里为 `null` 或该模型已下架才回退路由器——换模型续写会让前后半段自相矛盾 | [model-router.ts:109](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/model-router.ts#L109) |
| 上游 401/403/429/其他 | 翻译成中文可操作提示，附带状态码 | [chat.service.ts:693](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L693) |
| 模型给出注册表里没有的工具名 | `executeTool` 返回「未知工具：x」文本，不抛异常打断本轮 | [tools.ts:667](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L667) |
| 提交无人能执行的后台任务（未知 kind / 不可后台的工具 / 参数不合法 / payload 过大） | 接口直接 400，错误文本带上可用清单与上限 | [task.service.ts:52](file:///D:/MyProject/ai-chat-gitee/functions/api/src/tasks/task.service.ts#L52) |
| 任务被用户取消后执行器才跑完 | 终态不可回退，迟到结果被丢弃（`canTransition` 拒绝） | [task-policy.ts:105](file:///D:/MyProject/ai-chat-gitee/functions/api/src/tasks/task-policy.ts#L105) |
| 首次保存某一家却没填 Key | 400「首次保存该供应商的配置必须带上完整的 API Key」——留空只对已存过那家成立 | [config.service.ts:146](file:///D:/MyProject/ai-chat-gitee/functions/api/src/config/config.service.ts#L146) |
| 把生效位切到没配过的一家 | 404 并点名是哪一家、提示先填一次 Key | [config.service.ts:164](file:///D:/MyProject/ai-chat-gitee/functions/api/src/config/config.service.ts#L164) |
| 删掉一家却发现没删成 | 404「还没有保存过 X 的配置」；删的正好是生效那份时，剩下 `updatedAt` 最近的一份自动顶上，不会出现没有 Key 可用的空档 | [config.service.ts:181](file:///D:/MyProject/ai-chat-gitee/functions/api/src/config/config.service.ts#L181) |

---

## 8. 提示词与评测

- 提示词与工具描述集中在 `chat/prompt.ts` 并版本化，[evals/cases.json](file:///D:/MyProject/ai-chat-gitee/functions/api/evals/cases.json) 钉住同一版本号：两边不一致评测直接失败
- 离线回归 `npm run eval`（[functions/api/package.json:14](file:///D:/MyProject/ai-chat-gitee/functions/api/package.json#L14)）：**79 项断言**，无需网络与 Key。覆盖工具结果、异常路径、SSRF 护栏、上下文裁剪、并发语义，工具注册表与任务队列的结构不变量、鉴权模式判定（只认字面 `true`、与后台任务开关互不串线）、断点续传的上下文拼装不变量（前缀顺序、半截去重、缺问补份、拒绝条件、可重试返回码、工具轨迹合并不重不漏）、模型路由的分档不变量（未配置或显式关闭恒等主力、候选解析与低到高顺序、分数线性落档且封顶不越白名单、续传沿用白名单内的中断那轮模型、缺记录或模型已下架时回退路由器）
- `multi-provider`（7 项）：注册表自洽（id 不重复、每家 label/默认 baseUrl/默认模型/文档链接齐全、三条规则是正则且错误文案够长能告诉用户该改成什么、`modelHint` 存在否则跨家候选挡不住）、Key 格式规则按家取且样例互斥（别家的 Key 挡得下、留空放行）、baseUrl 只认 https 且允许带路径、前端 `PROVIDER_PRESETS`/`ProviderType`/`PROVIDER_ORDER` 与后端注册表逐家对齐、候选优先级「配置 > env」、跨家候选保存即被拒且点名到具体模型、路由用配置候选时不依赖环境变量
- `long-term-memory`（7 项）：开关只认字面 `false` 且三类上限都有兜底、去重看归一化后的内容、注入按新→旧且超预算的计入 `omitted`、注入文本自带编号与三条行为约束、编号解析（完整 / 唯一前缀 / 歧义 / 不存在）、`remember`+`forget` 随开关一起广播、**记忆只进 system 段绝不混进会话历史**
- `tool-streaming`（5 项）：三段式事件每条带 `id` 与 `name`、HTML 抽取与切分方式无关（任意分块拼起来逐字等于整篇）、抽取口径（标签与空白折叠、注释与脚本整段丢弃、实体还原）、正文到上限即停止产出且 delta 累加不超过终态 `result`、跨块多字节字符按 stream 模式解码才不变形
- 在线评测 `npm run eval:online`（[functions/api/package.json:15](file:///D:/MyProject/ai-chat-gitee/functions/api/package.json#L15)）：只看模型选了哪个工具，按分类统计命中率
- 装配之后的行为由 `npm run verify:live`（[functions/api/package.json:16](file:///D:/MyProject/ai-chat-gitee/functions/api/package.json#L16)）验：**49 项协议断言**，自己起假上游 + 临时库 + 真后端，覆盖 SSE 事件顺序与 `[DONE]` 收尾、断线半截落库与续传只补增量且沿用档位、上游 401 判死不重连、档位按复杂度落档、切家后请求真带那把 Key、按家校验与生效指针与删除后自动顶上、记忆的写入/去重/注入/开关、工具事件带 `tool_call_id`、SSRF 护栏、明文 Key 不进响应也不进库。它**证明不了**「模型自己会不会调工具」（假上游只按标记回话）和界面长得对不对，那两条分别归 `eval:online` 与浏览器
- 静态四件套由 `npm run verify` 并行跑（3.8s vs 串行 8.2s），见 `TECH_DESIGN.md`「验证为什么分三层」；缺 `EVAL_API_KEY` 直接报错退出，不会静默通过

用例覆盖清单与“为什么这样设计”见 `TECH_DESIGN.md`「提示词版本化与回归评测」。

---

## 9. 当前不具备

- 联网搜索：只能抓用户或模型给出的确切 URL，无搜索引擎入口
- 代码执行、文件读写、命令调用
- 知识库检索 / RAG：`remember` 记的是「关于这位用户的短事实」（单条 ≤ 200 字、每人 ≤ 100 条），不是文档索引；没有向量检索，也没法把一份 PDF 交给它问答
- 图像理解：链路上**没有多模态输入管线**——发给上游的每条消息只有纯文本 `content`，没有 `image_url` 附件的组装、上传、大小与类型校验，前端也没有贴图入口。所以哪怕把档位候选填成支持视觉的模型（智谱就有），它这一轮也收不到任何图片。缺的是本地管线，不是上游不支持
- 图像/语音的生成、语音输入与识别：同上，且配置层禁止把文生图模型用于聊天
- 供应商能力探测与自动降级：某一家返回 401/4xx 或整体不可用时不会自动改用另一家的 Key，界面就是报错。「多家配置」解决的是**人工切换**，不是故障转移
- 跨供应商/跨模态的模型选择：路由只在**同一份配置的文本档位**之间换档（候选必须与主力模型同家，跨家候选保存时就被拒）。它不会因此获得图像理解，也不做可用性探测——候选写成没开通的模型，只会在请求上游时拿到 4xx
- 断点续传的「服务端进度缓存」：不在内存里留进行中状态，进度由浏览器携带；上游也没有「从第 N 个 token 继续」的语义，续传是一次全新请求、会重新计入一遍上下文 token
- **后台任务的执行器**：队列与接口已就绪，缺常驻进程领取并执行，因此任务只会排队（见「3. 后台长任务」）
- 定时任务：没有 cron 触发器，`tasks` 表也没有 `scheduledAt` 之类的字段
- 多智能体编排与子任务委派：单循环单模型
- 访客级隔离：`AUTH_ENABLED` 缺省为免登录，所有访问共用最早创建账号的身份、配额、会话记录、**全部几家的 API 配置与「当前使用」指针**、长期记忆（谁都能删掉别人记下的那条）；按人隔离需要显式开启真实登录（机制见 `TECH_DESIGN.md`「免登录演示模式」）

---

## 10. 可调参数（环境变量）

| 变量 | 默认 | 作用 |
|------|------|------|
| `AUTH_ENABLED` | false | 是否走真实登录。非 `true` 即免登录：所有请求以库里最早创建的账号身份执行，前端跳过登录页。它决定的是这些工具调用记在谁名下、消耗谁的配额，见 `TECH_DESIGN.md`「免登录演示模式」 |
| `AGENT_MAX_TURNS` | 6 | 单次请求最大工具迭代轮数 |
| `AGENT_TOOL_CONCURRENCY` | 4 | 一轮内并发执行的工具数上限 |
| `CONTEXT_TOKEN_BUDGET` | 6000 | 历史消息可用 token 预算（不含 system 与摘要本身） |
| `CONTEXT_SUMMARY_ENABLED` | true | 关闭则退回「只裁剪不压缩」 |
| `MODEL_ROUTING_CANDIDATES` | 空 | **全局兜底**：候选档位**从低到高**逗号分隔，只在生效配置没填「模型档位候选」（`api_config.routingCandidates`）时才读到。两处都空等于不开启，回答恒用配置里的主力模型。填该账号确实开通的模型 id |
| `MODEL_ROUTING_ENABLED` | true | `false` 则只按主力模型作答，用于对比测试或排障（候选为空时本项无意义） |
| `MEMORY_ENABLED` | true | 是否广播 `remember`/`forget` 并注入记忆；只认字面 `false`，关掉后行为退回「只有会话内摘要」 |
| `MEMORY_ITEM_MAX_CHARS` | 200 | 单条记忆字数上限（兜底区间 40–500），超长在服务层拒绝并把长度差回给模型 |
| `MEMORY_MAX_ENTRIES` | 100 | 每个账号最多保留条数（兜底 5–500），超出按 `updatedAt` 淘汰最旧 |
| `MEMORY_INJECT_MAX_CHARS` | 1500 | 注入 system 的字符预算（兜底 200–4000），按渲染后整行计，装不下的如实报「另有 N 条未列出」 |
| `BACKGROUND_TASKS_ENABLED` | false | 是否向模型广播 `run_in_background`；执行器上线前必须保持关闭 |
| `TASK_LEASE_MS` | 120000 | 执行器存活证明有效期；崩溃后任务最长被占用这么久，之后可被别的实例回收 |
| `TASK_MAX_ATTEMPTS` | 3 | 单个任务最多执行几次（含首次），超过判 `failed` |
| `TASK_CLAIM_SCAN` | 20 | 领取时一次扫描的候选条数上限 |
| `TASK_PAYLOAD_MAX_BYTES` | 8192 | 任务参数序列化后的字节上限 |
| `TASK_RESULT_MAX_CHARS` | 20000 | 结果与错误文本的落库上限 |
| `FETCH_TIMEOUT_MS` | 15000 | `fetch_url` 超时 |
| `FETCH_MAX_BYTES` | 1048576 | `fetch_url` 响应体上限 |
| `FETCH_ALLOWED_HOSTS` | 空 | 非空时作为抓取域名白名单 |

> 上下文窗口下限 800 token（[chat.service.ts:52](file:///D:/MyProject/ai-chat-gitee/functions/api/src/chat/chat.service.ts#L52)）与 `fetch_url` 正文上限 3000 字（[tools.ts:303](file:///D:/MyProject/ai-chat-gitee/functions/api/src/agent/tools.ts#L303)）目前是常量，未开放配置。
> 队列与记忆类阈值都有代码内下限兜底（租约 5s、尝试 1 次、payload 256B、结果 200 字；单条 40 字、每人 5 条、注入 200 字），配错成 0 或负数不会让功能停摆。完整变量清单见 `functions/api/.env.example`。
