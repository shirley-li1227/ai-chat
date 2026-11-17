#!/usr/bin/env node
/**
 * 提示词与工具能力的回归集运行器。
 *
 * 为什么要单独做一个评测脚本：
 * 提示词改一个字，工具命中率就可能变。没有可重跑的断言，"我优化了提示词"
 * 就只是主观感受；有了它，PROMPT_VERSION 的升降级才对应可比较的通过率数字。
 *
 * 两种模式：
 *   离线（默认）  不需要网络、不需要 API Key。直接调用编译产物里的 executeTool，
 *                断言工具自身的计算/护栏行为，外加提示词版本一致性、窗口裁剪语义、
 *                并发上限、断点续传上下文、模型路由分档这几类纯本地不变量。适合每次改完代码就跑。
 *   在线（--online）读取 EVAL_API_KEY 等环境变量，用非流式请求让模型自己选工具，
 *                断言 expectTool 命中率。这会真实消耗 token，只在改提示词后跑。
 *
 * 前置：离线与在线都依赖 dist/，请先 npm run build（package.json 的 eval 脚本已串好）。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const evalsDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(evalsDir, '..', 'dist')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valOf = (flag, fallback) => {
  const hit = args.find((a) => a.startsWith(`${flag}=`))
  return hit ? hit.slice(flag.length + 1) : fallback
}

const ONLINE = has('--online')
const MIN_ACCURACY = Number(valOf('--min-accuracy', '0.8'))
const CATEGORY = valOf('--category', null)
const CONcurrency = Math.max(1, Number(valOf('--concurrency', '2')))

// ---------------------------------------------------------------- 断言微框架

const results = []
const pending = []
let currentSuite = 'suite'
let order = 0
/**
 * 断言串成一条链再跑。多个开关都从 process.env 读，而 env 是整进程共享的：
 * 并发时一条断言临时改的值会被另一条读到（或在它 await 期间被改回去），
 * 表现为“单独跑绿、一起跑红”的假故障。串行执行让这类干扰不可能发生。
 */
let chain = Promise.resolve()

function suite(name) {
  currentSuite = name
}

/**
 * 断言登记器：回调可以是同步或异步。
 * 必须把返回的 Promise 收起来统一 await，否则 async 断言 reject 只会变成
 * 无人处理的拒绝，脚本依旧报“全部通过”——这是评测脚本最危险的失败方式。
 */
