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
 *                并发上限这几类纯本地不变量。适合每次改完代码就跑。
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
  pending.push(
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

try {
  prompt = loadDist('chat/prompt.js')
  tools = loadDist('agent/tools.js')
  estimator = loadDist('chat/token-estimator.js')
  runner = loadDist('agent/tool-runner.js')
  llmClient = loadDist('chat/llm-client.js')
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
