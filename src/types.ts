export type MessageRole = 'user' | 'assistant'

export interface Message {
  role: MessageRole
  content: string
  timestamp: number
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}
