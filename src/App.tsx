import { useEffect, useState } from 'react'
import { streamZhipuChat } from './api'
import ChatInterface from './components/ChatInterface'
import type { Conversation, Message } from './types'

const STORAGE_KEY = 'ai-chat-conversations'

function isMessageArray(value: unknown): value is Message[] {
  if (!Array.isArray(value)) {
    return false
  }

  return value.every((item) => {
    if (!item || typeof item !== 'object') {
      return false
    }

    const candidate = item as Partial<Message>
    return (
      (candidate.role === 'user' || candidate.role === 'assistant') &&
      typeof candidate.content === 'string' &&
      typeof candidate.timestamp === 'number'
    )
  })
}

function isConversationArray(value: unknown): value is Conversation[] {
  if (!Array.isArray(value)) {
    return false
  }

  return value.every((item) => {
    if (!item || typeof item !== 'object') {
      return false
    }

    const candidate = item as Partial<Conversation>
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.title === 'string' &&
      typeof candidate.createdAt === 'number' &&
      typeof candidate.updatedAt === 'number' &&
      isMessageArray(candidate.messages)
    )
  })
}

function createConversation(): Conversation {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: '新对话',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

function buildConversationTitle(messages: Message[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user')
  if (!firstUserMessage) {
    return '新对话'
  }

  return firstUserMessage.content.slice(0, 24) || '新对话'
}

function sortConversationsByCreatedAt(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => b.createdAt - a.createdAt)
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string>('')
  const [isSending, setIsSending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    const rawHistory = localStorage.getItem(STORAGE_KEY)
    if (!rawHistory) {
      const initialConversation = createConversation()
      setConversations([initialConversation])
      setActiveConversationId(initialConversation.id)
      return
    }

    try {
      const parsed = JSON.parse(rawHistory) as unknown
      if (isConversationArray(parsed) && parsed.length > 0) {
        const sortedConversations = sortConversationsByCreatedAt(parsed)
        setConversations(sortedConversations)
        setActiveConversationId(sortedConversations[0].id)
        return
      }

      // Backward compatibility: migrate old single-message history.
      if (isMessageArray(parsed)) {
        const now = Date.now()
        const migratedConversation: Conversation = {
          id: crypto.randomUUID(),
          title: buildConversationTitle(parsed),
          messages: parsed,
          createdAt: now,
          updatedAt: now,
        }
        setConversations(sortConversationsByCreatedAt([migratedConversation]))
        setActiveConversationId(migratedConversation.id)
        return
      }

      const initialConversation = createConversation()
      setConversations([initialConversation])
      setActiveConversationId(initialConversation.id)
    } catch {
      localStorage.removeItem(STORAGE_KEY)
      const initialConversation = createConversation()
      setConversations([initialConversation])
      setActiveConversationId(initialConversation.id)
    }
  }, [])

  useEffect(() => {
    if (conversations.length === 0) {
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
  }, [conversations])

  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const activeMessages = activeConversation?.messages ?? []
  const hasEmptyConversation = conversations.some((conversation) => conversation.messages.length === 0)

  const handleSend = async (content: string) => {
    if (!activeConversation) {
      return
    }

    setErrorMessage(null)

    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    const assistantTimestamp = Date.now() + 1
    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      timestamp: assistantTimestamp,
    }
    const historyForApi = [...activeConversation.messages, userMessage]

    setConversations((prev) =>
      prev.map((conversation) => {
        if (conversation.id !== activeConversation.id) {
          return conversation
        }

        const nextMessages = [...conversation.messages, userMessage, assistantMessage]
        return {
          ...conversation,
          messages: nextMessages,
          title: buildConversationTitle(nextMessages),
          updatedAt: Date.now(),
        }
      }),
    )
    setIsSending(true)

    try {
      for await (const chunk of streamZhipuChat(historyForApi)) {
        setConversations((prev) =>
          prev.map((conversation) => {
            if (conversation.id !== activeConversation.id) {
              return conversation
            }

            return {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.timestamp === assistantTimestamp
                  ? { ...message, content: message.content + chunk }
                  : message,
              ),
              updatedAt: Date.now(),
            }
          }),
        )
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : '请求失败，请稍后重试。'
      setErrorMessage(`请求失败：${errorMessage}`)
      setConversations((prev) =>
        prev.map((conversation) => {
          if (conversation.id !== activeConversation.id) {
            return conversation
          }

          return {
            ...conversation,
            messages: conversation.messages.map((message) =>
              message.timestamp === assistantTimestamp
                ? { ...message, content: `抱歉，暂时无法回答。\n\n${errorMessage}` }
                : message,
            ),
            updatedAt: Date.now(),
          }
        }),
      )
    } finally {
      setIsSending(false)
    }
  }

  const handleNewChat = () => {
    if (hasEmptyConversation) {
      const emptyConversation = conversations.find((conversation) => conversation.messages.length === 0)
      if (emptyConversation) {
        setActiveConversationId(emptyConversation.id)
      }
      setErrorMessage(null)
      return
    }

    const newConversation = createConversation()
    setConversations((prev) => sortConversationsByCreatedAt([...prev, newConversation]))
    setActiveConversationId(newConversation.id)
    setErrorMessage(null)
  }

  const handleSelectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId)
    setErrorMessage(null)
  }

  const handleDeleteConversation = (conversationId: string) => {
    setConversations((prev) => {
      const filtered = prev.filter((conversation) => conversation.id !== conversationId)
      if (filtered.length === 0) {
        const fallback = createConversation()
        setActiveConversationId(fallback.id)
        return [fallback]
      }

      if (activeConversationId === conversationId) {
        setActiveConversationId(filtered[0].id)
      }
      return filtered
    })
    setErrorMessage(null)
  }

  return (
    <ChatInterface
      conversations={conversations}
      activeConversationId={activeConversationId}
      hasEmptyConversation={hasEmptyConversation}
      messages={activeMessages}
      isSending={isSending}
      errorMessage={errorMessage}
      onSend={handleSend}
      onNewChat={handleNewChat}
      onSelectConversation={handleSelectConversation}
      onDeleteConversation={handleDeleteConversation}
    />
  )
}

export default App
