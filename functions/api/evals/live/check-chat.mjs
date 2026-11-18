/**
 * 对话链路的协议级断言：模型路由、断线续传、工具事件、长期记忆、切家换凭据。
 *
 * 这些都必须起真后端才验得到——离线评测拿的是纯函数与注册表，看不到 SSE 的实际切分，
 * 也看不到「上游一共收到几次请求」。上游日志是这里唯一的证人：
 * 续传到底重发了几次、用的哪个档位、切家后带的是哪把 Key，只有它能证明。
 *
 * --suite=core      路由 / 续传 / 工具 / 401 / 切家（默认）
 * --suite=memory    长期记忆开与关
 */
import fs from 'node:fs'
import {
  FAKE_KEYS,
  UPSTREAM_PATHS,
  api,
  contentOf,
  createSuite,
  eventsOfKind,
  parseArgs,
  sse,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const base = String(args.base)
const logPath = String(args.log)
const suiteName = String(args.suite ?? 'core')
if (!base || !logPath) {
  console.error('用法：node check-chat.mjs --base=http://127.0.0.1:4101/api --log=<上游日志> [--suite=core|memory]')
  process.exit(2)
}

function logEntries() {
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function entriesWith(fragment) {
  return logEntries().filter((entry) => String(entry.question).includes(fragment))
}

async function newConversation() {
  const res = await api('POST', `${base}/conversations`)
  if (!ok(res.status)) {
    throw new Error(`建会话失败 HTTP ${res.status}：${res.text.slice(0, 120)}`)
  }
  return res.json.id
}

async function ask(conversationId, content) {
  return sse(`${base}/chat`, { conversationId, content })
}

function modelOf(result) {
  const events = eventsOfKind(result.events, 'model')
  return events[0]?.model ?? null
}

function toolEvents(result) {
  return eventsOfKind(result.events, 'tool').map((event) => event.tool)
}

function errorsOf(result) {
  return eventsOfKind(result.events, 'error').map((event) => event.error)
}

async function messagesOf(conversationId) {
  const res = await api('GET', `${base}/conversations/${conversationId}`)
  return res.json?.messages ?? []
}

const SHORT = '你好，用一句话介绍杭州'
const COMPLEX = '请仔细分析这段代码的性能问题并给出优化方案：def solve(n): return n * n'

const suite = createSuite(`live:chat-${suiteName}`)

/** Nest 的 POST 默认 201、DELETE 默认 200，逐处写死状态码会把正常响应读成失败 */
const ok = (status) => status >= 200 && status < 300

if (suiteName === 'core') {
  await suite.check('短问题落最低档且以 data: [DONE] 收尾', async () => {
    const conv = await newConversation()
    const result = await ask(conv, SHORT)
    if (!result.sawDone) {
      return '没收到 [DONE]'
    }
    const model = modelOf(result)
    if (!model) {
      return `没有 model 事件：${JSON.stringify(result.events[0] ?? null)}`
    }
    return model.id === 'test-flash' ? true : `档位是 ${model.id}，应为 test-flash`
  })

  await suite.check('model 事件是本轮第一个事件', async () => {
    const conv = await newConversation()
    const result = await ask(conv, SHORT)
    const first = result.events[0]
    return first && first.model ? true : `首个事件是 ${JSON.stringify(first)}`
  })

  await suite.check('复杂问题升档并把实际模型落库', async () => {
    const conv = await newConversation()
    const result = await ask(conv, COMPLEX)
    const model = modelOf(result)
    if (model?.id !== 'test-pro') {
      return `档位是 ${model?.id}，应为 test-pro（理由：${model?.reason}）`
    }
    const stored = (await messagesOf(conv)).filter((m) => m.role === 'assistant')
    if (stored.length !== 1) {
      return `assistant 应有 1 条，实得 ${stored.length}`
    }
    return stored[0].model === 'test-pro'
      ? true
      : `落库 model 是 ${stored[0].model}，刷新后界面就认不出是谁答的`
  })

  await suite.check('SSE 增量拼起来逐字等于落库正文', async () => {
    const conv = await newConversation()
    const result = await ask(conv, SHORT)
    const stored = (await messagesOf(conv)).find((m) => m.role === 'assistant')
    const streamed = contentOf(result.events)
    return streamed && streamed === stored?.content
      ? true
      : `流式「${streamed}」≠ 落库「${stored?.content}」`
  })

  await suite.check('工具轮：calling 带 args、终态带 result', async () => {
    const conv = await newConversation()
    const result = await ask(conv, `算一下 [[calc:12345*6789]]`)
    const events = toolEvents(result)
    if (events.length < 2) {
      return `工具事件只有 ${events.length} 条`
    }
    const calling = events.find((tool) => tool.status === 'calling')
    const done = events.find((tool) => tool.status === 'done')
    if (!calling?.args?.expression) {
      return `calling 没带 args：${JSON.stringify(calling)}`
    }
    if (!done?.result?.includes(' = ')) {
      return `终态 result 不像计算结果：${done?.result}`
    }
    return calling.id && calling.id === done.id ? true : 'calling 与 done 的 tool_call_id 不一致'
  })

  await suite.check('一轮内两个工具各归各卡（id 不同且都到终态）', async () => {
    const conv = await newConversation()
    const result = await ask(conv, `分别算 [[calc:11*11]] 和 [[calc:22*22]]`)
    const events = toolEvents(result)
    const ids = new Set(events.map((tool) => tool.id))
    if (ids.size !== 2) {
      return `只见到 ${ids.size} 个 tool_call_id：${[...ids].join(',')}`
    }
    const terminals = events.filter((tool) => tool.status === 'done' || tool.status === 'error')
    return new Set(terminals.map((tool) => tool.id)).size === 2
      ? true
      : `终态不齐：${JSON.stringify(terminals.map((t) => [t.id, t.status]))}`
  })

  await suite.check('每个工具事件都带 id 与 name（漏一个界面就会画到同一张卡）', async () => {
    const conv = await newConversation()
    const result = await ask(conv, `分别算 [[calc:2+3]] 和 [[calc:4+5]]`)
    const bad = toolEvents(result).filter((tool) => !tool.id || !tool.name)
    return bad.length === 0 ? true : JSON.stringify(bad[0])
  })

  await suite.check('SSRF：抓内网地址的工具结果是错误而不是页面', async () => {
    const conv = await newConversation()
    const result = await ask(conv, `抓一下 [[fetch:${base.replace('/api', '')}/health]]`)
    const terminal = toolEvents(result).find((tool) => tool.status === 'done' || tool.status === 'error')
    if (!terminal) {
      return '没有工具终态'
    }
    if (terminal.status !== 'error') {
      return `居然成功了：${String(terminal.result).slice(0, 80)}`
    }
    return String(terminal.result).includes('内网')
      ? true
      : `错误文案没提内网：${terminal.result}`
  })

  await suite.check('工具失败不打断整轮：正文照样落地', async () => {
    const conv = await newConversation()
    const result = await ask(conv, `抓一下 [[fetch:http://169.254.169.254/latest/meta-data/]]`)
    const text = contentOf(result.events)
    return result.sawDone && text.includes('工具结果')
      ? true
      : `收尾异常：done=${result.sawDone} 正文=「${text}」错误=${JSON.stringify(errorsOf(result))}`
  })

  await suite.check('上游被掐断：已生成的半截照样落库且不谎报完成', async () => {
    const conv = await newConversation()
    const result = await ask(conv, `${COMPLEX} [[cut]]`)
    if (result.sawDone) {
      return '被掐断的连接不该出现 [DONE]'
    }
    const errors = eventsOfKind(result.events, 'error').map((event) => event.error)
    if (errors.length === 0) {
      return '没收到 error 事件'
    }
    const stored = (await messagesOf(conv)).find((m) => m.role === 'assistant')
    return stored?.content?.includes('前半段') ? true : `半截没入库：${stored?.content}`
  })

  await suite.check('续传：只补后半段并合成一条，且沿用中断那一轮的档位', async () => {
    const question = `${COMPLEX} [[cut]] 续传核对`
    const conv = await newConversation()
    const first = await ask(conv, question)
    const partial = contentOf(first.events)
    if (!partial) {
      return '前半段为空，续传无从谈起'
    }
    const resumed = await sse(`${base}/chat/resume`, { conversationId: conv, content: question, partial })
    if (!resumed.sawDone) {
      return `续传没收尾：${JSON.stringify(errorsOf(resumed))}`
    }
    const model = modelOf(resumed)
    if (model?.id !== 'test-pro') {
      return `续传换了档位：${model?.id}`
    }
    const history = await messagesOf(conv)
    const assistants = history.filter((m) => m.role === 'assistant')
    if (assistants.length !== 1) {
      return `会话里有 ${assistants.length} 条 assistant，应只有 1 条`
    }
    const full = assistants[0].content
    if (!full.startsWith(partial)) {
      return `完整回答不是从前半段开始的：${full.slice(0, 40)}…`
    }
    const attempts = entriesWith('[[cut]] 续传核对')
    if (attempts.length !== 2) {
      return `上游收到 ${attempts.length} 次请求（应 2 次：首发 + 续传）`
    }
    return attempts.every((entry) => entry.model === 'test-pro')
      ? true
      : `上游档位序列 ${attempts.map((entry) => entry.model).join('→')}，前后半段换了模型`
  })

  await suite.check('上游 401：判死且不会被自动重连再烧一次额度', async () => {
    const question = '随便说一句 [[401]] 判死核对'
    const conv = await newConversation()
    const result = await ask(conv, question)
    const errorEvents = eventsOfKind(result.events, 'error')
    if (errorEvents.length === 0) {
      return '没有 error 事件'
    }
    if (errorEvents[0].retryable === true) {
      return '401 被判成可重连，浏览器会再烧一次额度'
    }
    const attempts = entriesWith('[[401]] 判死核对')
    return attempts.length === 1 ? true : `上游收到 ${attempts.length} 次请求`
  })

  await suite.check('切到智谱：请求走它那家的路径、带它那把 Key、用它那一份候选', async () => {
    const activated = await api('POST', `${base}/config/zhipu/activate`)
    if (!ok(activated.status)) {
      return `切换失败 HTTP ${activated.status}：${activated.text.slice(0, 120)}`
    }
    const conv = await newConversation()
    await ask(conv, '你好，用一句话介绍苏州')
    const entry = logEntries().at(-1)
    if (entry?.path !== UPSTREAM_PATHS.zhipu) {
      return `打到的是 ${entry?.path}，baseUrl 的路径没生效`
    }
    if (entry.authTail !== FAKE_KEYS.zhipu.slice(-4)) {
      return `带的 Key 尾 4 位是 ${entry.authTail}，不是智谱那把`
    }
    return entry.model === 'glm-air' ? true : `档位是 ${entry.model}，候选没跟着配置走`
  })

  await suite.check('切回 DeepSeek 后一切照旧（不留半切换状态）', async () => {
    await api('POST', `${base}/config/deepseek/activate`)
    const conv = await newConversation()
    await ask(conv, SHORT)
    const entry = logEntries().at(-1)
    if (entry?.path !== UPSTREAM_PATHS.deepseek) {
      return `打到的是 ${entry?.path}`
    }
    return entry.authTail === FAKE_KEYS.deepseek.slice(-4)
      ? true
      : `带的 Key 尾 4 位是 ${entry.authTail}`
  })
}

if (suiteName === 'memory') {
  const memories = async () => (await api('GET', `${base}/memories`)).json

  await suite.check('开局清单是空的', async () => {
    const envelope = await memories()
    return envelope?.items?.length === 0 ? true : JSON.stringify(envelope)?.slice(0, 160)
  })

  await suite.check('remember 工具终态给出 8 位编号', async () => {
    const conv = await newConversation()
    const result = await ask(conv, '记一下 [[remember:以后所有回答都用中文]]')
    const terminal = toolEvents(result).find((tool) => tool.status === 'done')
    if (!terminal) {
      return `没有 done 终态：${JSON.stringify(toolEvents(result))}`
    }
    if (!/已记住（编号 [0-9a-f]{8}）/.test(String(terminal.result))) {
      return `终态文案不对：${terminal.result}`
    }
    const envelope = await memories()
    return envelope.items.length === 1 ? true : `清单里有 ${envelope.items.length} 条`
  })

  await suite.check('新会话不带历史也能看见这条记忆（注入的是 system 段）', async () => {
    const conv = await newConversation()
    await ask(conv, '我现在这个项目用什么语言回答')
    const entry = logEntries().at(-1)
    const systems = (entry?.systems ?? []).join('\n')
    if (!systems.includes('以后所有回答都用中文')) {
      return `system 段里没有它：${systems.slice(0, 200)}`
    }
    const userMessages = (entry?.question ?? '').length
    return userMessages > 0 ? true : '提问没带过去'
  })

  await suite.check('同一事实重复记只留一条', async () => {
    const conv = await newConversation()
    await ask(conv, '记一下 [[remember:以后所有回答都用中文]]')
    const envelope = await memories()
    return envelope.items.length === 1 ? true : `变成 ${envelope.items.length} 条`
  })

  await suite.check('面板手写一条：来源是 user', async () => {
    const res = await api('POST', `${base}/memories`, { content: '我习惯深色主题' })
    if (!ok(res.status)) {
      return `HTTP ${res.status}：${res.text.slice(0, 120)}`
    }
    const manual = res.json.items.find((item) => item.content === '我习惯深色主题')
    return manual?.source === 'user' ? true : `来源是 ${manual?.source}`
  })

  await suite.check('forget 只写编号前 3 位也认（唯一前缀）', async () => {
    const envelope = await memories()
    const target = envelope.items.find((item) => item.content === '我习惯深色主题')
    if (!target) {
      return '找不到那条手写记忆'
    }
    const conv = await newConversation()
    const result = await ask(conv, `忘掉那条 [[forget:${target.handle.slice(0, 3)}]]`)
    const terminal = toolEvents(result).find((tool) => tool.status === 'done')
    if (!terminal) {
      return `终态不是 done：${JSON.stringify(toolEvents(result).map((t) => [t.status, t.result]))}`
    }
    const after = await memories()
    return after.items.length === 1 ? true : `剩下 ${after.items.length} 条`
  })

  await suite.check('编号不存在时如实说没有，而不是猜一条删掉', async () => {
    const conv = await newConversation()
    const result = await ask(conv, '忘掉 [[forget:zzzzzzzz]]')
    const terminal = toolEvents(result).find((tool) => tool.status === 'done' || tool.status === 'error')
    if (!String(terminal?.result).includes('没有编号')) {
      return `文案是「${terminal?.result}」`
    }
    const after = await memories()
    return after.items.length === 1 ? true : '误删了别的条目'
  })

  await suite.check('面板删除与模型删除走同一条路径', async () => {
    const envelope = await memories()
    const id = envelope.items[0].id
    const res = await api('DELETE', `${base}/memories/${id}`)
    if (!ok(res.status)) {
      return `HTTP ${res.status}：${res.text.slice(0, 120)}`
    }
    const after = await memories()
    return after.items.length === 0 ? true : `还剩 ${after.items.length} 条`
  })
}

if (suiteName === 'memory-off') {
  await suite.check('关掉后健康检查报 disabled', async () => {
    const health = (await api('GET', `${base}/health`)).json
    return health.memory === 'disabled' ? true : `memory=${health.memory}`
  })

  await suite.check('关掉后模型这一轮看不到 remember / forget', async () => {
    const conv = await newConversation()
    await ask(conv, '记一下 [[remember:关掉时不该记的东西]]')
    const entry = entriesWith('关掉时不该记').at(-1)
    const names = entry?.toolNames ?? []
    return names.includes('remember') || names.includes('forget')
      ? `工具清单里还有：${names.join(',')}`
      : true
  })

  await suite.check('模型硬调 remember 也被挡下，且不打断整轮', async () => {
    const conv = await newConversation()
    const result = await ask(conv, '记一下 [[remember:关掉时硬调]]')
    const terminal = toolEvents(result).find((tool) => tool.status === 'done' || tool.status === 'error')
    if (!String(terminal?.result).includes('未启用')) {
      return `工具回话是「${terminal?.result}」`
    }
    const envelope = (await api('GET', `${base}/memories`)).json
    return result.sawDone && envelope.items.length === 0
      ? true
      : `收尾异常 done=${result.sawDone} 条数=${envelope.items?.length}`
  })
}

const summary = suite.report()
process.exit(summary.failed > 0 ? 1 : 0)
