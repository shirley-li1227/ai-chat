import { useCallback, useEffect, useRef, useState } from 'react'
import ApiConfigModal from './components/ApiConfigModal'
import ChatInterface from './components/ChatInterface'
import type { ApiConfig, Conversation, Message, ToolStep } from './types'
import {
  createConversation,
  deleteConversation as apiDeleteConversation,
  fetchConfig,
  fetchConversation,
  fetchConversations,
  saveConfig,
  clearConfig,
  streamChat,
} from './client'
import type { ConfigResponse } from './client'

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string>('')
  const [isSending, setIsSending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [configStatus, setConfigStatus] = useState<ConfigResponse | null>(null)
  const [hasConfig, setHasConfig] = useState(false)
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Load config and conversations on mount
  useEffect(() => {
    const init = async () => {
      try {
        const cfg = await fetchConfig()
        setConfigStatus(cfg)
        setHasConfig(cfg !== null)

        const list = await fetchConversations()
        if (list.length > 0) {
          setConversations(list)
          setActiveConversationId(list[0].id)
        } else {
          const conv = await createConversation()
          setConversations([conv])
          setActiveConversationId(conv.id)
        }
      } catch {
        // Backend not available yet
        setErrorMessage('无法连接到后端服务，请确认已启动 npm run start:dev')
      }
    }
    init()
  }, [])

  // Load messages when switching conversation
  useEffect(() => {
    if (!activeConversationId) return
    const loadMessages = async () => {
      try {
        const conv = await fetchConversation(activeConversationId)
        setConversations((prev) =>
          prev.map((c) => (c.id === conv.id ? conv : c)),
        )
      } catch {
        // ignore
      }
    }
    loadMessages()
  }, [activeConversationId])

  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const activeMessages = activeConversation?.messages ?? []
  const hasEmptyConversation = conversations.some((conversation) => conversation.messages.length === 0)

  const handleSend = async (content: string) => {
    if (!activeConversation) {
      return
    }

    if (!hasConfig) {
      setErrorMessage('尚未配置大模型 API，请先完成配置。')
      setConfigModalOpen(true)
      return
    }

    setErrorMessage(null)

    // Optimistically add user message + empty assistant message to UI
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
      steps: [],
    }

    setConversations((prev) =>
      prev.map((conversation) => {
        if (conversation.id !== activeConversation.id) {
          return conversation
        }
        const nextMessages = [...conversation.messages, userMessage, assistantMessage]
        return {
          ...conversation,
          messages: nextMessages,
          title: conversation.messages.filter((m) => m.role === 'user').length === 0
            ? content.slice(0, 24) || '新对话'
            : conversation.title,
          updatedAt: Date.now(),
        }
      }),
    )
    setIsSending(true)

    const controller = new AbortController()
    abortRef.current = controller

    // 局部累加，避免每个 chunk 都发 DB 请求
    const liveSteps: ToolStep[] = []

    try {
      await streamChat(
        activeConversation.id,
        content,
        (chunk) => {
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
        },
        (step) => {
          // calling 追加新条目；done/error 回填最近一个同名未完项
          if (step.status === 'calling') {
            liveSteps.push(step)
          } else {
            const matchIndex = step.id
              ? liveSteps.findIndex((s) => s.id === step.id)
              : liveSteps.findLastIndex((s) => s.name === step.name && s.result === undefined)
            if (matchIndex >= 0) {
              liveSteps[matchIndex] = { ...liveSteps[matchIndex], ...step }
            } else {
              liveSteps.push(step)
            }
          }

          setConversations((prev) =>
            prev.map((conversation) => {
              if (conversation.id !== activeConversation.id) {
                return conversation
              }
              return {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.timestamp === assistantTimestamp
                    ? { ...message, steps: [...liveSteps] }
                    : message,
                ),
              }
            }),
          )
        },
        (text) => {
          // 流内非致命提示（如回答被长度上限截断）：复用顶部警告横幅，保留已生成内容
          setErrorMessage(text)
        },
        controller.signal,
      )
      // 流结束后从 DB 重载，确保 steps 轨迹与持久化结果一致
      const refreshed = await fetchConversation(activeConversation.id)
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === activeConversation.id ? refreshed : conversation,
        ),
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // User stopped, keep partial content
      } else {
        const msg = error instanceof Error ? error.message : '请求失败，请稍后重试。'
        setErrorMessage(`请求失败：${msg}`)
        setConversations((prev) =>
          prev.map((conversation) => {
            if (conversation.id !== activeConversation.id) {
              return conversation
            }
            return {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.timestamp === assistantTimestamp
                  ? { ...message, content: `抱歉，暂时无法回答。\n\n${msg}` }
                  : message,
              ),
              updatedAt: Date.now(),
            }
          }),
        )
      }
    } finally {
      abortRef.current = null
      setIsSending(false)
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
  }

  const handleNewChat = async () => {
    if (hasEmptyConversation) {
      const emptyConversation = conversations.find((conversation) => conversation.messages.length === 0)
      if (emptyConversation) {
        setActiveConversationId(emptyConversation.id)
      }
      setErrorMessage(null)
      return
    }

    const conv = await createConversation()
    setConversations((prev) => [conv, ...prev])
    setActiveConversationId(conv.id)
    setErrorMessage(null)
  }

  const handleSelectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId)
    setErrorMessage(null)
  }

  const handleDeleteConversation = async (conversationId: string) => {
    await apiDeleteConversation(conversationId)
    setConversations((prev) => {
      const filtered = prev.filter((conversation) => conversation.id !== conversationId)
      if (filtered.length === 0) {
        const fallback = {
          id: crypto.randomUUID(),
          title: '新对话',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
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

  const handleSaveConfig = async (config: ApiConfig) => {
    await saveConfig(config)
    const cfg = await fetchConfig()
    setConfigStatus(cfg)
    setHasConfig(true)
    setConfigModalOpen(false)
    setErrorMessage(null)
  }

  const handleClearConfig = async () => {
    await clearConfig()
    setConfigStatus(null)
    setHasConfig(false)
  }

  const handleOpenConfig = useCallback(() => {
    setConfigModalOpen(true)
  }, [])

  return (
    <>
      <ChatInterface
        conversations={conversations}
        activeConversationId={activeConversationId}
        hasEmptyConversation={hasEmptyConversation}
        messages={activeMessages}
        isSending={isSending}
        errorMessage={errorMessage}
        apiConfig={configStatus}
        hasConfig={hasConfig}
        onOpenConfig={handleOpenConfig}
        onStop={handleStop}
        onSend={handleSend}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
      />
      <ApiConfigModal
        open={configModalOpen}
        currentConfig={configStatus}
        onClose={() => setConfigModalOpen(false)}
        onSave={handleSaveConfig}
        onClear={handleClearConfig}
      />
    </>
  )
}

export default App
