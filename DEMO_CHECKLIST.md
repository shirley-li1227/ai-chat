# 演示清单（线上环境）

记录当前 CloudBase 生产环境能演示什么、怎么演示，以及哪些必须回本地或改配置才能演。
最后核对时间：2026-11-18（分支 `dev`，当场 `curl /api/health` 回 `promptVersion: 2026.11.4`，且响应里没有 `modelRouting` / `memory` 字段）。
**线上跑的还是 `a48b2e4` 那一版**：断线自动续传与场景化模型选择已提交在 `dev`（`3fc8ed4`）但没发布，跨会话长期记忆、工具结果流式推送与多供应商配置（provider 注册表 + 每人每家一份 + 生效切换）已一并提交在 `dev`（`0e91bce`）同样没发布——五项一律列在「只能在本地演的」。线上 `GET /api/config` 还是老形态：只回 `{ configured, provider, baseUrl, model, apiKeyMasked }` 这一份，没有 `items` 列表也没有「设为使用」接口。

## 环境与当前模式

| 项 | 值 |
|---|---|
| 站点 | `https://lucky-lxy-d1g5yv28gd1a13d29-1306391378.tcloudbaseapp.com` |
| 接口 | `https://lucky-lxy-d1g5yv28gd1a13d29.service.tcloudbase.com/api` |
| 登录模式 | 免登录（`AUTH_ENABLED=false`），身份为兜底账号 `demo` |
| 数据层 | `DB_TYPE=sqljs` + `/tmp/app.db`，**每个实例私有、冷启动即清空** |
| 后台任务 | 队列与接口在线，执行器未部署（`BACKGROUND_TASKS_ENABLED=false`） |
| 模型路由 | 线上没有这个能力：`/api/health` 无 `modelRouting` / `modelCandidates`，回答恒用配置里的主力模型。代码已提交在 `dev`（`3fc8ed4`）未发布，见「只能在本地演的」 |
| 供应商 | 线上只认 DeepSeek：`@IsIn` 白名单里就一个值，弹窗里也没有第二家可选。provider 注册表 + 每人每家一份已提交 `dev`（`0e91bce`）未发布，见「只能在本地演的」 |
| 跨会话长期记忆 | 线上没有这个能力：`/api/health` 无 `memory` / `memoryTable` / `memoryLimits`，`GET /api/memories` 404，界面上也没有「长期记忆」入口。代码已提交 `dev`（`0e91bce`）未发布 |
| 工具结果流式推送 | 线上没有这个能力：`fetch_url` 仍是转圈十几秒后一次贴出全文，SSE 里没有 `tool` 的 `streaming` 事件，卡片上不会长进度行。代码已提交 `dev`（`0e91bce`）未发布 |
| 限流 | 10 次 / 60 秒 / IP，所有 `/api` 接口共用 |
| 加密 | `encryption: enabled`，Key 密文落库，接口只回掩码 |
| 提示词版本 | `2026.11.4` |

## 演示前 2 分钟准备

1. 准备一把可用的 DeepSeek API Key（`sk-` 开头）。**线上实例里没有 Key**，第一次打开会提示「尚未配置大模型 API」。
2. 无痕窗口打开站点 → 出现「页面访问提示」中间页 → 点「确定访问」。
3. 右上「API 设置」→ 选 DeepSeek → 粘 Key → 模型名 `deepseek-chat` → 保存并应用。
4. 打开 `curl https://lucky-lxy-d1g5yv28gd1a13d29.service.tcloudbase.com/api/health` 备着，讲到可观测性时当场贴出来。

> Key 只在这个实例的内存与 `/tmp` 里存活。演示中途若被路由到新实例或发生冷启动，会回到「尚未配置」，重填即可——这本身就是「已知局限」那一节的现场证据。

## 可演示（均已实测）

### 1. 免登录进入与身份提示

- 操作：无痕窗口打开站点。
- 预期：不出现登录页，直接是聊天界面；顶栏账号旁有「免登录」标记，且**没有**退出登录按钮。
- 讲法：真实注册/登录链路完整保留，切回去只改一个环境变量。
- 证据：`GET /api/auth/mode` → `{"authEnabled":false,"user":{"username":"demo"}}`。

