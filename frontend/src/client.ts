import type {
  ApiConfig,
  BackgroundTask,
  Conversation,
  TaskKindInfo,
  ToolStep,
} from './types'

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

export interface AuthMode {
  authEnabled: boolean
  user: AuthUser | null
}

/**
 * 首屏先问后端当前是不是免登录模式：免登录时身份由后端给出，本地没有 token 也照常进入主界面。
 * 拿不到结果就按真实登录处理——把需要鉴权的部署误判成免登录，比多显示一次登录页严重得多。
 */
export async function fetchAuthMode(): Promise<AuthMode> {
  const res = await authedFetch('/auth/mode', undefined, { silentUnauthorized: true })
  if (!res.ok) {
    return { authEnabled: true, user: null }
  }
  return (await res.json()) as AuthMode
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
      model: string | null
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
        ...(m.model ? { model: m.model } : {}),
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

// --- Background tasks ---

interface RawTask {
  id: string
  kind: string
  conversationId: string | null
  status: BackgroundTask['status']
  payload: string
  result: string | null
  error: string | null
  progress: number
  attempts: number
  createdAt: string
  updatedAt: string
  startedAt: number | null
  finishedAt: number | null
}

function toTask(raw: RawTask): BackgroundTask {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(raw.payload) as Record<string, unknown>
  } catch {
    // 后端存的是自己序列化的 JSON，解析失败只影响展示，不该让整张列表消失
  }
  return {
    id: raw.id,
    kind: raw.kind,
    conversationId: raw.conversationId,
    status: raw.status,
    payload,
    result: raw.result,
    error: raw.error,
    progress: raw.progress,
    attempts: raw.attempts,
    createdAt: new Date(raw.createdAt).getTime(),
    updatedAt: new Date(raw.updatedAt).getTime(),
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
  }
}

async function taskError(res: Response, fallback: string): Promise<never> {
  const data = (await res.json().catch(() => null)) as { message?: string | string[] } | null
  throw new Error(errorMessageFrom(data) || `${fallback}（${res.status}）`)
}

/** runnerEnabled 关掉时任务只会排队，界面要能解释「为什么一直不动」 */
export async function fetchTasks(): Promise<{
  items: BackgroundTask[]
  counts: { queued: number; running: number }
  runnerEnabled: boolean
}> {
  const res = await authedFetch('/tasks')
  if (!res.ok) {
    return taskError(res, '获取后台任务失败')
  }
  const data = (await res.json()) as {
    items: RawTask[]
    counts: { queued: number; running: number }
    runnerEnabled: boolean
  }
  return { items: data.items.map(toTask), counts: data.counts, runnerEnabled: data.runnerEnabled }
}

export interface TaskKindMeta {
  kinds: TaskKindInfo[]
  runnerEnabled: boolean
}

export async function fetchTaskKinds(): Promise<TaskKindMeta> {
  const res = await authedFetch('/tasks/meta/kinds')
  if (!res.ok) {
    return taskError(res, '获取任务类型失败')
  }
  return (await res.json()) as TaskKindMeta
}

export async function createTask(input: {
  kind: string
  payload: Record<string, unknown>
  conversationId?: string
}): Promise<BackgroundTask> {
  const res = await authedFetch('/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    return taskError(res, '提交后台任务失败')
  }
  return toTask((await res.json()) as RawTask)
}

export async function cancelTask(id: string): Promise<BackgroundTask> {
  const res = await authedFetch(`/tasks/${id}/cancel`, { method: 'POST' })
  if (!res.ok) {
    return taskError(res, '取消后台任务失败')
  }
  return toTask((await res.json()) as RawTask)
}

// --- Chat (SSE stream) ---

/**
 * 流被打断。
 *
 * retryable=true 表示界面上已经渲染出来的那段还有救：拿它调 resumeChat 续写后半段。
 * 密钥失效、额度不足这类是 false——重试只会再烧一次额度并把同一句报错再说一遍。
 */
