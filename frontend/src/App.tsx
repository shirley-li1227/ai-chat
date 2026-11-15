import { useCallback, useEffect, useRef, useState } from 'react'
import ApiConfigModal from './components/ApiConfigModal'
import ChatInterface from './components/ChatInterface'
import type { ApiConfig, Conversation, Message, ToolStep } from './types'
import {
  createConversation,
  deleteConversation as apiDeleteConversation,
  truncateConversation,
  fetchConfig,
  fetchConversation,
  fetchConversations,
  saveConfig,
  clearConfig,
  streamChat,
} from './client'
import type { ConfigResponse } from './client'

const BACKEND_DOWN = '无法连接到后端服务，请确认已启动 npm run dev:api'

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string>('')
  const [isSending, setIsSending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [configStatus, setConfigStatus] = useState<ConfigResponse | null>(null)
  const [hasConfig, setHasConfig] = useState(false)
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  /** 拉会话列表，没有就建一个；返回当前应使用的会话。 */
  const loadConversations = useCallback(async (): Promise<Conversation> => {
    const list = await fetchConversations()
    if (list.length > 0) {
      setConversations(list)
      setActiveConversationId(list[0].id)
      return list[0]
    }

    const conv = await createConversation()
    setConversations([conv])
    setActiveConversationId(conv.id)
    return conv
  }, [])

  // Load config and conversations on mount
  useEffect(() => {
    const init = async () => {
      try {
        const cfg = await fetchConfig()
        setConfigStatus(cfg)
        setHasConfig(cfg !== null)
        await loadConversations()
      } catch {
        // Backend not available yet
        setErrorMessage(BACKEND_DOWN)
      }
    }
    init()
  }, [loadConversations])

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

  // 离开页面 / 组件卸载时主动断开在途的 SSE 流：
  // 浏览器虽会在整页卸载时自动断连，但 CloudBase 网关对 SSE 的 close 透传不保证实时，
  // 主动 abort 可及时停掉后端对上游大模型的请求，避免继续消耗额度、落库半截回答。
  useEffect(() => {
    const onLeave = () => abortRef.current?.abort()
    window.addEventListener('pagehide', onLeave)
    return () => {
      window.removeEventListener('pagehide', onLeave)
      abortRef.current?.abort()
    }
  }, [])

  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const activeMessages = activeConversation?.messages ?? []
  const hasEmptyConversation = conversations.some((conversation) => conversation.messages.length === 0)

  const handleSend = async (content: string) => {
    // 首屏加载撞上后端重启时会话列表会停在空态，这里补拉一次而不是无声失败
    const target =
      activeConversation ?? (await loadConversations().catch(() => null))
    if (!target) {
      setErrorMessage(BACKEND_DOWN)
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
        if (conversation.id !== target.id) {
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
        target.id,
        content,
        (chunk) => {
          setConversations((prev) =>
            prev.map((conversation) => {
              if (conversation.id !== target.id) {
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
              if (conversation.id !== target.id) {
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
      const refreshed = await fetchConversation(target.id)
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === target.id ? refreshed : conversation,
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
            if (conversation.id !== target.id) {
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

  /**
   * 把会话回退到某条消息之前：先改后端，再同步本地状态。
   * 顺序不能反——本地先删、后端失败，会留下“界面没了、库里还在”的不一致，
   * 刷新后消息复活，比什么都不做更让人困惑。
   */
  const rewindTo = async (conversationId: string, messageTimestamp: number) => {
    await truncateConversation(conversationId, messageTimestamp)
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              messages: conversation.messages.filter(
                (message) => message.timestamp < messageTimestamp,
              ),
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    )
  }

  /**
   * 重新生成：连同上一条用户消息一起回退再原样重发。
   * 若只删 assistant 回答、保留 user 消息，重发会让同一句话在库里出现两遍，
   * 下一轮上下文因此多出一条重复提问。
   */
  const handleRegenerate = async () => {
    if (!activeConversation || isSending || !hasConfig) {
      return
    }

    const lastUserMessage = [...activeConversation.messages]
      .reverse()
      .find((message) => message.role === 'user')
    if (!lastUserMessage) {
      return
    }

    setErrorMessage(null)
    try {
      await rewindTo(activeConversation.id, lastUserMessage.timestamp)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '回退对话失败')
      return
    }

    // 截断后走正常发送流程：用户消息会重新落库，回答也是全新一条
    await handleSend(lastUserMessage.content)
  }

  /**
   * 编辑重发：回退到该条用户消息之前，把原文交回输入框由用户改。
   * 这里只返回内容、不直接操作输入框，是为了让 input 状态继续由 ChatInterface 持有。
   */
  const handleEditMessage = async (message: Message): Promise<string | null> => {
    if (isSending || message.role !== 'user' || !activeConversationId) {
      return null
    }

    setErrorMessage(null)
    try {
      await rewindTo(activeConversationId, message.timestamp)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '回退对话失败')
      return null
    }

    return message.content
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
        onRegenerate={handleRegenerate}
        onEditMessage={handleEditMessage}
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
