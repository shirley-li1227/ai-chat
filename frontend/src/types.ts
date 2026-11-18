export type MessageRole = 'user' | 'assistant'

export type ToolStepStatus = 'calling' | 'streaming' | 'done' | 'error'

/** 工具执行期间的量化进度，字段按补丁语义合并：缺省即保持上一次的值 */
export interface ToolProgress {
  phase?: string
  receivedBytes?: number
  maxBytes?: number
  textChars?: number
}

/** Agent 工具调用轨迹条目 */
export interface ToolStep {
  id?: string
  name: string
  args: Record<string, unknown>
  result?: string
  status: ToolStepStatus
  /** 执行期间逐段累加的结果正文，终态事件到齐后与 result 相同 */
  delta?: string
  progress?: ToolProgress
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

export type ProviderType = 'deepseek' | 'zhipu'

export interface ApiConfig {
  provider: ProviderType
  apiKey: string
  baseUrl: string
  model: string
}

/** 后端 /api/config 回的一份配置：Key 只有掩码，明文不进浏览器 */
export interface ApiConfigView {
  provider: ProviderType
  label: string
  baseUrl: string
  model: string
  apiKeyMasked: string
  active: boolean
  routingCandidates: string | null
  updatedAt: string
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

// --- 跨会话长期记忆 ---

export type MemorySource = 'model' | 'user'

export interface MemoryItem {
  id: string
  /** 给模型看的 8 位编号，也是 forget 的参数 */
  handle: string
  content: string
  source: MemorySource
  updatedAt: number
}

export interface MemoryLimits {
  /** 后端 MEMORY_ENABLED 的实时状态：关掉后模型不再记录也不再注入，界面上要看得出来 */
  enabled: boolean
  maxEntries: number
  itemMaxChars: number
  injectMaxChars: number
}

export interface MemoryList {
  items: MemoryItem[]
  limits: MemoryLimits
}
