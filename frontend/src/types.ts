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
  /** 本轮实际作答的模型：服务端按场景路由后，配置里那个名字不再等于答案来源 */
  model?: string
  /** 为什么是这个模型，只在流式那一轮有；历史消息只有模型名 */
  modelReason?: string
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
