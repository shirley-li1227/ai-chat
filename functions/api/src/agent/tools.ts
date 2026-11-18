import { assertUrlSafe } from '../security/url-guard'
import { backgroundTasksEnabled } from '../tasks/task-policy'
import { memoryEnabled, memoryItemMaxChars } from '../memory/memory-policy'
import { HtmlTextStream } from './html-text'

/** 工具统一返回：ok=false 时 output 是给模型看的说明，不向上抛异常 */
export interface ToolResult {
  ok: boolean
  output: string
}

export type ArgType = 'string' | 'number' | 'boolean' | 'object'

/**
 * 参数声明。同一份声明既生成给模型看的 JSON Schema，也是执行前的校验依据，
 * 避免出现「schema 说要 url、handler 里却 String(args.anything)」。
 */
export interface ArgSpec {
  type: ArgType
  description: string
  required?: boolean
  enum?: readonly (string | number)[]
  maxLength?: number
}

/** 工具执行期间的量化进度，界面按 tool_call_id 归位显示 */
export interface ToolProgress {
  /** 中文阶段说明，后一次覆盖前一次 */
  phase?: string
  receivedBytes?: number
  maxBytes?: number
  /** 已抽出的正文字数，让「还在下载」和「快读完了」在界面上区分得开 */
  textChars?: number
}

/** 执行期注入的外部能力，工具自身不依赖 Nest 容器，便于评测脚本直接调用 */
export interface ToolContext {
  /** run_in_background 使用：把一次工具调用登记为后台任务 */
  enqueueBackground?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ id: string }>
  /**
   * 边执行边推送：delta 是结果正文的增量，progress 是阶段与量化进度。
   * 不提供时工具必须照常工作——评测脚本、后台执行器都走这条路，只有 SSE 那侧会传。
   */
  report?: (event: { delta?: string; progress?: ToolProgress }) => void
  /** remember 使用：写入一条长期记忆 */
  remember?: (content: string) => Promise<{ ok: boolean; message: string }>
  /** forget 使用：按编号忘掉一条 */
  forget?: (handle: string) => Promise<{ ok: boolean; message: string }>
}

export interface ToolSpec {
  name: string
  description: string
  args: Record<string, ArgSpec>
  /** 允许被 run_in_background 提交为长任务：慢、无副作用、结果可以晚于本轮回答到达 */
  background: boolean
  /**
   * 能力开关。返回 false 时既不广播给模型，执行也被拒绝——
   * 没有执行器或没建表时，宁可模型压根不知道有这工具，也别造出一堆没人接的任务。
   */
  enabled?: () => boolean
  /** 开关关闭时回给模型的说明，让它知道这不是它能用的能力 */
  disabledHint?: string
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string; enum?: (string | number)[] }>
      required: string[]
    }
  }
}

const TYPE_LABEL: Record<ArgType, string> = {
  string: '字符串',
  number: '数字',
  boolean: '布尔值',
  object: '对象',
}

const fail = (output: string): ToolResult => ({ ok: false, output })

/**
 * 执行前的参数校验，返回中文错误说明（null 表示通过）。
 *
 * 为什么要拦在 handler 之前：模型的参数是自由 JSON，之前一律 `String(args.x ?? '')`
 * 把类型问题压成空字符串，工具只能报「不能为空」，模型据此反复猜。校验器把
 * 「缺什么、什么类型、可选值有哪些」一次说清，模型下一轮通常就修对了；
 * 未知参数名同样拒绝，免得它编造 schema 里没有的字段并以为生效了。
 */
