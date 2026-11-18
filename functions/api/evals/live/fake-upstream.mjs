/**
 * 假上游：一个只会照脚本回话的 OpenAI Chat Completions 端点。
 *
 * 为什么不用真实供应商跑这套检查：一是要花额度、结果还随模型心情变；
 * 二是「把流掐断」「上游返回 401」「一轮里并发两个工具」这些边界，
 * 真实上游根本不可控，而这几条恰恰是最容易在改动里被弄坏的。
 *
 * 问题文本里用标记触发剧本（标记由检查脚本写死，不是给用户看的）：
 *   [[cut]]           吐两段就掐断连接，用来演断线续传
 *   [[401]]           直接回 401，用来验「判死不重连」
 *   [[calc:表达式]]    每个标记调一次 calculator
 *   [[fetch:URL]]      每个标记调一次 fetch_url
 *   [[remember:内容]]  调一次 remember
 *   [[forget:编号]]    调一次 forget
 * 每条请求都会往 LOG 追加一行 JSON，检查脚本靠它核对「第几次请求带的是哪个模型、哪把 Key、走了哪条路径」。
 *
 * 只监听 127.0.0.1，不联网，不认识任何真实密钥。
 */
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.UPSTREAM_PORT ?? 4102)
const LOG = process.env.UPSTREAM_LOG
if (!LOG) {
  console.error('UPSTREAM_LOG 必须指定：假上游要靠这份日志证明请求真的换了模型/换了 Key')
  process.exit(2)
}

const PATHS = new Set(['/v1/chat/completions', '/api/paas/v4/chat/completions'])
let seq = 0

function record(entry) {
  fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4_000_000) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function markers(text, name) {
  const hits = []
  const pattern = new RegExp(`\\[\\[${name}:([^\\]]*)\\]\\]`, 'g')
  let match
  while ((match = pattern.exec(text)) !== null) {
    hits.push(match[1])
  }
  return hits
}

function lastUser(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return String(messages[i].content ?? '')
    }
  }
  return ''
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
}

function writeChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function finishStop(res) {
  writeChunk(res, { choices: [{ delta: {}, finish_reason: 'stop' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

function answer(res, model, sentences) {
  sseHead(res)
  for (const sentence of sentences) {
    writeChunk(res, { choices: [{ delta: { content: sentence } }] })
  }
  finishStop(res)
}

function toolCalls(res, calls) {
  sseHead(res)
  calls.forEach((call, index) => {
    writeChunk(res, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
        },
      ],
    })
  })
  writeChunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, port: PORT }))
    return
  }

  const url = String(req.url ?? '').split('?')[0]
  if (req.method !== 'POST' || !PATHS.has(url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `fake upstream: 不认识 ${req.method} ${url}` } }))
    return
  }

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `fake upstream: 请求体不是 JSON（${error.message}）` } }))
    return
  }

  const auth = String(req.headers.authorization ?? '')
  const apiKey = auth.replace(/^Bearer\s+/i, '')
  const messages = Array.isArray(body.messages) ? body.messages : []
  const question = lastUser(messages)
  const toolResults = messages.filter((m) => m?.role === 'tool').length
  const assistantPrefix = messages.filter((m) => m?.role === 'assistant').length
  const systems = messages
    .filter((m) => m?.role === 'system')
    .map((m) => String(m.content ?? '').slice(0, 800))

  seq += 1
  record({
    seq,
    at: new Date().toISOString(),
    path: url,
    model: body.model,
    authPrefix: apiKey.slice(0, 4),
    authTail: apiKey.slice(-4),
    question,
    systemCount: systems.length,
    systems,
    toolResults,
    assistantPrefix,
    toolNames: (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean),
  })

  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'fake upstream: 请求没带 Authorization' } }))
    return
  }

  if (question.includes('[[401]]')) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'fake upstream: Key 被拒（脚本化 401）' } }))
    return
  }

  // 工具结果回来后必须给正文，否则 Agent 循环会一直转
  if (toolResults > 0) {
    answer(res, body.model, [`收到 ${toolResults} 条工具结果，` + `作答模型 ${body.model}。`])
    return
  }

  if (question.includes('[[cut]]') && assistantPrefix === 0) {
    sseHead(res)
    writeChunk(res, { choices: [{ delta: { content: `前半段（模型 ${body.model}）：` } }] })
    writeChunk(res, { choices: [{ delta: { content: `这段是先写好的。` } }] })
    // 先让这两段真的落进 socket 再毁连接：write 还没发出去就 destroy，
    // 后端什么也没收到，演的就不是「断在半路」而是「上游一次都没回话」
    await new Promise((resolve) => setTimeout(resolve, 60))
    if (res.socket && !res.socket.destroyed) {
      if (typeof res.socket.resetAndDestroy === 'function') {
        res.socket.resetAndDestroy()
      } else {
        res.socket.destroy()
      }
    }
    return
  }

  const calcs = markers(question, 'calc')
  const fetches = markers(question, 'fetch')
  const remembers = markers(question, 'remember')
  const forgets = markers(question, 'forget')
  const calls = []
  calcs.forEach((expression, i) => {
    calls.push({ id: `call_calc_${seq}_${i}`, name: 'calculator', args: { expression } })
  })
  fetches.forEach((u, i) => {
    calls.push({ id: `call_fetch_${seq}_${i}`, name: 'fetch_url', args: { url: u } })
  })
  remembers.forEach((content, i) => {
    calls.push({ id: `call_mem_${seq}_${i}`, name: 'remember', args: { content } })
  })
  forgets.forEach((handle, i) => {
    calls.push({ id: `call_forget_${seq}_${i}`, name: 'forget', args: { handle } })
  })
  if (calls.length > 0) {
    toolCalls(res, calls)
    return
  }

  answer(res, body.model, [
    `作答模型 ${body.model}。`,
    '这是第一段回答，用来确认逐字流式与落库内容一致。',
    '这是第二段。',
  ])
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-upstream] http://127.0.0.1:${PORT} 日志 ${LOG}`)
})
