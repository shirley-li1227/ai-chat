import { assertUrlSafe } from '../security/url-guard'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string }>
      required: string[]
    }
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description:
        '获取当前的日期、时间和星期（本地时区）。当用户询问"现在几点"、"今天几号"、"星期几"等时间相关问题时必须调用本工具，不要凭记忆猜测时间。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description:
        '执行精确数学计算。支持 + - * / % ^ 运算符、括号，以及 sin/cos/tan/asin/acos/atan/sqrt/cbrt/log/log2/log10/abs/round/ceil/floor/exp 函数和 PI、E 常量。凡是涉及算术运算的问题都必须调用本工具，禁止心算。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，例如 "(3+5)*2^3" 或 "sqrt(144)+PI*2"，不要包含等号或中文',
          },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        '抓取指定网页并返回纯文本内容（最多 3000 字）。当需要获取网页上的最新信息、文档内容或实时数据时调用。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '完整网址，必须以 http:// 或 https:// 开头',
          },
        },
        required: ['url'],
      },
    },
  },
]

/**
 * 安全的算术表达式求值（递归下降解析），不使用 eval。
 */
function evaluateExpression(input: string): number {
  const src = input.replace(/\s+/g, '')
  let pos = 0

  const peek = () => src[pos]
  const consume = (expected: string) => {
    if (src.startsWith(expected, pos)) {
      pos += expected.length
      return true
    }
    return false
  }

  const fail = (msg: string): never => {
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
    // 括号
    if (consume('(')) {
      const value = parseExpression()
      if (!consume(')')) fail('缺少右括号')
      return value
    }
    // 数字
    const numMatch = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(pos))
    if (numMatch) {
      pos += numMatch[0].length
      return parseFloat(numMatch[0])
    }
    // 函数与常量
    const identMatch = /^[a-zA-Z_]+/.exec(src.slice(pos))
    if (identMatch) {
      const name = identMatch[0].toLowerCase()
      pos += identMatch[0].length
      if (name === 'pi') return Math.PI
      if (name === 'e') return Math.E
      const fn = FUNCTIONS[name]
      if (!fn) fail(`未知标识符 "${name}"`)
      if (!consume('(')) fail(`函数 ${name} 需要括号参数`)
      const arg = parseExpression()
      if (!consume(')')) fail('缺少右括号')
      return fn(arg)
    }
    fail('意外的字符')
    throw new Error('表达式解析失败')
  }

  const result = parseExpression()
  if (pos < src.length) {
    fail(`存在未解析的内容 "${src.slice(pos)}"`)
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

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

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

/** 带体积上限地读取响应体，防止超大页面打爆内存 */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) {
    return ''
  }
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    received += value.byteLength
    chunks.push(value)
    if (received > maxBytes) {
      await reader.cancel()
      break
    }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged)
}

export interface ToolResult {
  ok: boolean
  output: string
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_current_time': {
        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        return {
          ok: true,
          output: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${WEEKDAYS[now.getDay()]}（时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）`,
        }
      }

      case 'calculator': {
        const expression = String(args.expression ?? '').trim()
        if (!expression) {
          return { ok: false, output: '参数 expression 不能为空' }
        }
        const value = evaluateExpression(expression)
        return { ok: true, output: `${expression} = ${value}` }
      }

      case 'fetch_url': {
        const url = String(args.url ?? '').trim()
        const policy = fetchPolicy()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), policy.timeoutMs)

        try {
          let current = url
          let res: Response | null = null

          // 手动逐跳跟随重定向：每一跳都重新校验，
          // 否则可用公网域名 302 跳到内网元数据端点绕过检查
          for (let hop = 0; hop <= policy.maxRedirects; hop++) {
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
            return { ok: false, output: '抓取失败：无响应' }
          }
          if (res.status >= 300 && res.status < 400) {
            return { ok: false, output: '重定向次数过多或被拒绝' }
          }
          if (!res.ok) {
            return { ok: false, output: `抓取失败，HTTP ${res.status}` }
          }

          const contentType = res.headers.get('content-type') ?? ''
          if (!contentType.includes('text') && !contentType.includes('html')) {
            return { ok: false, output: `不支持的内容类型：${contentType}` }
          }

          const body = await readCappedText(res, policy.maxBytes)
          const text = htmlToText(body).slice(0, 3000)
          return { ok: true, output: text || '页面无可提取文本' }
        } catch (error) {
          const message =
            (error as Error).name === 'AbortError'
              ? '抓取超时'
              : (error as Error).message
          return { ok: false, output: message }
        } finally {
          clearTimeout(timer)
        }
      }

      default:
        return { ok: false, output: `未知工具：${name}` }
    }
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : '工具执行失败',
    }
  }
}