export class ChatStreamError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'ChatStreamError'
    this.retryable = retryable
  }
}

/** 用户主动停止或离开页面：这不是故障，半截回答要原样留着 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * 一路 SSE 的回调集合。
 *
 * 用对象而不是继续往下排位置参数：onChunk / onNotice 签名一模一样，
 * 再加一个回调就可能悄悄接错，而 TS 抓不到同类型的顺序错误。
 */
export interface ChatStreamHandlers {
  onChunk: (text: string) => void
  onStep: (step: ToolStep) => void
  onNotice: (text: string) => void
  /** 本轮实际使用的模型与选择理由：服务端按场景路由后，配置里那个主力模型名不再等于答案来源 */
  onModel?: (info: ModelInfo) => void
  signal?: AbortSignal
}

export interface ModelInfo {
  id: string
  reason: string
  score: number
}

async function runChatStream(
  path: string,
  body: unknown,
  handlers: ChatStreamHandlers,
): Promise<void> {
  const { onChunk, onStep, onNotice, onModel, signal } = handlers
  let res: Response
  try {
    res = await authedFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    // 连接压根没建立（离线、DNS、网关故障），此时没有任何可续传的进度
    throw new ChatStreamError('无法连接到后端服务，请检查网络后重试。', true)
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as
      | { message?: string | string[]; error?: string }
      | null
    // 流没建立时后端仍走普通 JSON 错误响应，直接把 message 当提示用
    throw new ChatStreamError(errorMessageFrom(data) || `请求失败（${res.status}）`, false)
  }

  if (!res.body) {
    throw new ChatStreamError('未返回可读取的流', false)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false

  try {
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
        if (!payload) continue
        if (payload === '[DONE]') {
          completed = true
          continue
        }

        try {
          const parsed = JSON.parse(payload)
          if (parsed.error) {
            throw new ChatStreamError(String(parsed.error), parsed.retryable === true)
          }
          // 流内非致命提示（如回答被长度上限截断）：交给界面展示，不中断流
          if (parsed.notice) {
            onNotice(String(parsed.notice))
          }
          // 模型路由事件：一条流开头发一次，界面据此说明「刚才是哪个模型在答」
          if (parsed.model) {
            onModel?.(parsed.model as ModelInfo)
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
  } catch (error) {
    if (error instanceof ChatStreamError || isAbortError(error)) {
      throw error
    }
    // reader 抛错基本都是 TCP 连接被掐：已经收到的那部分是真实进度，可以续
    throw new ChatStreamError('与后端的连接中断了。', true)
  }

  if (!completed) {
    // 没等到 [DONE] 就结束：网关掐流、函数超时会这样。当成「未完成」而不是「完成」，
    // 否则半截回答会被静默视作完整结果，界面连续传的机会都没有
    throw new ChatStreamError('连接在完成前中断。', true)
  }
}

export function streamChat(
  conversationId: string,
  content: string,
  handlers: ChatStreamHandlers,
): Promise<void> {
  return runChatStream('/chat', { conversationId, content }, handlers)
}

/**
 * 断点续传：partial 是浏览器已经渲染的前半段，服务端接着它往下写，回调只收到后半段。
 *
 * 进度由客户端携带而不是服务端缓存：云函数按连接调度实例，重连落到哪个实例不可控，
 * 上个实例的内存和它那份 /tmp 库都可能不是这一轮的现场。上游也没有「从第 N 个 token
 * 继续」的语义，所以这是一次新请求、会重新计一遍上下文 token，换回来的是不重复生成、
 * 用户看到的仍是一条连贯回答。
 */
export function resumeChat(
  conversationId: string,
  content: string,
  partial: string,
  handlers: ChatStreamHandlers,
): Promise<void> {
  return runChatStream('/chat/resume', { conversationId, content, partial }, handlers)
}