### 2. 流式输出

- 操作：问「用三句话介绍杭州」。
- 预期：回答逐字出现，发送期间输入框与发送按钮禁用。

### 3. 多轮上下文

- 操作：紧接着问「我上一句问的是哪个城市」。
- 预期：答出杭州。再问「那你给我起个什么名字来着」可测更早轮次的滑窗行为。

### 4. Markdown 与表格、代码高亮

- 操作：问「用表格对比 DeepSeek 与智谱，列为：模型、特点、适用场景」。
- 预期：渲染成真实表格且不撑破版面。
- 操作：问「给一段 TypeScript 的防抖函数」。
- 预期：代码块语法高亮 + 右上角复制按钮。

### 5. 会话管理

- 操作：新建对话 → 切回旧对话 → 删除一个。
- 预期：列表即时更新，删除只影响当前会话及其消息。
- 证据：线上 `POST /api/conversations` 201、`DELETE` 200。

### 6. 重新生成 / 编辑重发

- 操作：在最后一条回答上点「重新生成」；或在一条历史提问上点「编辑重发」改字后发送。
- 预期：该时刻之后的消息被回退，再重新生成并落库。
- 证据：`POST /api/conversations/:id/truncate` → `{removed:0,summaryReset:false}`（201）。

### 7. API 配置弹窗与加密存储

- 操作：保存 Key 后重开弹窗。
- 预期：只显示掩码（形如 `sk-8****9eb2`），不回填明文；`GET /api/config` 也只有 `apiKeyMasked`。
- 讲法：明文只在调用上游那一刻存在于内存，主密钥从环境变量注入，不入库不进前端。

### 8. 后台任务面板与队列语义

- 操作：顶栏「后台任务」→ 面板里按字段说明提交一条 `tool_call`（工具选 `fetch_url`，给个公网 URL）→ 再点取消。
- 预期：新任务停在「排队中」，面板顶部明确写着执行器未启用；取消后状态变「已取消」且不可再取消。
- 讲法：队列语义（租约 / 退避 / 重试 / 幂等 / 终态不可复活）已全部落地并进了离线评测，缺的只是常驻执行器。
- 证据：线上实测 `queued` → `canceled`，重复取消返回 400；`GET /api/tasks/meta/kinds` 的 `runnerEnabled:false`。

### 9. 可观测性

- 操作：贴 `/api/health` 输出。
- 预期：`database: up`、`encryption: enabled`、`promptVersion`、`auth`、`background`、任务水位一次看全。
- 讲法：线上跑的是哪一版提示词、有没有鉴权、队列开没开，都不用重新发布就能查到。

## 只能在本地演的

下面这几组的**协议层断言已经固化成一条命令**：`npm run verify:live`（脚本在 `functions/api/evals/live/`，49 项，约 5s）。
它自己起假上游 + 临时库 + 真后端，跑完自动清理；每组的「校验证据」就是它输出的对应那几行，不用再靠某次手搓的脚本自证。
浏览器那一层仍然要人点：live 栈证不了「看得对不对」。

### 断线自动续传（SSE resume）

线上演不了：可控地「把流掐断」需要一个故意掐连接的假上游，而且这个能力只提交到 `dev`（`3fc8ed4`）还没发布。本地已实测通过，链路是真的：

- 环境：`npm run verify:live -- --only=chat-core` 自动起（假上游 `127.0.0.1:4102`，问题里带 `[[cut]]` 就吐两段再毁连接；后端 `:4101` 用系统临时目录里的独立 `.db`，不碰 `functions/api/data/app.db`；两把 Key 都是假串）。
- 现象：浏览器先逐字显示「从前有座」→ 流断 → 提示「连接中断，正在第 1/3 次自动续传…」→ 续写完成后气泡变成一条完整回答，顶部提示「网络曾中断，回答已从断点续写完成。」
- 落库核对：会话里只有一条 user + 一条 assistant，assistant 是完整回答；假上游日志恰好两次请求（首发 + 续传），没有第三条。
- 协议级校验：`live:chat-core` 14 项全绿，其中三条正是这条链路——「上游被掐断：已生成的半截照样落库且不谎报完成」「续传：只补后半段并合成一条，且沿用中断那一轮的档位」（顺带核对上游恰好两次、两次同档）「上游 401：判死且不会被自动重连再烧一次额度」。
- 步骤与环境变量写法见 `README.md`「本地演示：断线自动续传」。
- 发布到线上后可升级为「现场演」：DevTools 切 offline 制造断流，恢复网络看它自己续上。

