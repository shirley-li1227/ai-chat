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

/** 发给后端的上一轮工具轨迹：后端据此还原 assistant(tool_calls) → tool 消息链 */
export interface OutboundStep {
  id: string
  name: string
  arguments: string
  result: string
  ok: boolean
}

/** 发给后端的历史消息 */
export interface OutboundMessage {
  role: MessageRole
  content: string
  toolCalls?: OutboundStep[]
}
