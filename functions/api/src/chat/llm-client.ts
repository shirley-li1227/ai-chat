import type { PlainApiConfig } from '../config/config.service'

/** 上游 Chat Completions 的一条入站消息 */
export interface LlmMessage {
  role: string
  content: string | null
  tool_calls?: unknown[]
  tool_call_id?: string
}

/**
 * 兼容三种填法：只填站点根、填到 /v1、直接填完整 /chat/completions。
 * 用户在设置弹窗里手打的 baseUrl 形态不可控，这里必须归一，否则拼出双路径 404。
 */
export function resolveCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`
}

export interface CompleteOnceOptions {
  /** 非流式一次性返回，用于摘要这类不需要逐字的内部调用 */
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * 一次性（非流式）调用上游，返回完整文本。
 *
 * 与流式路径分开的理由：摘要这类内部调用不需要逐字展示，走非流式才能拿到
 * 明确的结束信号，也避免为一次后台压缩占着一条 SSE 长连接。
 *
 * 超时是必须的：内部调用若挂住，会把函数 300 秒预算全耗在没有产出的事情上。
 */
export async function completeOnce(
  config: PlainApiConfig,
  messages: LlmMessage[],
  options: CompleteOnceOptions = {},
): Promise<string> {
  const {
    maxTokens = 500,
    temperature = 0.3,
    timeoutMs = 20000,
    signal,
  } = options

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const composite = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  const response = await fetch(resolveCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature,
    }),
    signal: composite,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`上游返回 ${response.status}：${detail.slice(0, 160)}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>
  }
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}