### 场景化模型选择（模型路由）

线上演不了：这个能力还没发布（`/api/health` 查不到 `modelRouting`），而且线上要演就得把 `MODEL_ROUTING_CANDIDATES` 填成该账号**确实开通了的**模型名——两个档位若其实是同一个模型，界面看不出换档，演示等于自证不了什么。本地用假档位已经演通，档位与续传不换模型都留了证据：

- 环境：`npm run verify:live -- --only=chat-core` 自动起（假上游 `:4102` + 后端 `:4101`，候选播种成 `test-flash,test-pro`），全程不联网、密钥是假串。候选早已从环境变量搬进每份配置，脚本走的就是现在这份代码，不再有「那一轮跑的是旧版本」的问题。
- 现象（要在浏览器里看的部分）：先发一句短问候 → 气泡标 `test-flash`，顶栏 `deepseek · test-flash`；再发「请仔细分析这段代码的性能问题，并给出优化方案」→ 气泡标 `test-pro`，悬停给出复杂度分与命中的信号（要求深入 / 分析设计类 / 含代码）。
- 关键交叉验证：第二句在半路被假上游掐断（问题里带 `[[cut]]`）→ 自动续传 → `live:chat-core`「续传：只补后半段并合成一条，且沿用中断那一轮的档位」核对上游恰好两次请求、两次都是 `test-pro`。第二次就是续传，前后半段没换人。
- 离线不变量：`npm run eval` 79 项全绿，其中模型路由 6 项盯住「未配候选或显式关闭恒等主力、候选按低到高解析、分数线性落档且封顶不越白名单、续传沿用白名单内的中断那轮模型、缺记录或模型已下架才回退路由器」。
- 协议级校验：`live:chat-core` 14 项里的「短问题落最低档且以 `data: [DONE]` 收尾」「复杂问题升档并把实际模型落库」「切到智谱用它那一份候选」，加 `live:config` 的「健康检查列出线上接了哪几家」。健康检查同时输出 `modelRouting` / `modelCandidates`，但脚本没断言它们——要看就看 `/api/health` 的原文。
- 步骤与环境变量写法见 `README.md`「本地演示：断线自动续传」（浏览器里演的是同一条链路，一次演两件事）。

### 跨会话长期记忆（remember / forget + 面板）

线上演不了：这个能力已提交 `dev`（`0e91bce`）但没发布，线上 `/api/memories` 直接 404、`/api/health` 里也没有 `memory` / `memoryTable` / `memoryLimits`，界面上根本没有「长期记忆」入口。本地已用独立栈演通：