export function validateToolArgs(
  spec: Pick<ToolSpec, 'name' | 'args'>,
  raw: unknown,
): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return '工具参数必须是一个 JSON 对象'
  }
  const input = raw as Record<string, unknown>
  const known = Object.keys(spec.args)

  const unknown = Object.keys(input).filter((key) => !known.includes(key))
  if (unknown.length) {
    return `不认识的参数 ${unknown.map((key) => `"${key}"`).join('、')}；${spec.name} 可用参数：${
      known.length ? known.join('、') : '（无参数）'
    }`
  }

  for (const [key, arg] of Object.entries(spec.args)) {
    const value = input[key]
    if (value === undefined || value === null || value === '') {
      if (arg.required) {
        return `参数 ${key} 不能为空`
      }
      continue
    }

    const actual = Array.isArray(value) ? 'array' : typeof value
    if (actual !== arg.type) {
      // 模型偶尔把数字写成字符串，这类无损转换直接放过，其余按类型报错
      const lossless =
        arg.type === 'number' &&
        typeof value === 'string' &&
        value.trim() !== '' &&
        Number.isFinite(Number(value))
      if (!lossless) {
        return `参数 ${key} 应为${TYPE_LABEL[arg.type]}，实际是${TYPE_LABEL[actual as ArgType] ?? actual}`
      }
    }
    if (arg.enum && !arg.enum.includes(value as string | number)) {
      return `参数 ${key} 只能是 ${arg.enum.join(' / ')}`
    }
    if (arg.type === 'string' && arg.maxLength && String(value).length > arg.maxLength) {
      return `参数 ${key} 超过 ${arg.maxLength} 字上限`
    }
  }

  return null
}

/** 由参数声明生成 OpenAI tools 需要的 JSON Schema */
function parametersOf(
  spec: Pick<ToolSpec, 'args'>,
): ToolDefinition['function']['parameters'] {
  const properties: ToolDefinition['function']['parameters']['properties'] = {}
  const required: string[] = []
  for (const [key, arg] of Object.entries(spec.args)) {
    properties[key] = {
      type: arg.type,
      description: arg.description,
      ...(arg.enum ? { enum: [...arg.enum] } : {}),
    }
    if (arg.required) {
      required.push(key)
    }
  }
  return { type: 'object', properties, required }
}

function toDefinition(spec: ToolSpec): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: parametersOf(spec),
    },
  }
}

/**
 * 安全的算术表达式求值（递归下降解析），不使用 eval。
 */
function evaluateExpression(input: string): number {
  const src = input.replace(/\s+/g, '')
  let pos = 0

  const consume = (expected: string) => {
    if (src.startsWith(expected, pos)) {
      pos += expected.length
      return true
    }
    return false
  }

  const failParse = (msg: string): never => {
    throw new Error(`表达式解析失败：${msg}（位置 ${pos}）`)
  }

  function parseExpression(): number {
    let value = parseTerm()
    for (;;) {
      if (consume('+')) {
        value += parseTerm()
      } else if (consume('-')) {
        value -= parseTerm()
      } else {
        return value
      }
    }
  }

  function parseTerm(): number {
    let value = parseUnary()
    for (;;) {
      if (consume('*')) {
        value *= parseUnary()
      } else if (consume('/')) {
        value /= parseUnary()
      } else if (consume('%')) {
        value %= parseUnary()
      } else {
        return value
      }
    }
  }

  function parseUnary(): number {
    if (consume('-')) return -parseUnary()
    if (consume('+')) return parseUnary()
    return parsePower()
  }

  function parsePower(): number {
    const base = parseAtom()
    if (consume('^')) {
      // 右结合
      return Math.pow(base, parseUnary())
    }
    return base
  }

  function parseAtom(): number {
    if (consume('(')) {
      const value = parseExpression()
      if (!consume(')')) failParse('缺少右括号')
      return value
    }
    const numMatch = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(pos))
    if (numMatch) {
      pos += numMatch[0].length
      return parseFloat(numMatch[0])
    }
    // 函数与常量：标识符必须允许数字，否则 log10/log2 会被切成 "log" + 数字，
    // 报成"函数 log 需要括号参数"这种看不懂的错（评测集 calc-04 就是先撞在这里）
    const identMatch = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(src.slice(pos))
    if (identMatch) {
      const name = identMatch[0].toLowerCase()
      pos += identMatch[0].length
      if (name === 'pi') return Math.PI
      if (name === 'e') return Math.E
      const fn = FUNCTIONS[name]
      if (!fn) failParse(`未知标识符 "${name}"`)
      if (!consume('(')) failParse(`函数 ${name} 需要括号参数`)
      const arg = parseExpression()
      if (!consume(')')) failParse('缺少右括号')
      return fn(arg)
    }
    failParse('意外的字符')
    throw new Error('表达式解析失败')
  }

  const result = parseExpression()
  if (pos < src.length) {
    failParse(`存在未解析的内容 "${src.slice(pos)}"`)
  }
  if (!Number.isFinite(result)) {
    throw new Error('计算结果不是有限数值')
  }
  return result
}

