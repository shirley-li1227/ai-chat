import type { Message, OutboundMessage, OutboundStep, ToolStep } from './types'

// 同源部署时留空走相对路径；前后端分域时通过 VITE_API_BASE 指定绝对地址
// 本地开发走相对 /api，由 vite.config.ts 代理到 http://localhost:3001
const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '') || '/api'

/** Nest 的 message 在校验失败时是数组，不拼起来会弹成 [object Object] */
function errorMessageFrom(data: { message?: string | string[] } | null): string {
  const raw = data?.message
  return Array.isArray(raw) ? raw.join('；') : (raw ?? '')
}

/**
 * 界面上的消息 → 请求体里的历史。
 * 没有 id 的步骤无法回填 tool_call_id，发出去只会被上游判定消息链不合法，直接略过。
 */
export function toOutboundMessages(messages: Message[]): OutboundMessage[] {
  return messages.map((message) => {
    const steps = (message.steps ?? []).filter(
      (step): step is ToolStep & { id: string } =>
        typeof step.id === 'string' && step.id.length > 0 && step.status !== 'calling',
    )
    const toolCalls: OutboundStep[] = steps.map((step) => ({
      id: step.id,
      name: step.name,
      arguments: JSON.stringify(step.args ?? {}),
      result: step.result ?? '',
      ok: step.status === 'done',
    }))

    return {
      role: message.role,
      content: message.content,
      ...(toolCalls.length ? { toolCalls } : {}),
    }
  })
}

// --- Chat (SSE stream) ---

export async function streamChat(
  history: OutboundMessage[],
  content: string,
  onChunk: (text: string) => void,
  onStep: (step: ToolStep) => void,
  onNotice: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, messages: history }),
    signal,
  })

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as
      | { message?: string | string[]; error?: string }
      | null
    // 流没建立时后端仍走普通 JSON 错误响应，直接把 message 当提示用
    throw new Error(errorMessageFrom(data) || `请求失败（${res.status}）`)
  }

  if (!res.body) {
    throw new Error('未返回可读取的流')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue

      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue

      try {
        const parsed = JSON.parse(payload)
        if (parsed.error) {
          throw new Error(parsed.error)
        }
        // 流内非致命提示（如输出被长度上限截断）：交给界面展示，不中断流
        if (parsed.notice) {
          onNotice(String(parsed.notice))
        }
        if (parsed.content) {
          onChunk(parsed.content)
        }
        // Agent 工具调用事件：calling 新增步骤，done/error 更新同 id 步骤
        if (parsed.tool) {
          onStep(parsed.tool as ToolStep)
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
    }
  }
}