- 环境：协议层是 `npm run verify:live` 的 `chat-memory-off` + `chat-memory` 两组（复用 `:4102` 假上游，各起一次后端 `:4101`，`MEMORY_ENABLED` 一次 `false` 一次默认开；库都建在系统临时目录的新目录里，每次重播）。要在浏览器看面板就另起一次后端 + `npm run dev`，见 `README.md`「本地演示：跨会话长期记忆与工具实时进度」——那条路用的是你自己的真 Key，会真的烧额度。
- 现象（界面）：说「记一下，我以后都要中文回答」→ 气泡里长出 `remember` 工具卡片，终态文案「已记住（编号 a1b2c3d4）」；顶栏「长期记忆」面板角标变 1，条目来源徽章是「Agent 记下」，带同样的 8 位编号。
- 跨会话证据：新建一个会话（历史里没有任何复述）问一句话，假上游日志里那条请求的 system 段带着这条记忆清单——`live:chat-memory`「新会话不带历史也能看见这条记忆（注入的是 system 段）」断言的就是这条；面板里手写一条则徽章是「手动添加」（脚本侧对应「面板手写一条：来源是 user」）。
- 忘掉：`forget` 只写编号前 3 位也认（该账号下不唯一时会反问而不是猜着删）；面板「忘掉这条」即时减少条目，与模型走的同一条删除路径（脚本里两条：「forget 只写编号前 3 位也认」与「面板删除与模型删除走同一条路径」）。
- 关闭态：`live:chat-memory-off` 3 项盯住「健康检查报 `memory: disabled`」「这一轮发给模型的 tools 里没有 `remember` / `forget`」「模型硬调也被挡下、回话是未启用且整轮照常收尾」。界面上另有琥珀色提示条 + 按钮 `disabled` 且悬停给出原因，「手动记一条」不再能提交（否则只会拿到后端 400）——**这条只在浏览器里演过**，脚本断言不到。
- 校验证据：`live:chat-memory` 8 项全绿（开局空清单、8 位编号、注入位置、去重、来源、唯一前缀、编号不存在时不猜删、删除后清单）；`npm run eval` 79 项里的长期记忆 7 项盯住「开关缺省开启只认字面 `false` 且上限带兜底、归一化后同一事实只一条、注入按新→旧且超预算的计入 omitted、注入文本自带编号与三条行为约束、编号完整或唯一前缀才命中而歧义/不存在各回各的、`remember`/`forget` 随开关一起广播或关闭、记忆只进 system 段绝不混进会话历史」。
- 诚实边界：假上游是按问题里的关键词**脚本化**地吐出 `tool_calls`，所以「真实模型会不会自己决定调 `remember`」这条没在这里证明，只能靠 `$env:EVAL_API_KEY="sk-..."; npm run eval:online` 测命中率。
- 步骤与环境变量写法见 `README.md`「本地演示：跨会话长期记忆与工具实时进度」。

### 工具结果流式推送（抓取边下边抽 + 并发按 `tool_call_id` 分流）

线上演不了：同样是已提交 `dev`（`0e91bce`）未发布的能力，线上 `fetch_url` 还是转圈十几秒后突然贴出整段正文。本地演通的部分：

- 环境：在浏览器演需要前端，走 `README.md`「本地演示：跨会话长期记忆与工具实时进度」那套（自己的 Key，会烧额度）；抓取的 URL 要挑**字面公网 IP**，否则本机代理的 fake-IP 解析会把请求拦在半路、看不出是产品的问题。协议层的 id 归属与并发分流由 `npm run verify:live -- --only=chat-core` 覆盖，里面用 `[[calc:…]]` 让假上游一轮点两个工具，不联网。
- 现象：工具卡片先出现阶段行（开始接收响应 → 读取正文），正文一段段长在卡片里，进度行是「已下载 x / 上限 y 字节 · 已抽 z 字」，终态换成完整结果且**不跳字**。
- 硬不变量：SSE 里 `streaming` 的 delta 累加逐字等于终态 `result`——增量和终态由同一个抽取器（`agent/html-text.ts`）产出，所以不会出现「流式看到一套、最后贴另一套」。**这条只能演真的抓到页面的那一路**：live 栈的假上游不下载真页面，抓内网地址只用来断言 SSRF 判死。
- 并发：一轮内让模型抓两个地址 → 两张卡各自独立推进，事件按 `tool_call_id` 各归各卡，不会串流；上限仍是 `AGENT_TOOL_CONCURRENCY=4`。
- 错误态：非 2xx 判失败，错误文本带状态码；工具失败只让那张卡变红，不打断整轮对话。
- 校验证据：`live:chat-core` 里「工具轮：calling 带 args、终态带 result」「一轮内两个工具各归各卡」「每个工具事件都带 id 与 name」「SSRF：抓内网地址的工具结果是错误而不是页面」「工具失败不打断整轮」，加「上游被掐断」一条共 14 项；离线 `npm run eval` 79 项里的工具流式 5 项盯住「三段式 `calling → streaming* → 终态` 每条都带 id 与 name、HTML 抽取结果与切分方式无关、抽取口径（标签与空白折叠、注释与脚本整段丢弃、实体还原）、字数到上限即停止产出且累加 delta 不超过终态、跨块多字节字符按 stream 模式解码才不变乱码」。

### 多供应商配置与生效切换（DeepSeek + 智谱 GLM）

