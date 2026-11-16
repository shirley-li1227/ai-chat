# 智能体能力清单

本文只覆盖聊天后端的工具型 Agent（自主决策循环），按能力域汇总它**具备什么、不具备什么、由哪些参数控制**。
行为锚定于提示词版本 `PROMPT_VERSION = 2026.11.3`（[functions/api/src/chat/prompt.ts:13](file:///D:/MyProject/ai-chat/functions/api/src/chat/prompt.ts#L13)），
评测结果钉在同一版本上，改提示词必须先升版本再改断言。

---

## 1. 工具集（3 个）

工具定义与执行都在 [functions/api/src/agent/tools.ts](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts)，
统一入口 `executeTool`（[tools.ts:256](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L256)），异常在内部消化成可读错误文本后再喂回模型。

| 工具 | 能力 | 定义位置 | 约束 |
|------|------|----------|------|
| `get_current_time` | 本地时区的日期、时间、星期 | [tools.ts:20](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L20) | 无参数；提示词禁止模型凭训练记忆回答时间 |
| `calculator` | 精确算术：`+ - * / % ^`、括号，`sin/cos/tan/asin/acos/atan/sqrt/cbrt/log/log2/log10/abs/round/ceil/floor/exp`，常量 `PI`、`E` | [tools.ts:33](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L33) | 自建解析器；表达式非法返回解析失败说明，不抛栈 |
| `fetch_url` | 抓取指定网页并抽取纯文本 | [tools.ts:51](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L51) | 返回截断到 3000 字；超时 15s；响应体上限 1MB（[tools.ts:216-217](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L216)）；可选域名白名单 `FETCH_ALLOWED_HOSTS`（[tools.ts:210](file:///D:/MyProject/ai-chat/functions/api/src/agent/tools.ts#L210)） |

`fetch_url` 是本智能体唯一的出站网络入口，受 URL 护栏 [functions/api/src/security/url-guard.ts](file:///D:/MyProject/ai-chat/functions/api/src/security/url-guard.ts) 约束：
仅允许 `http/https`，字面量 IP 与 DNS 全量解析结果都不允许落入内网/回环/元数据端点，且每一跳重定向重新校验（`assertUrlSafe`，[url-guard.ts:76](file:///D:/MyProject/ai-chat/functions/api/src/security/url-guard.ts#L76)）。

---

## 2. 决策循环与并发

| 能力 | 实现 | 说明 |
|------|------|------|
| 工具选择完全由模型自主判断（调不调、调哪个、调几次） | [chat.service.ts:245](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L245) | 系统提示词只给「该不该调」的判定示例，不做关键词路由 |
| 单次请求内最多迭代 `AGENT_MAX_TURNS` 轮 | [chat.service.ts:14](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L14) | 默认 6，防止无限循环消耗额度 |
| 同一轮多个 `tool_calls` 并发执行 | [chat.service.ts:313](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L313) + [tool-runner.ts:16](file:///D:/MyProject/ai-chat/functions/api/src/agent/tool-runner.ts#L16) | 并发上限 `AGENT_TOOL_CONCURRENCY`（默认 4，[chat.service.ts:21](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L21)），为何必须封顶见 `TECH_DESIGN.md`「工具并发执行」 |
| 结果按 `tool_calls` 原顺序回填 | [chat.service.ts:320](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L320) | 展示顺序不受完成顺序影响，前端靠 `tool_call_id` 对位更新 |
| 失败后带错误结果继续收敛 | [chat.service.ts:324-327](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L324) | 工具异常文本回灌模型，提示词要求其说明原因并调整参数重试 |

---

## 3. 上下文治理

| 能力 | 实现 | 说明 |
|------|------|------|
| token 估算与滑窗裁剪 | [token-estimator.ts:25](file:///D:/MyProject/ai-chat/functions/api/src/chat/token-estimator.ts#L25) / [:81](file:///D:/MyProject/ai-chat/functions/api/src/chat/token-estimator.ts#L81) | `planWindow` 保最新后缀，预算默认 `CONTEXT_TOKEN_BUDGET=6000`（[chat.service.ts:27](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L27)），下限 800 保证最近一问一定带得走（[chat.service.ts:33](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L33)） |
| 被裁掉的旧轮次压成滚动摘要 | [context-summarizer.ts:34](file:///D:/MyProject/ai-chat/functions/api/src/chat/context-summarizer.ts#L34) | 独立非流式调用，`maxTokens: 400`、20s 超时（[:62](file:///D:/MyProject/ai-chat/functions/api/src/chat/context-summarizer.ts#L62)） |
| 摘要边界落库，避免重复压缩/重复发送 | [chat.service.ts:167-173](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L167) | `summaryUntil` 记录已覆盖到的消息时间戳 |
| 工具轨迹不进摘要 | [chat.service.ts:162-164](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L162) | 结论已体现在 assistant 正文里，重复计入只会推高成本 |
| 摘要可整体关闭以对比测试 | [chat.service.ts:36](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L36) | `CONTEXT_SUMMARY_ENABLED=false` 时退回「只裁剪不压缩」 |
| 历史工具轨迹可还原为协议消息 | [chat.service.ts:78](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L78) | `assistant(tool_calls) → tool(结果) → assistant(正文)`，顺序不能错 |

---

## 4. 运行过程的前端可见性

- SSE 事件顺序：`tool(calling)`×N → `tool(done|error)`×N → `content` 逐字 → `notice?` → `data: [DONE]`
- 工具步骤在消息气泡内以面板形式展开，含入参、状态与返回文本
- 等待首个 token 期间有生成中的 loading 指示，避免空气泡看不出正在响应
- 上游流消费与 `tool_calls` 分片累积：[chat.service.ts:404](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L404)

---

## 5. 异常与边界处理

| 场景 | 行为 | 位置 |
|------|------|------|
| 上游 `finish_reason: length`（输出被截断） | 下发 `notice`，提示回复「继续」 | [chat.service.ts:471-472](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L471) |
| 循环耗尽仍无正文且末轮以 `tool_calls` 结束 | 明确报「连续调用工具达 N 轮上限」 | [chat.service.ts:362-367](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L362) |
| 循环耗尽且无任何文本（非工具结尾） | 报「可能被输出长度上限截断」 | [chat.service.ts:366](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L366) |
| 用户中断（`AbortError`） | 保留已生成的半截回答与工具轨迹并落库 | [chat.service.ts:383-391](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L383) |
| 上游 401/403/429/其他 | 翻译成中文可操作提示，附带状态码 | [chat.service.ts:478-499](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L478) |

---

## 6. 提示词与评测

- 提示词与工具描述集中在 `chat/prompt.ts` 并版本化，[evals/cases.json](file:///D:/MyProject/ai-chat/functions/api/evals/cases.json) 钉住同一版本号：两边不一致评测直接失败
- 离线回归 `npm run eval`（[functions/api/package.json:14](file:///D:/MyProject/ai-chat/functions/api/package.json#L14)）：断言工具结果、异常路径、SSRF 护栏与结构不变量，无需网络与 Key
- 在线评测 `npm run eval:online`（[functions/api/package.json:15](file:///D:/MyProject/ai-chat/functions/api/package.json#L15)）：只看模型选了哪个工具，按分类统计命中率；缺 `EVAL_API_KEY` 直接报错退出，不会静默通过

用例覆盖清单与“为什么这样设计”见 `TECH_DESIGN.md`「提示词版本化与回归评测」。

---

## 7. 当前不具备

- 联网搜索：只能抓用户或模型给出的确切 URL，无搜索引擎入口
- 代码执行、文件读写、命令调用
- 图像/语音的生成与理解（且配置层禁止把文生图模型用于聊天）
- 跨会话长期记忆：只有同一会话内的滚动摘要，没有知识库检索
- 多供应商：预设仍只有 DeepSeek（兼容 OpenAI Chat Completions + tools）
- 流式工具结果：工具返回值一次性给出，不边生成边推送
- 后台/定时任务：Agent 只在一次 HTTP 请求生命周期内运行
- 多智能体编排与子任务委派：单循环单模型

---

## 8. 可调参数（环境变量）

| 变量 | 默认 | 作用 |
|------|------|------|
| `AGENT_MAX_TURNS` | 6 | 单次请求最大工具迭代轮数 |
| `AGENT_TOOL_CONCURRENCY` | 4 | 一轮内并发执行的工具数上限 |
| `CONTEXT_TOKEN_BUDGET` | 6000 | 历史消息可用 token 预算（不含 system 与摘要本身） |
| `CONTEXT_SUMMARY_ENABLED` | true | 关闭则退回「只裁剪不压缩」 |
| `FETCH_TIMEOUT_MS` | 15000 | `fetch_url` 超时 |
| `FETCH_MAX_BYTES` | 1048576 | `fetch_url` 响应体上限 |
| `FETCH_ALLOWED_HOSTS` | 空 | 非空时作为抓取域名白名单 |

> 上下文窗口下限 800 token 目前是常量（[chat.service.ts:33](file:///D:/MyProject/ai-chat/functions/api/src/chat/chat.service.ts#L33)），未开放配置。
