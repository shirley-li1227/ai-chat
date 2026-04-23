import type { Message } from './types'

const ZHIPU_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const DEFAULT_MODEL = 'glm-4-flash'

interface ZhipuDelta {
  content?: string
}

interface ZhipuChoice {
  delta?: ZhipuDelta
  message?: { content?: string }
}

interface ZhipuStreamChunk {
  choices?: ZhipuChoice[]
}

function getZhipuConfig() {
  const apiKey = import.meta.env.VITE_ZHIPU_API_KEY as string | undefined
  const model = (import.meta.env.VITE_ZHIPU_MODEL as string | undefined) ?? DEFAULT_MODEL

  if (!apiKey) {
    throw new Error('缺少智谱 API Key，请在 .env 中配置 VITE_ZHIPU_API_KEY。')
  }

  return { apiKey, model }
}

function extractDeltaContent(raw: string): string {
  const parsed = JSON.parse(raw) as ZhipuStreamChunk
  const choice = parsed.choices?.[0]
  return choice?.delta?.content ?? choice?.message?.content ?? ''
}

export async function* streamZhipuChat(messages: Message[]): AsyncGenerator<string> {
  const { apiKey, model } = getZhipuConfig()

  const response = await fetch(ZHIPU_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: messages.map(({ role, content }) => ({ role, content })),
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`智谱 API 调用失败（${response.status}）：${errorText || '未知错误'}`)
  }

  if (!response.body) {
    throw new Error('智谱 API 未返回可读取的流。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) {
        continue
      }

      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') {
        continue
      }

      try {
        const delta = extractDeltaContent(payload)
        if (delta) {
          yield delta
        }
      } catch {
        continue
      }
    }
  }
}