线上演不了：`/api/config` 的列表与生效指针已提交 `dev`（`0e91bce`）但没发布，线上还停在「一个账号一份配置」的形态。本地演通的部分：

- 环境：`npm run verify:live -- --only=config` 自动起（假上游 `127.0.0.1:4102` + 后端 `:4101`，库在系统临时目录的独立 `app.db`，**不碰 `functions/api/data/app.db`**），两把都是假串（`sk-…` 与 `id.secret` 形态）。两家的 baseUrl 都指向同一个假上游、只是路径不同（`/v1` 与 `/api/paas/v4`），所以点「设为使用」也打不到真实网关；https 那条产品约束没放宽，是 `seed.mjs` 直接在数据层播种绕开 DTO。
- 现象：弹窗上半区同时列出两家，各带掩码（`1234****klmn` 这种），只有「当前使用」那一个有徽章；切到智谱那一栏能带出已存的模型名、档位候选与带路径的 Base URL（`https://open.bigmodel.cn/api/paas/v4`）。
- 讲法一（不用重贴密钥）：把 Key 框留空保存＝沿用库里那把，只有这家从没存过时才拦下来要求填写；改模型名因此不用重新粘贴密钥。
- 讲法二（校验属于供应商）：拿 DeepSeek 的 `sk-` Key 存进智谱会被拒，反过来也一样；Base URL 填 `http://` 被拒（产品约束，没为演示放宽）；档位候选填了别家的模型名，保存时直接点名拒掉——因为那种请求只会发给错的网关拿 4xx，而界面上只看得见「答不上来」。
- 生效切换：点「设为使用」→ 徽章与顶栏的「供应商 · 模型」同时跟着变；不勾「保存后设为当前使用」就是先存着、回头再切。删掉当前使用那一家后，剩下最近更新的那份自动顶上，不会出现没有 Key 可用的空档。
- 切家后确实换了凭据：假上游日志记下每次请求的 `Authorization` 尾 4 位、路径与 `model`，`live:chat-core` 的「切到智谱：请求走它那家的路径、带它那把 Key、用它那一份候选」断言的就是打到 `/api/paas/v4/chat/completions`、带智谱那把、档位取这份候选的第 0 档 `glm-air`（DeepSeek 那份播种成 `test-flash,test-pro`，两家候选互不共用）。「切回 DeepSeek 后一切照旧」再核对一次没留半切换状态。
- 诚实边界：浏览器那一轮是在内置浏览器里用脚本派发真实事件驱动的（截图通道当时不可用），所以界面结论来自 DOM 断言与顶栏文案，不是肉眼看图；现场演示请自己开一遍。
- 校验证据：`npm run eval` 79 项里的 `multi-provider` 7 项盯住「注册表自洽、Key 规则按家互斥且留空放行、baseUrl 只认 https 且允许带路径、前端 presets 与后端注册表逐家对齐、候选优先级配置>env、跨家候选被拒且点名、路由用配置候选不依赖 env」；另有 `live:config` 24 项协议断言覆盖列表形状与生效指针唯一、掩码「前 4 + `****` + 后 4」、明文不进响应、库文件里只有 `gcm1:` 密文、health 的 `providers`、删除后指针自动顶上、清空后 `configured:false`、清空后首份自动生效、同一家二次保存是覆盖不是新增——最后这几条会真删掉这份临时库里的配置再重建（每次跑都是新库，所以敢做破坏性核对）。

## 有条件可演示