const FUNCTIONS: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  abs: Math.abs,
  round: Math.round,
  ceil: Math.ceil,
  floor: Math.floor,
  exp: Math.exp,
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 交给模型和界面的正文长度上限，与工具描述里写死的数字保持一致 */
const FETCH_TEXT_LIMIT = 3000

/** 工具内部上报进度的窄接口：调用方自己决定 delta 与进度字段怎么组合 */
type ProgressFn = (patch: { delta?: string } & ToolProgress) => void

/** fetch_url 的运行策略，来自环境变量 */
function fetchPolicy() {
  const hosts = (process.env.FETCH_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return {
    allowedHosts: hosts,
    timeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 15000),
    maxBytes: Number(process.env.FETCH_MAX_BYTES ?? 1048576),
    maxRedirects: 3,
  }
}

/** 没挂 SSE 的调用方（后台执行器、评测脚本）拿不到 report，工具必须照常跑完 */
function progressOf(ctx: ToolContext): ProgressFn | undefined {
  if (!ctx.report) {
    return undefined
  }
  return (patch) => {
    const { delta, ...progress } = patch
    ctx.report?.({ ...(delta ? { delta } : {}), progress })
  }
}

/**
 * 边下边抽正文。HtmlTextStream 保证任意切分下的输出与整篇解析逐字相同，
 * 所以推送过的 delta 拼起来就是最终结果，界面不会出现二次改写。
 */
async function readTextStreaming(
  res: Response,
  policy: { maxBytes: number },
  onProgress: ProgressFn | undefined,
): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) {
    return ''
  }

  const extractor = new HtmlTextStream(FETCH_TEXT_LIMIT)
  // { stream:true } 让跨块截断的多字节字符留到下一块，否则中文会解成乱码
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let received = 0
  let early = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value) {
        continue
      }
      received += value.byteLength
      const delta = extractor.push(decoder.decode(value, { stream: true }))
      const progress: ToolProgress = {
        phase: extractor.full ? '正文已读满，停止下载' : '读取正文',
        receivedBytes: received,
        maxBytes: policy.maxBytes,
        textChars: extractor.value.length,
      }
      if (delta || received > policy.maxBytes || extractor.full) {
        onProgress?.({ ...(delta ? { delta } : {}), ...progress })
      }
      if (extractor.full || received > policy.maxBytes) {
        early = true
        break
      }
    }

    if (!early) {
      const tail = extractor.push(decoder.decode()) + extractor.end()
      if (tail) {
        onProgress?.({ delta: tail, phase: '读取完成', receivedBytes: received })
      }
    }
  } finally {
    // 提前收口要显式取消，否则连接会挂着不释放
    if (early) {
      await reader.cancel().catch(() => undefined)
    }
  }

  return extractor.value
}

async function fetchUrlText(
  url: string,
  ctx: ToolContext = {},
  policy = fetchPolicy(),
): Promise<ToolResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs)
  const onProgress = progressOf(ctx)

  try {
    let current = url
    let res: Response | null = null

    // 手动逐跳跟随重定向：每一跳都重新校验，
    // 否则可用公网域名 302 跳到内网元数据端点绕过检查
    for (let hop = 0; hop <= policy.maxRedirects; hop++) {
      onProgress?.({ phase: `校验第 ${hop + 1} 跳地址` })
      const safe = await assertUrlSafe(current, policy.allowedHosts)
      res = await fetch(safe.url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-chat-agent)' },
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) {
          break
        }
        current = new URL(location, safe.url).toString()
        continue
      }
      break
    }

    if (!res) {
      return fail('抓取失败：无响应')
    }
    if (res.status >= 300 && res.status < 400) {
      return fail('重定向次数过多或被拒绝')
    }
    if (!res.ok) {
      return fail(`抓取失败，HTTP ${res.status}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text') && !contentType.includes('html')) {
      return fail(`不支持的内容类型：${contentType}`)
    }

    onProgress?.({ phase: '开始接收响应' })
    const text = await readTextStreaming(res, policy, onProgress)
    return { ok: true, output: text || '页面无可提取文本' }
  } catch (error) {
    const message =
      (error as Error).name === 'AbortError' ? '抓取超时' : (error as Error).message
    return fail(message)
  } finally {
    clearTimeout(timer)
  }
}

const getCurrentTimeSpec: ToolSpec = {
  name: 'get_current_time',
  description:
    '获取当前的日期、时间和星期（本地时区）。当用户询问"现在几点"、"今天几号"、"星期几"等时间相关问题时必须调用本工具，不要凭记忆猜测时间。',
  args: {},
  background: false,
  async run(): Promise<ToolResult> {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return {
      ok: true,
      output: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${WEEKDAYS[now.getDay()]}（时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）`,
    }
  },
}

