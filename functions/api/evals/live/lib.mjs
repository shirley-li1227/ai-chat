/**
 * live 验证栈的公共件：断言登记、HTTP / SSE 客户端、端口与子进程工具。
 *
 * 这里的密钥全是硬编码假串，链路只连 127.0.0.1，库文件在临时目录里。
 * 拆成一份公共件的原因：三个检查脚本要的是同一套「怎么发请求、怎么算通过」，
 * 各自写一份就会各漏一种边界（比如 SSE 只认 [DONE] 才算正常收尾）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'

export const FAKE_KEYS = {
  deepseek: 'sk-livefake0123456789abcdef',
  zhipu: 'livefake0001.livefake0000000002',
}

/** 假上游的两条端点路径，正好对应两家的 baseUrl 形态（智谱必须带 /api/paas/v4） */
export const UPSTREAM_PATHS = {
  deepseek: '/v1/chat/completions',
  zhipu: '/api/paas/v4/chat/completions',
}

export function parseArgs(argv) {
  const out = {}
  for (const raw of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw)
    if (match) {
      out[match[1]] = match[2] === undefined ? true : match[2]
    }
  }
  return out
}

export function tail(text, lines = 40) {
  return String(text)
    .split('\n')
    .filter(Boolean)
    .slice(-lines)
    .join('\n')
}

/**
 * 检查脚本的统一登记处。
 * 断言函数返回 true 视为通过，返回字符串/false 视为失败并把返回值当原因打出来。
 */
export function createSuite(name) {
  const passed = []
  const failed = []

  async function check(title, fn) {
    try {
      const verdict = await fn()
      if (verdict === true) {
        passed.push(title)
        return true
      }
      failed.push({ title, note: verdict === undefined ? '断言函数没有返回 true' : String(verdict) })
      return false
    } catch (error) {
      failed.push({ title, note: `抛错：${error?.message ?? error}` })
      return false
    }
  }

  function report() {
    for (const title of passed) {
      console.log(`PASS  ${title}`)
    }
    for (const item of failed) {
      console.log(`FAIL  ${item.title}  →  ${item.note}`)
    }
    console.log(`[${name}] ${passed.length}/${passed.length + failed.length} 通过`)
    return { passed: passed.length, failed: failed.length }
  }

  return { check, report }
}

export async function api(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

/**
 * 发一次 SSE 请求并把事件收下来。
 *
 * 完成与否只看有没有 `data: [DONE]`：连接关闭不代表答完，服务端半路抛错时也是关闭。
 * 续传这条链路整个建立在「有没有 [DONE]」之上，所以这里必须把它单独返回。
 */
export async function sse(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  const events = []
  let sawDone = false

  if (!res.ok || !res.body) {
    const text = await res.text()
    return { status: res.status, events, sawDone: false, errorText: text }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) {
          continue
        }
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') {
          sawDone = true
          continue
        }
        try {
          events.push(JSON.parse(payload))
        } catch {
          events.push({ unparsed: payload })
        }
      }
    }
  }

  return { status: res.status, events, sawDone, errorText: '' }
}

export function contentOf(events) {
  return events
    .filter((event) => typeof event.content === 'string')
    .map((event) => event.content)
    .join('')
}

export function eventsOfKind(events, kind) {
  return events.filter((event) => event && event[kind] !== undefined)
}

export async function waitForHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = '未发起请求'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        return await res.json()
      }
      last = `HTTP ${res.status}`
    } catch (error) {
      last = String(error?.message ?? error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`等待 ${url} 超时（${timeoutMs}ms），最后一次：${last}`)
}

export function portIsFree(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error) => reject(Object.assign(error, { port })))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

/** 子进程包装：stdout/stderr 落文件，失败时才有东西可贴 */
export function startChild(label, command, args, { cwd, env, logPath }) {
  const handle = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  handle.stdout.pipe(stream, { end: false })
  handle.stderr.pipe(stream, { end: false })
  handle.on('exit', (code, signal) => {
    stream.write(`\n[${label}] 进程退出 code=${code} signal=${signal}\n`)
  })
  return { label, handle, logPath, stream }
}

export function readLog(path) {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