| 项 | 前提 | 风险与备话术 |
|---|---|---|
| Agent 工具调用（时间 / 计算 / 抓取）+ 步骤面板 | 当前实例已配 Key | 现有会话里没触发过工具轮，演示要直接问「现在几点，星期几」「算 12345×6789+log10(1000)」「抓 https://www.weather.com.cn/weather/101010100.shtml 告诉我北京明天温度」，否则模型可能不调工具 |
| 一轮内并发执行多个工具 | 同上 | 问「分别抓 A 和 B 两个页面再对比」，上限 `AGENT_TOOL_CONCURRENCY=4`，步骤面板里两条会同时推进。注意线上卡片只在结束时贴出结果，边下边抽的实时进度是已提交 `dev`（`0e91bce`）未发布的改动 |
| SSRF 护栏 | 同上 | 让模型抓 `http://169.254.169.254/latest/meta-data/` 或 `http://127.0.0.1:3001/api/health`，工具应拒绝并说明原因；注意这是「模型去调工具」的路径，不是直接打接口 |
| 上下文裁剪 + 滚动摘要 | 长对话（预算 `CONTEXT_TOKEN_BUDGET=6000`）且一路落在同一实例 | 实例漂移会让历史变短，摘要演示不稳定，建议只在本地演 |
| 对话持久化「刷新不丢」 | 同一热实例 | 刷新还在；换实例或冷启动就没了。当场演「刷新不丢」可以，别演「明天还在」 |
| 限流行为 | — | 10 次/60 秒/IP，反复刷新会 429，讲不清反而减分；多实例下实际放行量约为 10×实例数 |

## 不可演示 / 待办

| 项 | 原因 | 解锁条件 |
|---|---|---|
| 多用户账号与数据隔离 | 免登录下全站共用 `demo` 一个身份，前端不进登录页 | `AUTH_ENABLED=true` 重新部署（本地随时可演：设该变量后刷新即回登录页） |
| 后台任务真正执行完并回填结果 | 没有常驻执行器，`run_in_background` 也不会广播给模型 | 部署 worker（`NestFactory.createApplicationContext()` 第二入口，不能塞进 HTTP 函数），再把 `BACKGROUND_TASKS_ENABLED` 置 true |
| 用本地那份数据演示 | 线上是空库兜底账号；本地 `moningmo` 的 Key 与历史从未进过云端 | 数据层切 PostgreSQL 后在云端重新积累，或直接演示本地环境 |
| 配置与历史跨实例、跨冷启动保持 | `sqljs` + `/tmp` 每实例私有 | `DB_TYPE=postgres`，补齐 `DB_HOST` / `DB_USERNAME`（`cloudbaserc.json` 里仍是占位符），`DB_PASSWORD` 已在 `.env.local` |
| 无中间页直达访问 | CloudBase 测试域名的平台拦截页 | 绑定已备案自定义域名 |
| 多供应商在线上切来切去 | 能力已提交 `dev`（`0e91bce`）但没发布，线上跑的还是单配置的旧版 | 发布 `dev` 这一版（`tcb fn deploy` + 前端重构建），并按 README「生产库结构变更」补 `api_config` 的 `active` / `routingCandidates` 列与复合唯一索引——没跑 DDL 就发布，`GET /api/config` 会直接报「列不存在」，登录后界面表现为后端不可用 |
| 联网搜索、代码执行、图像/语音、文生图 | 本就未实现 | 见 `AGENT_CAPABILITIES.md`「当前不具备」 |

