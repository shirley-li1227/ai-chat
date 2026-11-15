import type { ApiConfig, Conversation, ToolStep } from './types'

// 同源部署时留空走相对路径；前后端分域时通过 VITE_API_BASE 指定绝对地址
// 本地开发走相对 /api，由 vite.config.ts 代理到 http://localhost:3001
const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '') || '/api'

// --- Auth ---

export interface AuthUser {
  id: string
  username: string
}

export interface AuthSession {
  token: string
  user: AuthUser
}

/**
 * token 放 localStorage 而不是 cookie：后端是独立的云函数域名，跨站 Cookie
 * 需要 SameSite=None 且依赖网关配合；代价是 XSS 可读，靠 React 转义兜底。
 */
const TOKEN_KEY = 'ai-chat.token'

/** 任意接口返回 401（登录过期）时广播，由 App 收回登录态并回到登录页 */
export const UNAUTHORIZED_EVENT = 'ai-chat:unauthorized'

let authToken: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    // 隐私模式下 localStorage 会直接抛异常，不能因为读缓存失败白屏
    return null
  }
})()

export function setAuthToken(token: string | null): void {
  authToken = token
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // 存不下就只在当前标签页内存里维持，刷新后回到未登录
  }
}

export function getAuthToken(): string | null {
  return authToken
}

interface FetchOptions {
  /** 登录态探测接口本身就期望 401，不该触发广播 */
  silentUnauthorized?: boolean
}

async function authedFetch(
  path: string,
  init?: RequestInit,
  options: FetchOptions = {},
): Promise<Response> {
  const headers = { ...(init?.headers as Record<string, string> | undefined) }
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers })

  if (res.status === 401 && !options.silentUnauthorized) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
  return res
}

/** Nest 的 message 在校验失败时是数组，不拼起来会弹成 [object Object] */
function errorMessageFrom(data: { message?: string | string[] } | null): string {
  const raw = data?.message
  return Array.isArray(raw) ? raw.join('；') : (raw ?? '')
}

async function postAuth<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as
    | (T & { message?: string | string[] })
    | null
  if (!res.ok) {
    throw new Error(errorMessageFrom(data) || '请求失败，请稍后重试')
  }
  return data as T
}

export function registerUser(username: string, password: string): Promise<AuthSession> {
  return postAuth<AuthSession>('/auth/register', { username, password })
}

export function loginUser(username: string, password: string): Promise<AuthSession> {
  return postAuth<AuthSession>('/auth/login', { username, password })
}

/** 首屏判断登录态：无 token 直接未登录，省掉一次必然 401 的请求 */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  if (!authToken) {
    return null
  }
  const res = await authedFetch('/auth/me', undefined, { silentUnauthorized: true })
  if (!res.ok) {
    setAuthToken(null)
    return null
  }
  return (await res.json()) as AuthUser
}

export async function logoutUser(): Promise<void> {
  const token = authToken
  // 先本地清干净：后端删除会话失败不该把用户卡在已登录界面
  setAuthToken(null)
  if (!token) {
    return
  }
  await authedFetch('/auth/logout', { method: 'POST' }, { silentUnauthorized: true }).catch(
    () => undefined,
  )
}

// --- Config ---

export interface ConfigResponse {
  provider: string
  baseUrl: string
  model: string
  apiKeyMasked: string
}

export async function fetchConfig(): Promise<ConfigResponse | null> {
  const res = await authedFetch('/config')
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
  const res = await authedFetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: string | string[] } | null
    throw new Error(errorMessageFrom(data) || '保存配置失败')
  }
}

export async function clearConfig(): Promise<void> {
  await authedFetch('/config', { method: 'DELETE' })
}


// --- Conversations ---

export async function fetchConversations(): Promise<Conversation[]> {
  const res = await authedFetch('/conversations')
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
  const res = await authedFetch(`/conversations/${id}`)
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
  const res = await authedFetch('/conversations', { method: 'POST' })
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
  await authedFetch(`/conversations/${id}`, { method: 'DELETE' })
}

/**
 * 回到某个时刻：删除 fromTimestamp 及之后的消息。
 * “重新生成”与“编辑重发”都靠它把上下文退回去，再走正常发送流程重新落库。
 */
export async function truncateConversation(
  id: string,
  fromTimestamp: number,
): Promise<void> {
  const res = await authedFetch(`/conversations/${id}/truncate`, {
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
  const res = await authedFetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, content }),
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