const calculatorSpec: ToolSpec = {
  name: 'calculator',
  description:
    '执行精确数学计算。支持 + - * / % ^ 运算符、括号，以及 sin/cos/tan/asin/acos/atan/sqrt/cbrt/log/log2/log10/abs/round/ceil/floor/exp 函数和 PI、E 常量。凡是涉及算术运算的问题都必须调用本工具，禁止心算。',
  args: {
    expression: {
      type: 'string',
      required: true,
      maxLength: 500,
      description: '数学表达式，例如 "(3+5)*2^3" 或 "sqrt(144)+PI*2"，不要包含等号或中文',
    },
  },
  background: false,
  async run(args): Promise<ToolResult> {
    const expression = String(args.expression).trim()
    const value = evaluateExpression(expression)
    return { ok: true, output: `${expression} = ${value}` }
  },
}

const fetchUrlSpec: ToolSpec = {
  name: 'fetch_url',
  description:
    '抓取指定网页并返回纯文本内容（最多 3000 字）。当需要获取网页上的最新信息、文档内容或实时数据时调用。',
  args: {
    url: {
      type: 'string',
      required: true,
      maxLength: 2000,
      description: '完整网址，必须以 http:// 或 https:// 开头',
    },
  },
  background: true,
  async run(args, ctx): Promise<ToolResult> {
    return fetchUrlText(String(args.url).trim(), ctx)
  },
}

const rememberSpec: ToolSpec = {
  name: 'remember',
  description:
    '把关于这位用户、以后其他会话也用得上的稳定事实写入长期记忆。' +
    '应当调用：用户说「记一下 / 以后都 / 我一直 / 别忘了」，或透露出跨会话仍然成立的身份、称呼、职业、常用技术栈、长期偏好。' +
    '不要调用：本轮的临时问题、一次性任务细节、当前对话里已经写明的内容、未经确认的猜测、随时会过期的状态。' +
    '一次只记一条事实，用一句话陈述，不要写成对话摘录。',
  args: {
    content: {
      type: 'string',
      required: true,
      maxLength: memoryItemMaxChars(),
      description: `一句话陈述一个事实，不超过 ${memoryItemMaxChars()} 字，例如「用户偏好中文回复，项目用 NestJS」`,
    },
  },
  background: false,
  enabled: memoryEnabled,
  disabledHint: '长期记忆功能未启用（MEMORY_ENABLED 为 false）',
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.remember) {
      return fail('长期记忆服务不可用，请确认后端已建 user_memories 表')
    }
    const result = await ctx.remember(String(args.content))
    return { ok: result.ok, output: result.message }
  },
}

const forgetSpec: ToolSpec = {
  name: 'forget',
  description:
    '按编号忘掉一条长期记忆。当用户说「那条记错了 / 别再记着这个 / 删掉那条」，' +
    '或发现已有记忆与用户此刻的明确说法冲突时调用。' +
    '编号就是记忆清单里每行方括号中的 8 位字符；不确定该删哪条时先问用户，不要凭猜测删除。',
  args: {
    handle: {
      type: 'string',
      required: true,
      maxLength: 40,
      description: '记忆编号，例如 "3f9a1c22"，也接受完整 UUID',
    },
  },
  background: false,
  enabled: memoryEnabled,
  disabledHint: '长期记忆功能未启用（MEMORY_ENABLED 为 false）',
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.forget) {
      return fail('长期记忆服务不可用，请确认后端已建 user_memories 表')
    }
    const result = await ctx.forget(String(args.handle))
    return { ok: result.ok, output: result.message }
  },
}

/** 不依赖后台能力的普通工具，注册表与可长任务化集合都从这里派生，避免另维护一份名单 */
const PLAIN_SPECS: ToolSpec[] = [
  getCurrentTimeSpec,
  calculatorSpec,
  fetchUrlSpec,
  rememberSpec,
  forgetSpec,
]