## 现场翻车排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开是「页面访问提示」 | 测试域名中间页 | 点「确定访问」 |
| 提示「尚未配置大模型 API」 | 新实例 / 冷启动清空了 `/tmp` | 重填 Key |
| 历史列表时多时少、刚配好又提示未配置 | 请求被路由到别的实例 | 属既知局限，切 Postgres 根治 |
| 请求返回 429 | 撞 IP 限流 | 等 60 秒，或换网络 |
| 首个请求瞬时 404 / 超时 | 函数冷启动 | 刷新重试 |
| 后台任务一直「排队中」 | 执行器未部署 | 预期行为，面板已写明 |
| 本地演续传时后半段没来 | 假上游只在**问题里带 `[[cut]]` 且这一问还没答过**时掐一次：续传那次带 assistant 前缀，不会再被掐，所以「重演同一句」只会正常答完 | 换一句问题文本重演，或直接重跑 `npm run verify:live -- --only=chat-core`（每次新建会话、新建临时库） |
| 本地 `fetch_url` 报「禁止访问内网地址」 | 本机开着 fake-IP / TUN 代理（Clash 等），域名被解析成 `198.18.0.0/15`，SSRF 护栏把这一段判为内网——护栏在正常工作 | 演示改用**字面公网 IP**（如 `https://1.1.1.1/cdn-cgi/trace`）绕开解析；不要为了演通去放宽 `url-guard.ts` |
| 第一次给某家保存时空着密钥框，弹「请填写 API Key」 | 「留空＝沿用库里那把」只对**这家已经存过**成立；从没存过就没有可沿用的东西 | 填一次即可。之后再改模型名或候选，密钥框留空保存，掩码不变 |
| 保存时报「候选档位里的 xxx 不属于 智谱 GLM」 | 候选里混进了别家的模型 id，DTO 层按该家 `modelHint` 拒的——这是设计意图，不是 bug | 只填这一家确实开通的模型，从低到高；发给别家的网关只会拿 4xx，而界面上只看得见「答不上来」 |
| 面板顶部出现琥珀色「长期记忆已关闭」 | 后端 `MEMORY_ENABLED=false`，模型不再记录也不注入，但库里条目还在、删除仍可用 | 属预期行为，正好用来演「开关一翻，模型这一轮的能力清单跟着变」；要恢复就改变量重启后端 |
| `/api/health` 里 `memoryTable: missing` | 生产 Postgres 的建表 DDL 没跑（`synchronize` 关着且没有迁移目录） | 读路径会退化成「没有记忆」、对话照常，只有 `remember` 失败；补 README「生产库结构变更」第 2 条那段建表语句 |
| 本地播种配置报 `baseUrl 必须是 https` | 那是 DTO 层的产品级校验，不该为演示放宽 | 改用数据层播种：`npm run build:api` 后 `node functions/api/evals/live/seed.mjs --db <临时库路径> --upstream http://127.0.0.1:<端口>`（`ENCRYPTION_KEY` 必须先在环境里，缺了它 seed 直接退出而不是降级存明文）。`verify:live` 内部用的就是这一份 |
| 后端起来就 503 提示 `ENCRYPTION_KEY` 格式非法 | 手打的密钥不是 64 位十六进制 | `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"`，且播种与运行必须用同一把 |
| 发布多供应商那一版后，界面一进来就报「无法连接到后端服务」 | Postgres 的 `api_config` 缺 `active` / `routingCandidates` 列（`synchronize` 关着且没有迁移目录），TypeORM 按实体拼 SELECT 就报「列不存在」，`GET /api/config` 整条挂掉 | 跑 README「生产库结构变更」第 3 条那三句 DDL；建唯一索引前先按里面那条 SELECT 查重，存量库有同家两行时索引建不起来 |

## 验收命令（可直接复制）

本地两条命令就能把「静态 + 协议」两层全看完：

```bash
npm run verify        # typecheck / build:api / eval(79) / lint / build:frontend，三路并行，约 4s
                      # lint 只报不判：那条既有的 react-hooks 报错照旧打出来，但不影响退出码；要卡它跑 npm run lint
npm run verify:live   # build:api 后起假上游 + 临时库 + 真后端，跑 49 项协议断言，约 5s
                      # 只想看某一组：npm run verify:live -- --only=chat-core|chat-memory|chat-memory-off|config
```

线上现状用 curl 看：

```bash
B=https://lucky-lxy-d1g5yv28gd1a13d29.service.tcloudbase.com/api
curl -s $B/health | head -c 400      # auth: disabled / promptVersion: 2026.11.4 / encryption: enabled
                                     # 发布模型路由后会多出 modelRouting / modelCandidates，发布长期记忆后会多出 memory / memoryTable / memoryLimits，发布多供应商后会多出 providers；现在都没有=这三项未上线
curl -s $B/auth/mode                 # 免登录身份
curl -s $B/config                    # 未配 Key 时 {"configured":false}；发布多供应商后是 {configured, active, items[]}，每家一项且只有 active 那一份 active=true
curl -s -o /dev/null -w "%{http_code}\n" $B/memories   # 现在是 404（该接口未发布）；发布后返回 {"items":[...],"limits":{...}}
curl -s $B/tasks/meta/kinds          # runnerEnabled: false + 可提交的任务类型
curl -s $B/conversations             # 免登录返回当前身份名下会话
```

相关文档：功能与实现对照见 `PRD.md`，能力边界见 `AGENT_CAPABILITIES.md`，架构与取舍见 `TECH_DESIGN.md`，部署步骤见 `README.md`「云端部署」。
