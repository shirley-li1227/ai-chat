export type MessageRole = 'user' | 'assistant'

export type ToolStepStatus = 'calling' | 'done' | 'error'

/** Agent 工具调用轨迹条目 */
export interface ToolStep {
  id?: string
  name: string
  args: Record<string, unknown>
  result?: string
  status: ToolStepStatus
}

export interface Message {
  role: MessageRole
  content: string
  timestamp: number
  /** Agent 本轮自主调用工具的过程 */
  steps?: ToolStep[]
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

export type ProviderType = 'deepseek'

export interface ApiConfig {
  provider: ProviderType
  apiKey: string
  baseUrl: string
  model: string
}

// --- 后台任务 ---

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface BackgroundTask {
  id: string
  kind: string
  conversationId: string | null
  status: TaskStatus
  payload: Record<string, unknown>
  result: string | null
  error: string | null
  progress: number
  attempts: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface TaskKindField {
  name: string
  type: 'string' | 'object' | 'number' | 'boolean'
  required: boolean
  description: string
  enum?: string[]
}

export interface TaskKindInfo {
  kind: string
  description: string
  fields: TaskKindField[]
}