function check(title, fn) {
  const record = { suite: currentSuite, title, pass: false, note: '', order: order++ }
  chain = chain.then(() =>
    Promise.resolve()
      .then(fn)
      .then((note) => {
        record.pass = true
        record.note = note === undefined ? '' : String(note)
      })
      .catch((error) => {
        record.pass = false
        record.note = (error && error.message) || String(error)
      })
      .finally(() => {
        results.push(record)
      }),
  )
  pending.push(chain)
  return record
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

/** 断言文本含子串或匹配正则，返回可读的实际内容片段 */
function matchText(actual, expectedIncludes, expectedPattern) {
  if (expectedIncludes) {
    assert(
      actual.includes(expectedIncludes),
      `期望包含 "${expectedIncludes}"，实际：${truncate(actual)}`,
    )
  }
  if (expectedPattern) {
    const re = new RegExp(expectedPattern)
    assert(
      re.test(actual),
      `期望匹配 /${expectedPattern}/，实际：${truncate(actual)}`,
    )
  }
}

function truncate(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine
}

// ---------------------------------------------------------------- 加载编译产物

function loadDist(relative) {
  const file = path.join(distDir, relative)
  if (!existsSync(file)) {
    throw new Error(
      `找不到编译产物 ${relative}，请先执行 npm run build 再跑评测（或直接用 npm run eval）`,
    )
  }
  return require(file)
}

let prompt
let tools
let estimator
let runner
let llmClient
let taskPolicy
let taskRegistry
let authMode
let continuation
let modelRouter

try {
  prompt = loadDist('chat/prompt.js')
  tools = loadDist('agent/tools.js')
  estimator = loadDist('chat/token-estimator.js')
  runner = loadDist('agent/tool-runner.js')
  llmClient = loadDist('chat/llm-client.js')
  // 队列策略与任务注册表都不依赖 Nest 容器，可以直接按纯函数断言
  taskPolicy = loadDist('tasks/task-policy.js')
  taskRegistry = loadDist('tasks/task-registry.js')
  authMode = loadDist('auth/auth-mode.js')
  continuation = loadDist('chat/continuation.js')
  modelRouter = loadDist('chat/model-router.js')
} catch (error) {
  console.error(`[evals] ${error.message}`)
  process.exit(1)
}

const suiteFile = path.join(evalsDir, 'cases.json')
if (!existsSync(suiteFile)) {
  console.error('[evals] 缺少 evals/cases.json')
  process.exit(1)
}
const spec = JSON.parse(readFileSync(suiteFile, 'utf8'))
const cases = CATEGORY
  ? spec.cases.filter((c) => c.category === CATEGORY)
  : spec.cases

// ---------------------------------------------------------------- 离线：提示词

suite('prompt')

check('PROMPT_VERSION 与 cases.json 钉住的版本一致', () => {
  assert(
    typeof prompt.PROMPT_VERSION === 'string' && prompt.PROMPT_VERSION.length > 0,
    'PROMPT_VERSION 未导出或为空',
  )
  assert(
    prompt.PROMPT_VERSION === spec.promptVersion,
    `提示词已是 ${prompt.PROMPT_VERSION}，评测集仍钉在 ${spec.promptVersion}：` +
      `确认改动符合预期后，把 cases.json 的 promptVersion 一起升上来`,
  )
  return prompt.PROMPT_VERSION
})

check('提示词保留三段必备结构（工具准则 / few-shot / 输出格式）', () => {
  for (const section of ['工具使用准则', '工具判定示例', '输出格式规范']) {
    assert(
      prompt.SYSTEM_PROMPT.includes(section),
      `SYSTEM_PROMPT 缺少「${section}」段落`,
    )
  }
  return '3/3'
})

check('注册的工具与提示词声明的工具完全对齐', () => {
  const registered = tools.TOOL_DEFINITIONS.map((t) => t.function.name).sort()
  assert(registered.length > 0, 'TOOL_DEFINITIONS 为空')
  for (const name of registered) {
    assert(
      prompt.SYSTEM_PROMPT.includes(name),
      `工具 ${name} 已注册但提示词未提及，模型不会主动选它`,
    )
  }
  // 反向：提示词里提到的工具必须真的存在，否则模型会调一个不存在的函数
  for (const name of ['calculator', 'get_current_time', 'fetch_url']) {
    assert(
      registered.includes(name),
      `提示词提到 ${name} 但 TOOL_DEFINITIONS 里没有对应注册`,
    )
  }
  return registered.join(', ')
})

check('每个工具都有非空 description 与 parameters', () => {
  for (const tool of tools.TOOL_DEFINITIONS) {
    const { name, description, parameters } = tool.function
    assert(description && description.length > 20, `${name} 的 description 过短`)
    assert(parameters && parameters.type === 'object', `${name} 的 parameters 结构不对`)
  }
  return `${tools.TOOL_DEFINITIONS.length} 个`
})

check('摘要提示词独立存在且禁止续写', () => {
  assert(prompt.SUMMARY_PROMPT && prompt.SUMMARY_PROMPT.length > 0, 'SUMMARY_PROMPT 为空')
  matchText(prompt.SUMMARY_PROMPT, '不要续写对话')
  return `${prompt.SUMMARY_PROMPT.length} 字`
})

// ---------------------------------------------------------------- 离线：工具行为

suite('tool-behavior')

for (const item of cases) {
  if (!item.offline || item.offline.kind === 'none') {
    continue
  }
  check(`${item.id} ${item.expectTool}(${truncate(JSON.stringify(item.toolArgs ?? {}))})`, async () => {
    const result = await tools.executeTool(item.expectTool, item.toolArgs ?? {})
    const text = String(result.output ?? '')
    if (item.offline.kind === 'output') {
      assert(result.ok === true, `期望成功，实际 ok=false：${truncate(text)}`)
      matchText(text, item.offline.expectIncludes, item.offline.expectPattern)
    } else {
      assert(result.ok === false, `期望失败，实际 ok=true：${truncate(text)}`)
      matchText(text, item.offline.expectIncludes, item.offline.expectPattern)
    }
    return truncate(text)
  })
}

check('未知工具名返回错误而不是抛异常', async () => {
  const r = await tools.executeTool('no_such_tool', {})
  assert(r.ok === false, `未知工具竟然成功：${truncate(r.output)}`)
  matchText(String(r.output), '未知工具')
  return truncate(r.output)
})

check('空参数调用 calculator 不会抛异常', async () => {
  const r = await tools.executeTool('calculator', {})
  assert(r.ok === false, '缺参数应当失败')
  matchText(String(r.output), '不能为空')
  return truncate(r.output)
})

// ---------------------------------------------------------------- 离线：上下文窗口

suite('context-window')

check('token 估算口径：CJK 每字 1，拉丁每 4 字符 1', () => {
  assert(estimator.estimateTokens('') === 0, '空串应为 0')
  assert(estimator.estimateTokens('中文测试') === 4, `中文 4 字应估 4，实际 ${estimator.estimateTokens('中文测试')}`)
  assert(estimator.estimateTokens('aaaaaaaa') === 2, `8 个拉丁字符应估 2，实际 ${estimator.estimateTokens('aaaaaaaa')}`)
  return 'ok'
})

check('预算充足时不裁剪', () => {
  const msgs = [
    { role: 'user', content: '第一问', toolCalls: null },
    { role: 'assistant', content: '第一答', toolCalls: null },
    { role: 'user', content: '第二问', toolCalls: null },
  ]
  const plan = estimator.planWindow(msgs, 5000)
  assert(plan.dropped.length === 0, `不该裁剪却丢了 ${plan.dropped.length} 条`)
  assert(plan.kept.length === msgs.length, '保留数量不对')
  assert(plan.keptTokens > 0, 'keptTokens 未累计')
  return `kept=${plan.kept.length}, tokens=${plan.keptTokens}`
})

check('超预算时从最旧开始丢，保留的是最新后缀', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${i + 1} 条消息，用于占位以触发窗口裁剪。`,
    toolCalls: null,
  }))
  const single = estimator.estimateMessageTokens(msgs[0])
  const plan = estimator.planWindow(msgs, Math.round(single * 2.5))
  assert(plan.dropped.length > 0, `预算 ${Math.round(single * 2.5)} 应当触发裁剪`)
  assert(
    plan.kept.every((m, idx) => m === msgs[msgs.length - plan.kept.length + idx]),
    'kept 不是原列表的连续后缀，窗口顺序被破坏',
  )
  assert(
    plan.dropped.every((m, idx) => m === msgs[idx]),
    'dropped 不是最旧的连续前缀',
  )
  assert(plan.kept.length + plan.dropped.length === msgs.length, '总数不守恒')
  return `kept=${plan.kept.length}, dropped=${plan.dropped.length}`
})

check('最新一条永远保留，哪怕它单独就超预算', () => {
  const huge = {
    role: 'user',
    content: '这'.repeat(20000),
    toolCalls: null,
  }
  const plan = estimator.planWindow([huge], 10)
  assert(plan.kept.length === 1, '最新一条被丢掉了，本轮请求将没有用户问题')
  assert(plan.dropped.length === 0, '不该产生摘要源')
  return `budget=10, kept=${plan.keptTokens} tokens`
})

check('工具轨迹要计入消息开销', () => {
  const bare = { role: 'assistant', content: '同样的正文', toolCalls: null }
  const withCalls = {
    role: 'assistant',
    content: '同样的正文',
    toolCalls: JSON.stringify([
      { id: 'a', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } },
      { id: 'b', function: { name: 'get_current_time', arguments: '{}' } },
      { id: 'c', function: { name: 'fetch_url', arguments: '{"url":"https://example.com"}' } },
    ]),
  }
  const diff =
    estimator.estimateMessageTokens(withCalls) - estimator.estimateMessageTokens(bare)
  assert(diff > 0, `带轨迹的消息没有更贵（diff=${diff}）`)
  return `轨迹额外 ${diff} tokens`
})

// ---------------------------------------------------------------- 离线：并发执行器

suite('tool-concurrency')

check('并发度封顶、结果保序、单个失败不影响整体', async () => {
  const items = Array.from({ length: 8 }, (_, i) => i)
  let inFlight = 0
  let peak = 0
  const limit = 3

  const settled = await runner.runWithConcurrency(items, limit, async (n) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10 + (n % 3) * 15))
    inFlight -= 1
    if (n === 4) {
      throw new Error('模拟失败')
    }
    return n * 10
  })

  assert(settled.length === items.length, `结果数量 ${settled.length} != 任务数 ${items.length}`)
  assert(peak <= limit, `并发峰值 ${peak} 超过上限 ${limit}`)
  assert(
    settled.every((r, i) => (i === 4 ? !r.ok : r.ok && r.value === i * 10)),
    '结果顺序错位或错误未隔离',
  )
  assert(
    settled[4].ok === false && settled[4].reason instanceof Error,
    '失败项没有保留原始 reason',
  )
  return `peak=${peak}/${limit}, 失败 1 项已隔离`
})

check('空任务集返回空数组', () => {
  return runner
    .runWithConcurrency([], 4, async () => 1)
    .then((r) => {
      assert(Array.isArray(r) && r.length === 0, '空输入应得到空输出')
      return 'ok'
    })
})

check('baseUrl 归一化兼容三种填法', () => {
  const cases = [
    ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions'],
  ]
  for (const [input, expected] of cases) {
    const actual = llmClient.resolveCompletionsUrl(input)
    assert(actual === expected, `${input} -> ${actual}，期望 ${expected}`)
  }
  return `${cases.length} 种`
})

// ---------------------------------------------------------------- 离线：工具注册表

suite('tool-registry')

/** 断言期间要改环境变量（后台能力开关），用完必须还原，否则会污染同进程后续用例 */
async function withEnv(overrides, fn) {
  const saved = {}
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key]
    if (overrides[key] === undefined) delete process.env[key]
    else process.env[key] = String(overrides[key])
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

check('注册表条目齐备：唯一名字、说明、参数声明、可执行 handler', () => {
  const names = tools.TOOL_REGISTRY.map((spec) => spec.name)
  assert(new Set(names).size === names.length, `工具名重复：${names.join(', ')}`)
  for (const spec of tools.TOOL_REGISTRY) {
    assert(spec.description && spec.description.length > 20, `${spec.name} 的 description 过短`)
    assert(typeof spec.run === 'function', `${spec.name} 没有 run handler`)
    assert(typeof spec.background === 'boolean', `${spec.name} 未显式声明 background`)
    assert(spec.args && typeof spec.args === 'object', `${spec.name} 缺少 args 声明`)
    for (const [key, arg] of Object.entries(spec.args)) {
      assert(arg.description, `${spec.name}.${key} 缺少给模型看的说明`)
      assert(
        ['string', 'number', 'boolean', 'object'].includes(arg.type),
        `${spec.name}.${key} 的类型 ${arg.type} 不受支持`,
      )
    }
  }
  return `${names.length} 个：${names.join(', ')}`
})

check('后台能力关闭时不广播 run_in_background，开启后才出现', () => {
  const disabled = tools.TOOL_DEFINITIONS.map((t) => t.function.name)
  assert(
    !disabled.includes('run_in_background'),
    '默认工具集里出现了 run_in_background：没有执行器时模型会提交一堆永远排队的任务',
  )
  const enabled = tools.buildToolDefinitions({ backgroundEnabled: true })
  const names = enabled.map((t) => t.function.name)
  assert(names.includes('run_in_background'), '开启后台能力后仍没有广播 run_in_background')
  assert(
    disabled.every((name) => names.includes(name)),
    `开启后台能力后已有工具消失了：${disabled.filter((n) => !names.includes(n)).join(', ')}`,
  )
  assert(
    names.filter((name) => !disabled.includes(name)).join(',') === 'run_in_background',
    `开关只该影响 run_in_background，实际多出：${names.filter((n) => !disabled.includes(n)).join(', ')}`,
  )
  const bg = enabled.find((t) => t.function.name === 'run_in_background')
  const enumInSchema = JSON.stringify(bg.function.parameters.properties.name.enum ?? null)
  assert(
    enumInSchema === JSON.stringify(tools.backgroundableToolNames()),
    `run_in_background 的参数枚举与可后台名单不一致：${enumInSchema}`,
  )
  // 提示词必须提到它，否则模型即使拿到 schema 也不知道什么时候该用
  assert(prompt.SYSTEM_PROMPT.includes('run_in_background'), '提示词未说明 run_in_background 的用法')
  return `${disabled.length} → ${names.length}`
})

check('参数校验一次说清缺参、错型、多参与超长', () => {
  const fetch = tools.findToolSpec('fetch_url')
  const calc = tools.findToolSpec('calculator')
  matchText(tools.validateToolArgs(fetch, {}), '不能为空')
  matchText(tools.validateToolArgs(fetch, { url: 'https://a.com', extra: 1 }), '不认识的参数')
  matchText(tools.validateToolArgs(fetch, { url: ['https://a.com'] }), '应为')
  matchText(tools.validateToolArgs(fetch, { url: 'x'.repeat(2001) }), '超过 2000 字上限')
  matchText(tools.validateToolArgs(fetch, 'https://a.com'), '必须是一个 JSON 对象')
  assert(tools.validateToolArgs(calc, { expression: '1+1' }) === null, '合法参数应通过校验')
  const runBg = tools.findToolSpec('run_in_background')
  matchText(tools.validateToolArgs(runBg, { name: 'calculator', arguments: {} }), '只能是')
  assert(
    tools.validateToolArgs(runBg, { name: 'fetch_url', arguments: { url: 'https://a.com' } }) === null,
    '合法的后台提交参数应通过校验',
  )
  return '7 条负例 + 2 条正例'
})

check('run_in_background：无执行器时明确拒绝，有执行器时只回任务编号', async () => {
  // 关闭开关：连参数都不该校验到后面去，直接说明功能未启用
  const off = await tools.executeTool('run_in_background', {
    name: 'fetch_url',
    arguments: { url: 'https://example.com' },
  })
  assert(off.ok === false, '后台能力关闭时不该成功')
  matchText(off.output, '未启用')

  await withEnv({ BACKGROUND_TASKS_ENABLED: 'true' }, async () => {
    const noRunner = await tools.executeTool('run_in_background', {
      name: 'fetch_url',
      arguments: { url: 'https://example.com' },
    })
    assert(noRunner.ok === false, '缺少 enqueueBackground 时不该成功')
    matchText(noRunner.output, '执行器未启用')

    let submitted = null
    const ok = await tools.executeTool(
      'run_in_background',
      { name: 'fetch_url', arguments: { url: 'https://example.com' } },
      {
        enqueueBackground: async (name, args) => {
          submitted = { name, args }
          return { id: 'task-abc' }
        },
      },
    )
    assert(ok.ok === true, `提交本应成功，实际：${truncate(ok.output)}`)
    matchText(ok.output, 'task-abc')
    // 关键：只回任务编号，模型不能据此假装已经抓到内容
    matchText(ok.output, '本轮回答里还没有它')
    assert(submitted.name === 'fetch_url' && submitted.args.url === 'https://example.com', '入队参数走样')

    const badInner = await tools.executeTool('run_in_background', { name: 'fetch_url', arguments: {} })
    assert(badInner.ok === false, '内层工具缺参时不该提交任务')
    matchText(badInner.output, '参数不合法')
  })
  return '关闭/无执行器/成功/内层校验'
})

// ---------------------------------------------------------------- 离线：后台任务队列

suite('background-task')

check('状态机：终态不可再改，取消不能被迟到结果复活', () => {
  assert(taskPolicy.canTransition('queued', 'running'), 'queued → running 应允许')
  assert(taskPolicy.canTransition('running', 'queued'), '租约过期的 running 应能重投')
  assert(taskPolicy.canTransition('running', 'canceled'), 'running 应可被取消')
  for (const terminal of taskPolicy.TERMINAL_STATUSES) {
    for (const to of taskPolicy.TASK_STATUSES) {
      assert(
        !taskPolicy.canTransition(terminal, to),
        `${terminal} 是终态，不该允许流转到 ${to}`,
      )
    }
    assert(taskPolicy.isTerminal(terminal), `${terminal} 应标记为终态`)
  }
  assert(!taskPolicy.canTransition('queued', 'succeeded'), '未执行就成功是脏数据')
  assert(!taskPolicy.isTerminal('running'), 'running 不该是终态')
  return `${taskPolicy.TASK_STATUSES.length} 态`
})

check('可领取判定：退避门未到、租约未过期、终态都不该被领走', () => {
  const now = 1_700_000_000_000
  const claimable = taskPolicy.isClaimable
  assert(claimable({ status: 'queued', attempts: 0, leaseUntil: null, notBefore: null }, now), '排队任务应可领')
  assert(
    !claimable({ status: 'queued', attempts: 1, leaseUntil: null, notBefore: now + 1 }, now),
    '退避期内的任务不该被领走，否则重试变成忙等',
  )
  assert(claimable({ status: 'queued', attempts: 2, leaseUntil: null, notBefore: now }, now), 'notBefore 到期即可领')
  assert(
    !claimable({ status: 'running', attempts: 1, leaseUntil: now + 60_000, notBefore: null }, now),
    '租约未过期的 running 说明还有实例在跑，抢过来会跑两遍',
  )
  assert(claimable({ status: 'running', attempts: 1, leaseUntil: now - 1, notBefore: null }, now), '租约过期应可回收')
  assert(
    !claimable({ status: 'running', attempts: 1, leaseUntil: null, notBefore: null }, now),
    'running 却没有租约时间属于异常状态，宁可不动',
  )
  for (const status of taskPolicy.TERMINAL_STATUSES) {
    assert(
      !claimable({ status, attempts: 0, leaseUntil: null, notBefore: null }, now),
      `${status} 不该再被领取`,
    )
  }
  return '7 组判定'
})

check('失败处理：未到上限重投并退避，到上限或非重试直接终态', async () => {
  await withEnv({ TASK_MAX_ATTEMPTS: '3' }, () => {
    assert(taskPolicy.maxAttempts() === 3, 'TASK_MAX_ATTEMPTS 没生效')
    const now = Date.now()
    const retry = taskPolicy.planFailure(
      { status: 'running', attempts: 1, leaseUntil: null, notBefore: null },
      '上游超时',
      { retryable: true },
    )
    assert(retry.status === 'queued', `应重投为 queued，实际 ${retry.status}`)
    matchText(retry.error, '第 1/3 次尝试失败')
    assert(retry.notBefore > now, '重投必须带退避时间')

    const lastAllowed = taskPolicy.planFailure(
      { status: 'running', attempts: 2, leaseUntil: null, notBefore: null },
      '上游超时',
      { retryable: true },
    )
    assert(lastAllowed.status === 'queued', '第 2 次失败后还该有第 3 次机会')

    const exhausted = taskPolicy.planFailure(
      { status: 'running', attempts: 3, leaseUntil: null, notBefore: null },
      '上游超时',
      { retryable: true },
    )
    assert(exhausted.status === 'failed', '达到上限仍重投会无限循环')
    assert(exhausted.notBefore === null, '终态不该带退避时间')

    const fatal = taskPolicy.planFailure(
      { status: 'running', attempts: 1, leaseUntil: null, notBefore: null },
      '参数不合法',
      { retryable: false },
    )
    assert(fatal.status === 'failed', '未声明可重试的失败应直接终态')
    matchText(fatal.error, '参数不合法')
  })
})

check('退避递增且封顶 5 分钟；超长文本截断留痕', () => {
  const steps = [1, 2, 3, 4, 5, 6, 7].map((n) => taskPolicy.backoffMs(n))
  for (let i = 1; i < steps.length; i += 1) {
    assert(steps[i] >= steps[i - 1], `退避时间不该回退：${steps.join(', ')}`)
  }
  assert(Math.max(...steps) <= 300_000, `退避封顶被突破：${Math.max(...steps)}`)
  const short = taskPolicy.clipText('短内容', 100)
  assert(short === '短内容', '未超限不该改写')
  const long = taskPolicy.clipText('啊'.repeat(30), 10)
  assert(long.startsWith('啊'.repeat(10)), '截断位置不对')
  matchText(long, '已截断')
  matchText(long, '共 30 字')
  return `退避至 ${Math.max(...steps)}ms`
})

check('任务类型注册表与工具注册表口径一致', () => {
  const kind = taskRegistry.findTaskKind(taskRegistry.TOOL_CALL_KIND)
  assert(kind, `缺少 ${taskRegistry.TOOL_CALL_KIND} 类型`)
  assert(taskRegistry.TASK_KINDS.length > 0, 'TASK_KINDS 为空')
  for (const spec of taskRegistry.TASK_KINDS) {
    assert(spec.kind && spec.description, `${spec.kind} 缺少说明`)
    assert(Array.isArray(spec.fields) && spec.fields.length > 0, `${spec.kind} 缺少字段说明`)
    assert(typeof spec.resolve === 'function', `${spec.kind} 缺少 resolve，提交校验与执行会漂移`)
  }
  // 前端表单直接吃 describeTaskKinds，字段必须是可 JSON 序列化的纯数据
  const described = JSON.parse(JSON.stringify(taskRegistry.describeTaskKinds()))
  assert(described[0].fields[0].name === 'name', 'kind 说明字段名走样')
  const names = kind.fields.find((f) => f.name === 'name').enum
  assert(
    JSON.stringify([...names].sort()) === JSON.stringify([...tools.backgroundableToolNames()].sort()),
    `kind 的可用工具与注册表不一致：${names.join(', ')}`,
  )
  for (const name of names) {
    assert(tools.findToolSpec(name)?.background, `${name} 广播可后台执行但自身未声明 background`)
  }
  matchText(taskRegistry.unknownKindError('nope'), 'nope')
  return described.map((d) => d.kind).join(', ')
})

check('resolve 拒绝无人能执行的任务：坏 kind、坏 payload、坏工具、坏参数', () => {
  const resolve = taskRegistry.resolveTaskInvocation
  assert(resolve({ kind: 'nope', payload: {} }).ok === false, '未知 kind 不该解析成功')
  matchText(resolve({ kind: 'nope', payload: {} }).error, '未知的任务类型')
  matchText(resolve({ kind: 'tool_call', payload: '{坏 JSON' }).error, '不是合法 JSON')
  matchText(resolve({ kind: 'tool_call', payload: '[1,2]' }).error, '必须是一个 JSON 对象')
  matchText(resolve({ kind: 'tool_call', payload: { name: '', arguments: {} } }).error, 'name 不能为空')
  matchText(resolve({ kind: 'tool_call', payload: { name: 'ghost', arguments: {} } }).error, '未注册')
  matchText(
    resolve({ kind: 'tool_call', payload: { name: 'calculator', arguments: { expression: '1+1' } } }).error,
    '不适合后台执行',
  )
  matchText(resolve({ kind: 'tool_call', payload: { name: 'fetch_url', arguments: ['a'] } }).error, 'arguments')
  matchText(resolve({ kind: 'tool_call', payload: { name: 'fetch_url', arguments: {} } }).error, '不能为空')
  const ok = resolve({
    kind: 'tool_call',
    payload: JSON.stringify({ name: 'fetch_url', arguments: { url: 'https://example.com' } }),
  })
  assert(ok.ok === true, `合法任务应解析成功，实际：${truncate(ok.error ?? '')}`)
  assert(ok.invocation.type === 'tool' && ok.invocation.name === 'fetch_url', 'invocation 形状不对')
  assert(ok.invocation.args.url === 'https://example.com', 'args 内容丢失')
  return '9 条负例 + 1 条正例'
})

check('队列阈值全部来自环境变量并带下限兜底', async () => {
  await withEnv({}, () => {
    assert(taskPolicy.leaseMs() >= 5000, '租约下限兜底失效')
    assert(taskPolicy.maxAttempts() >= 1, '尝试次数下限兜底失效')
    assert(taskPolicy.claimScanLimit() >= 1, '扫描条数下限兜底失效')
    assert(taskPolicy.payloadMaxBytes() >= 256, 'payload 上限兜底失效')
    assert(taskPolicy.resultMaxChars() >= 200, '结果上限兜底失效')
    assert(taskPolicy.backgroundTasksEnabled() === false, '后台能力默认必须关闭：执行器还没上线')
  })
  await withEnv(
    { TASK_LEASE_MS: '1', TASK_MAX_ATTEMPTS: '0', TASK_PAYLOAD_MAX_BYTES: '1', TASK_RESULT_MAX_CHARS: '1', BACKGROUND_TASKS_ENABLED: 'true' },
    () => {
      assert(taskPolicy.leaseMs() === 5000, '租约过小未夹紧')
      assert(taskPolicy.maxAttempts() === 1, '尝试次数过小未夹紧')
      assert(taskPolicy.payloadMaxBytes() === 256, 'payload 过小未夹紧')
      assert(taskPolicy.resultMaxChars() === 200, '结果过小未夹紧')
      assert(taskPolicy.backgroundTasksEnabled() === true, 'BACKGROUND_TASKS_ENABLED 未生效')
    },
  )
  // 只认字面 'true'，TRUE/1 这类写法不该被当成开启
  await withEnv({ BACKGROUND_TASKS_ENABLED: 'TRUE' }, () => {
    assert(taskPolicy.backgroundTasksEnabled() === false, '开关判定应为严格等于 true')
  })
})

// ---------------------------------------------------------------- 离线：鉴权模式开关

suite('auth-mode')

check('AUTH_ENABLED 缺省即免登录，且只认字面 true', async () => {
  await withEnv({ AUTH_ENABLED: undefined }, () => {
    assert(
      authMode.authEnabled() === false,
      '默认应当是免登录：本地开发不配变量就能直接看既有数据',
    )
  })
  await withEnv({ AUTH_ENABLED: 'true' }, () => {
    assert(authMode.authEnabled() === true, 'AUTH_ENABLED=true 没有打开真实登录')
  })
  for (const value of ['TRUE', 'True', '1', 'yes', ' false']) {
    await withEnv({ AUTH_ENABLED: value }, () => {
      assert(
        authMode.authEnabled() === false,
        `AUTH_ENABLED="${value}" 不该被当成开启（判定必须严格等于 'true'）`,
      )
    })
  }
})

check('免登录开关与后台任务开关互不串线', async () => {
  // 两个开关都是「只认字面 true」，复制粘贴时最容易读错变量名
  await withEnv({ AUTH_ENABLED: 'true', BACKGROUND_TASKS_ENABLED: 'true' }, () => {
    assert(authMode.authEnabled() === true, 'AUTH_ENABLED 读到了别的变量')
    assert(taskPolicy.backgroundTasksEnabled() === true, 'BACKGROUND_TASKS_ENABLED 读到了别的变量')
  })
  await withEnv({ AUTH_ENABLED: 'true', BACKGROUND_TASKS_ENABLED: undefined }, () => {
    assert(taskPolicy.backgroundTasksEnabled() === false, '后台任务开关跟着鉴权开关一起打开了')
  })
  await withEnv({ AUTH_ENABLED: undefined, BACKGROUND_TASKS_ENABLED: 'true' }, () => {
    assert(authMode.authEnabled() === false, '鉴权开关跟着后台任务开关一起打开了')
  })
})

check('兜底演示账号名符合 users.username 的存储约定', () => {
  const name = authMode.DEMO_USERNAME
  assert(typeof name === 'string' && name.length > 0, 'DEMO_USERNAME 为空')
  assert(name === name.trim().toLowerCase(), `DEMO_USERNAME 必须小写无空格：${name}`)
  // 实体列是 varchar(32)，且要留位置给可能的重名后缀
  assert(name.length <= 32, `DEMO_USERNAME 超过 username 列长度上限：${name.length}`)
  assert(!/[^a-z0-9_-]/.test(name), `DEMO_USERNAME 含非常规字符：${name}`)
  return name
})

// ---------------------------------------------------------------- 离线：断点续传

suite('resume')

const { buildContinuationMessages, retryableForStatus, mergeToolSteps, ResumeRejectedError, MAX_RESUME_PARTIAL_CHARS } =
  continuation

check('续传上下文固定为 …历史 → 提问 → 半截前缀', () => {
  const msgs = buildContinuationMessages(
    [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ],
    '背四个字',
    '甲乙',
  )
  assert(
    JSON.stringify(msgs.map((m) => m.role)) === JSON.stringify(['user', 'assistant', 'user', 'assistant']),
    `角色顺序走样：${JSON.stringify(msgs.map((m) => m.role))}`,
  )
  assert(msgs.at(-1).content === '甲乙', '末条必须是已生成的半截，模型才会顺着写')
  assert(msgs.at(-2).content === '背四个字', '提问不在半截前面，模型会当成新的一轮作答')
  return '4 条'
})

check('半截已在历史末尾就不重复，提问缺失才补一份', () => {
  // 中断那次已把「甲乙」落库，重连时它既在历史里又被当作前缀，不去掉就会发两遍
  const withPartialInHistory = buildContinuationMessages(
    [
      { role: 'user', content: '背四个字' },
      { role: 'assistant', content: '甲乙' },
    ],
    '背四个字',
    '甲乙',
  )
  assert(
    withPartialInHistory.filter((m) => m.content === '甲乙').length === 1,
    `半截重复了：${JSON.stringify(withPartialInHistory.map((m) => m.content))}`,
  )
  assert(
    withPartialInHistory.filter((m) => m.role === 'user').length === 1,
    '提问已在原位还补，模型会看到同一个问题问了两遍',
  )

  // 换实例后库里没有这条提问：补进上下文，但只补一份
  const missingQuestion = buildContinuationMessages([{ role: 'assistant', content: '甲乙' }], '背四个字', '甲乙')
  assert(
    missingQuestion.filter((m) => m.role === 'user' && m.content === '背四个字').length === 1,
    '缺失的提问没有补进上下文，续写会答非所问',
  )

  // 入参历史还要被别处复用，函数不能就地改它
  const history = [{ role: 'user', content: '原话' }]
  buildContinuationMessages(history, '原话', '前半段')
  assert(history.length === 1, `入参历史被改写了：${JSON.stringify(history)}`)
  return '去重 + 补问 + 无副作用'
})

check('空/纯空白/超上限的半截一律拒绝续传', () => {
  const history = [{ role: 'user', content: '问' }]
  for (const partial of ['', '   ', '\n\t']) {
    let threw = null
    try {
      buildContinuationMessages(history, '问', partial)
    } catch (error) {
      threw = error
    }
    assert(threw instanceof ResumeRejectedError, `空白半截 "${partial}" 竟然允许续传`)
  }

  const atLimit = '字'.repeat(MAX_RESUME_PARTIAL_CHARS)
  assert(
    buildContinuationMessages(history, '问', atLimit).at(-1).content === atLimit,
    '刚好到上限的半截不该被拒',
  )
  let over = null
  try {
    buildContinuationMessages(history, '问', '字'.repeat(MAX_RESUME_PARTIAL_CHARS + 1))
  } catch (error) {
    over = error
  }
  assert(over instanceof ResumeRejectedError, '超出上限仍允许续传，请求体本身就会吃掉函数内存')
  return `上限 ${MAX_RESUME_PARTIAL_CHARS}`
})

check('重试判定只认临时故障，密钥/参数类 4xx 不许自动重连', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert(retryableForStatus(status) === true, `${status} 属于临时故障，应可续传`)
  }
  for (const status of [400, 401, 403, 404, 413, 422]) {
    assert(retryableForStatus(status) === false, `${status} 是请求本身的问题，重连只会再烧一次额度`)
  }
  return '12 个返回码'
})

check('中断那轮的工具轨迹合并不重不漏、保持原顺序', () => {
  const prior = [
    { id: 'a', name: 'calc' },
    { id: 'b', name: 'fetch_url' },
  ]
  const next = [
    { id: 'b', name: 'fetch_url' },
    { id: 'c', name: 'calc' },
  ]
  const merged = mergeToolSteps(prior, next)
  assert(
    JSON.stringify(merged.map((s) => s.id)) === JSON.stringify(['a', 'b', 'c']),
    `合并结果不对：${JSON.stringify(merged.map((s) => s.id))}`,
  )
  assert(mergeToolSteps(prior, []).length === 2, '续传这轮没调工具，也不该把已执行过的步骤抹掉')
  assert(mergeToolSteps([], []).length === 0, '空轨迹合并应为空')
  return 'a,b,c'
})

// ---------------------------------------------------------------- 离线：场景化模型路由

suite('model-routing')

const { routingCandidates, routingEnabled, complexityScore, pickModel, resolveResumeModel } =
  modelRouter

/** 路由读的是环境变量，用完必须还原，否则会串味到同进程后面的用例 */
const LIGHT = '你好'
const HEAVY = '请仔细分析这段代码的性能问题，并给出优化方案'

function decide(question, primary = 'deepseek-chat', candidates = 'flash,pro') {
  return withEnv(
    { MODEL_ROUTING_CANDIDATES: candidates, MODEL_ROUTING_ENABLED: 'true' },
    () => pickModel({ question, primary }),
  )
}

check('没配候选或显式关闭时恒用主力模型，行为与改动前一致', async () => {
  const unset = await withEnv({ MODEL_ROUTING_CANDIDATES: undefined }, () =>
    pickModel({ question: HEAVY, primary: 'deepseek-chat' }),
  )
  assert(unset.model === 'deepseek-chat', `未配候选却换了模型：${unset.model}`)
  assert(unset.score === 0, '路由关闭时不该给复杂度分，界面会误以为升过档')

  const off = await withEnv({ MODEL_ROUTING_CANDIDATES: 'flash,pro', MODEL_ROUTING_ENABLED: 'false' }, () =>
    pickModel({ question: HEAVY, primary: 'deepseek-chat' }),
  )
  assert(off.model === 'deepseek-chat', `MODEL_ROUTING_ENABLED=false 却没有回到主力模型：${off.model}`)
  assert(routingEnabled() === false, '候选为空就该判定路由关闭')
  return '未配置 / 显式关闭 都恒定主力档'
})

check('候选解析：逗号分隔、去空白、保持由低到高的顺序', async () => {
  const parsed = await withEnv({ MODEL_ROUTING_CANDIDATES: ' flash , , pro ' }, () =>
    routingCandidates(),
  )
  assert(
    JSON.stringify(parsed) === JSON.stringify(['flash', 'pro']),
    `解析结果不对：${JSON.stringify(parsed)}`,
  )
  return parsed.join(' → ')
})

check('分数按档位线性映射：轻问题最低档，叠满信号最高档', async () => {
  const light = await decide(LIGHT)
  const heavy = await decide(HEAVY)
  assert(light.model === 'flash', `轻问题升了档：${light.model}`)
  assert(heavy.model === 'pro', `复杂问题没升档：${heavy.model}`)
  assert(heavy.score > light.score, `分数不单调：轻 ${light.score} ≥ 重 ${heavy.score}`)

  // 三档时中间档要真的存在，否则「按场景选」退化成「只在两档间跳」
  const mid = await decide(HEAVY, 'deepseek-chat', 'flash,pro,max')
  assert(mid.model === 'pro', `三档时落点不对：${mid.model}`)
  return `轻 ${light.model} / 中 ${mid.model} / 重 ${heavy.model}`
})

check('信号叠满也封顶在最高档，不会越过白名单', async () => {
  const longest = '请仔细论证并重构这套架构，给出对比评估与表格输出：function f() {} ' + '补'.repeat(900)
  const score = complexityScore(longest)
  assert(score <= 1, `复杂度分越过了 1：${score}`)

  const picked = await decide(longest, 'deepseek-chat', 'flash,pro')
  assert(picked.model === 'pro', `越界后被丢掉，落到了 ${picked.model}`)

  // 白名单之外还兜得住：候选只有一个时任何分数都只能落在那一档
  const only = await decide(longest, 'deepseek-chat', 'flash')
  assert(only.model === 'flash', `单候选却换了模型：${only.model}`)
  return `封顶分 ${score}`
})

check('续传沿用中断那一轮的模型，即便它不是当前档位', async () => {
  const fallback = await decide(LIGHT, 'deepseek-chat', 'flash,pro')
  assert(fallback.model === 'flash', '前置断言不成立：轻问题本该落在第 1 档')

  const kept = await withEnv({ MODEL_ROUTING_CANDIDATES: 'flash,pro' }, () =>
    resolveResumeModel('pro', fallback),
  )
  assert(kept.model === 'pro', `换档位把中断那一轮的模型改掉了：${kept.model}`)
  assert(kept.reason.includes('续传沿用'), `理由没说明是续传沿用：${kept.reason}`)
  return kept.reason
})

check('库里没记模型、或记的已不在白名单时，退回路由器', async () => {
  const fallback = { model: 'router-picked', reason: '路由器给的', score: 0.2 }
  const legacy = await withEnv({ MODEL_ROUTING_CANDIDATES: 'flash,pro' }, () =>
    resolveResumeModel(null, fallback),
  )
  assert(legacy.model === 'router-picked', `旧数据没记模型却凭空沿用：${legacy.model}`)

  const removed = await withEnv({ MODEL_ROUTING_CANDIDATES: 'flash' }, () =>
    resolveResumeModel('pro', fallback),
  )
  assert(removed.model === 'router-picked', `白名单里已经没有 pro，仍然沿用了它：${removed.model}`)
  return '缺记录 / 已下架 都退回路由器'
})

// ---------------------------------------------------------------- 在线：工具选择命中率

async function runOnline() {
  const apiKey = process.env.EVAL_API_KEY
  if (!apiKey) {
    console.error(
      '[evals] --online 需要 EVAL_API_KEY（可选 EVAL_BASE_URL / EVAL_MODEL）。' +
        '不想消耗 token 就去掉 --online 跑离线模式。',
    )
    process.exit(1)
  }
  const baseUrl = process.env.EVAL_BASE_URL || 'https://api.deepseek.com/v1'
  const model = process.env.EVAL_MODEL || 'deepseek-chat'
  const url = llmClient.resolveCompletionsUrl(baseUrl)

  suite('tool-selection')

  const picked = await runner.runWithConcurrency(cases, CONcurrency, async (item) => {
    const body = {
      model,
      messages: [
        { role: 'system', content: prompt.SYSTEM_PROMPT },
        { role: 'user', content: item.input },
      ],
      tools: tools.TOOL_DEFINITIONS,
      tool_choice: 'auto',
      stream: false,
      temperature: 0,
      max_tokens: 200,
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) {
        const detail = truncate(await res.text().catch(() => ''))
        return { item, error: `HTTP ${res.status} ${detail}` }
      }
      const data = await res.json()
      const calls = data.choices?.[0]?.message?.tool_calls ?? []
      const names = calls.map((c) => c.function?.name).filter(Boolean)
      return { item, names }
    } catch (error) {
      return { item, error: error.message }
    }
  })

  const perCategory = new Map()
  for (const r of picked) {
    const item = r.item
    const ok =
      !r.error &&
      (item.expectTool === null || item.expectTool === undefined
        ? r.names.length === 0
        : r.names[0] === item.expectTool)
    check(
      `${item.id} 选择 ${item.expectTool ?? '(不应调工具)'}`,
      () => {
        if (r.error) throw new Error(`调用失败：${r.error}`)
        assert(
          ok,
          `实际选择 ${r.names.length ? r.names.join(',') : '(无)'}，期望 ${item.expectTool ?? '(无)'}`,
        )
        return r.names.length ? r.names.join(',') : '不调工具'
      },
    )
    const stat = perCategory.get(item.category) ?? { pass: 0, total: 0 }
    stat.total += 1
    if (ok) stat.pass += 1
    perCategory.set(item.category, stat)
  }

  return perCategory
}

// ---------------------------------------------------------------- 汇总输出

function report(perCategory) {
  const bySuite = new Map()
  for (const r of [...results].sort((a, b) => a.order - b.order)) {
    const list = bySuite.get(r.suite) ?? []
    list.push(r)
    bySuite.set(r.suite, list)
  }

  const width = Math.max(...[...bySuite.keys()].map((k) => k.length))
  for (const [name, list] of bySuite) {
    const passed = list.filter((r) => r.pass).length
    console.log('')
    console.log(`${name.padEnd(width)}  ${passed}/${list.length}`)
    for (const r of list) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.title}${r.note ? `  →  ${r.note}` : ''}`)
    }
  }

  if (perCategory) {
    console.log('')
    console.log('按分类命中率')
    for (const [category, stat] of perCategory) {
      console.log(
        `  ${category.padEnd(12)} ${stat.pass}/${stat.total} (${((stat.pass / stat.total) * 100).toFixed(0)}%)`,
      )
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log('')
  console.log(
    `[evals] ${results.length - failed.length}/${results.length} 通过` +
      (ONLINE ? `，模式 online，模型 ${process.env.EVAL_MODEL || 'deepseek-chat'}` : '，模式 offline'),
  )
  return failed
}

const perCategory = ONLINE ? await runOnline() : null
await Promise.all(pending)
const failed = report(perCategory)

if (ONLINE) {
  const selection = results.filter((r) => r.suite === 'tool-selection')
  const hit = selection.filter((r) => r.pass).length
  const accuracy = selection.length ? hit / selection.length : 0
  console.log(`[evals] 工具选择准确率 ${(accuracy * 100).toFixed(0)}%（阈值 ${(MIN_ACCURACY * 100).toFixed(0)}%）`)
  if (accuracy < MIN_ACCURACY) {
    console.error(`[evals] 准确率低于阈值，判定失败`)
    process.exit(1)
  }
}

if (failed.length) {
  process.exit(1)
}