/** 可以长任务化的工具集合，供 run_in_background 的枚举与说明使用 */
const BACKGROUNDABLE_TOOLS = PLAIN_SPECS.filter((spec) => spec.background)

const BACKGROUNDABLE_NAMES = BACKGROUNDABLE_TOOLS.map((spec) => spec.name)

const runInBackgroundSpec: ToolSpec = {
  name: 'run_in_background',
  description:
    `把一个耗时较长、且允许在本轮回答结束后继续执行的工具调用提交为后台任务。可用工具：${BACKGROUNDABLE_NAMES.join(
      '、',
    )}。调用后立即返回任务编号，不返回工具结果本身；请告知用户任务已提交、稍后在「后台任务」面板查看结果，不要假装已经拿到内容。`,
  args: {
    name: {
      type: 'string',
      required: true,
      enum: BACKGROUNDABLE_NAMES,
      description: `要放到后台执行的工具名，只能是 ${BACKGROUNDABLE_NAMES.join(' / ')}`,
    },
    arguments: {
      type: 'object',
      required: true,
      description: '该工具自身的参数对象，字段与其声明一致，例如 {"url":"https://example.com"}',
    },
  },
  background: false,
  enabled: backgroundTasksEnabled,
  disabledHint: '后台任务功能未启用（BACKGROUND_TASKS_ENABLED 不为 true）',
  async run(args, ctx): Promise<ToolResult> {
    const name = String(args.name).trim()
    const spec = BACKGROUNDABLE_TOOLS.find((candidate) => candidate.name === name)
    if (!spec) {
      return fail(
        BACKGROUNDABLE_NAMES.includes(name)
          ? `工具 ${name} 未注册`
          : `工具 ${name} 不支持后台执行，可直接调用它；支持后台执行的是 ${BACKGROUNDABLE_NAMES.join('、')}`,
      )
    }

    const problem = validateToolArgs(spec, args.arguments ?? {})
    if (problem) {
      return fail(`后台任务 ${name} 的参数不合法：${problem}`)
    }
    if (!ctx.enqueueBackground) {
      return fail('后台任务执行器未启用，无法提交长任务')
    }

    const task = await ctx.enqueueBackground(name, (args.arguments ?? {}) as Record<string, unknown>)
    return {
      ok: true,
      output: `已提交后台任务 ${task.id}（${name}）。结果稍后出现在「后台任务」面板，本轮回答里还没有它。`,
    }
  },
}

/** 全部工具规格，注册表是唯一事实来源：schema、校验、分发都从这里派生 */
export const TOOL_REGISTRY: ToolSpec[] = [...PLAIN_SPECS, runInBackgroundSpec]

export function findToolSpec(name: string): ToolSpec | undefined {
  return TOOL_REGISTRY.find((spec) => spec.name === name)
}

/** 开关关闭时回给模型的说明；未设开关的工具恒为 null */
export function disabledHintOf(spec: ToolSpec): string | null {
  if (!spec.enabled || spec.enabled()) {
    return null
  }
  return spec.disabledHint ?? `工具 ${spec.name} 当前未启用`
}

/**
 * 本轮请求要广播的工具清单。每轮重新求值开关，
 * 改环境变量重启即生效，不必重新构建。
 */
export function buildToolDefinitions(): ToolDefinition[] {
  return TOOL_REGISTRY.filter((spec) => !disabledHintOf(spec)).map(toDefinition)
}

/** 不受任何开关影响的常驻工具集，供评测与「关掉全部条件能力」的调用方使用 */
export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_REGISTRY.filter(
  (spec) => !spec.enabled,
).map(toDefinition)

/** 可以提交为后台任务的工具名 */
export function backgroundableToolNames(): string[] {
  return [...BACKGROUNDABLE_NAMES]
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = {},
): Promise<ToolResult> {
  const spec = findToolSpec(name)
  if (!spec) {
    return fail(`未知工具：${name}`)
  }
  const disabled = disabledHintOf(spec)
  if (disabled) {
    return fail(disabled)
  }

  const problem = validateToolArgs(spec, args)
  if (problem) {
    return fail(problem)
  }

  try {
    return await spec.run(args, ctx)
  } catch (error) {
    return fail(error instanceof Error ? error.message : '工具执行失败')
  }
}
