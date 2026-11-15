import type { ApiConfig, Conversation, ToolStep } from './types'

// 直接写死后端访问地址：CloudBase HTTP 云函数 service 域名 + /api 网关路径
// 前端静态托管域名与函数域名不同源，必须用绝对地址（后端需相应放行 CORS）
const BASE = 'https://lucky-lxy-d1g5yv28gd1a13d29.service.tcloudbase.com/api'

// --- Config ---

export interface ConfigResponse {
  provider: string
  baseUrl: string
  model: string
  apiKeyMasked: string
}

export async function fetchConfig(): Promise<ConfigResponse | null> {
  const res = await fetch(`${BASE}/config`)
  if (!res.ok) {
    return null
  }
  const text = await res.text()
  if (!text) {
    return null
  }
  const data = JSON.parse(text) as { configured: boolean } & ConfigResponse
  if (!data.configured) {
    return null
  }
  return {
    provider: data.provider,
    baseUrl: data.baseUrl,
    model: data.model,
    apiKeyMasked: data.apiKeyMasked,
  }
}

export async function saveConfig(config: ApiConfig): Promise<void> {
  const res = await fetch(`${BASE}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    throw new Error('保存配置失败')
  }
}

export async function clearConfig(): Promise<void> {
  await fetch(`${BASE}/config`, { method: 'DELETE' })
}

// --- Conversations ---

export async function fetchConversations(): Promise<Conversation[]> {
  const res = await fetch(`${BASE}/conversations`)
  if (!res.ok) {
    throw new Error('获取对话列表失败')
  }
  const list = (await res.json()) as Array<{
    id: string
    title: string
    createdAt: string
    updatedAt: string
  }>
  return list.map((c) => ({
    id: c.id,
    title: c.title,
    messages: [],
    createdAt: new Date(c.createdAt).getTime(),
    updatedAt: new Date(c.updatedAt).getTime(),
  }))
}

export async function fetchConversation(id: string): Promise<Conversation> {
  const res = await fetch(`${BASE}/conversations/${id}`)
  if (!res.ok) {
    throw new Error('获取对话失败')
  }
  const data = (await res.json()) as {
    id: string
    title: string
    createdAt: string
    updatedAt: string
    messages: Array<{
      role: 'user' | 'assistant'
      content: string
      timestamp: number
      toolCalls: string | null
    }>
  }
  return {
    id: data.id,
    title: data.title,
    createdAt: new Date(data.createdAt).getTime(),
    updatedAt: new Date(data.updatedAt).getTime(),
    messages: data.messages.map((m) => {
      let steps: ToolStep[] | undefined
      if (m.toolCalls) {
        try {
          const stored = JSON.parse(m.toolCalls) as Array<{
            id: string
            name: string
            arguments: string
            result: string
            ok: boolean
          }>
          steps = stored.map((s) => {
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(s.arguments) as Record<string, unknown>
            } catch {
              // 保留原始字符串供展示
            }
            return {
              id: s.id,
              name: s.name,
              args,
              result: s.result,
              status: s.ok ? ('done' as const) : ('error' as const),
            }
          })
        } catch {
          // 轨迹损坏时降级为不展示步骤
        }
      }
      return {
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        ...(steps ? { steps } : {}),
      }
    }),
  }
}

export async function createConversation(): Promise<Conversation> {
  const res = await fetch(`${BASE}/conversations`, { method: 'POST' })
  if (!res.ok) {
    throw new Error('创建对话失败')
  }
  const data = (await res.json()) as { id: string; title: string; createdAt: string; updatedAt: string }
  return {
    id: data.id,
    title: data.title,
    messages: [],
    createdAt: new Date(data.createdAt).getTime(),
    updatedAt: new Date(data.updatedAt).getTime(),
  }
}

export async function deleteConversation(id: string): Promise<void> {
  await fetch(`${BASE}/conversations/${id}`, { method: 'DELETE' })
}

/**
 * 回到某个时刻：删除 fromTimestamp 及之后的消息。
 * “重新生成”与“编辑重发”都靠它把上下文退回去，再走正常发送流程重新落库。
 */
export async function truncateConversation(
  id: string,
  fromTimestamp: number,
): Promise<void> {
  const res = await fetch(`${BASE}/conversations/${id}/truncate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromTimestamp }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as
      | { message?: string | string[] }
      | null
    // Nest 校验失败时 message 是数组，不拼起来会弹成 [object Object]
    const raw = data?.message
    const detail = Array.isArray(raw) ? raw.join('；') : raw
    throw new Error(detail ?? '回退对话失败')
  }
}

// --- Chat (SSE stream) ---

export async function streamChat(
  conversationId: string,
  content: string,
  onChunk: (text: string) => void,
  onStep: (step: ToolStep) => void,
  onNotice: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, content }),
    signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `请求失败（${res.status}）`)
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
