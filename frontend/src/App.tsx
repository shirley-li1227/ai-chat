import { useCallback, useEffect, useRef, useState } from 'react'
import ChatInterface from './components/ChatInterface'
import type { Conversation, Message, ToolStep } from './types'
import { streamChat, toOutboundMessages } from './client'
import { loadConversations, removeConversation, saveConversation } from './storage'

const STORAGE_DOWN = '本地存储不可用，本次对话刷新后不会保留。'

function newConversation(): Conversation {
  const now = Date.now()
  return { id: crypto.randomUUID(), title: '新对话', messages: [], createdAt: now, updatedAt: now }
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string>('')
  const [isSending, setIsSending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // 首屏要从 IndexedDB 读回会话列表，读之前列表是空的，得给个明确的加载提示
  const [booting, setBooting] = useState(true)
  const abortRef = useRef<AbortController | null>(null)

  const upsert = useCallback((conversation: Conversation) => {
    setConversations((prev) => {
      const index = prev.findIndex((item) => item.id === conversation.id)
      if (index < 0) {
        return [conversation, ...prev]
      }
      const next = [...prev]
      next[index] = conversation
      return next
    })
    // 落盘失败（配额满/隐私模式）不该打断正在进行的流，只提示一次
    saveConversation(conversation).catch(() => setErrorMessage(STORAGE_DOWN))
  }, [])

  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        const list = await loadConversations()
        if (cancelled) return
        const first = list[0] ?? newConversation()
        if (!list.length) {
          await saveConversation(first)
        }
        setConversations(list.length ? list : [first])
        setActiveConversationId(first.id)
      } catch {
        if (!cancelled) {
          setErrorMessage(STORAGE_DOWN)
          const fallback = newConversation()
          setConversations([fallback])
          setActiveConversationId(fallback.id)
        }
      } finally {
        if (!cancelled) setBooting(false)
      }
    }
    boot()
    return () => {
      cancelled = true
    }
  }, [])

  // 离开页面 / 组件卸载时主动断开在途的 SSE 流：
  // 浏览器虽会在整页卸载时自动断连，但 CloudBase 网关对 SSE 的 close 透传不保证实时，
  // 主动 abort 可及时停掉后端对上游大模型的请求，避免继续消耗额度。
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

  /**
   * 发送一轮并接管持久化。
   *
   * 上下文完全由 `base.messages` 决定（不读组件状态）：重新生成/编辑重发会先回退
   * 再立刻重发，此时 setState 还没提交，读状态会把要丢掉的那轮再发一遍。
   */
  const runSend = useCallback(
    async (base: Conversation, content: string) => {
      const title = base.messages.some((message) => message.role === 'user')
        ? base.title
        : content.slice(0, 24) || '新对话'

      const userMessage: Message = { role: 'user', content, timestamp: Date.now() }
      const assistantTimestamp = userMessage.timestamp + 1
      const assistantMessage: Message = {
        role: 'assistant',
        content: '',
        timestamp: assistantTimestamp,
        steps: [],
      }
      // 本轮的权威快照：流结束时按它落盘，界面状态只是它的镜像
      const messages = [...base.messages, userMessage, assistantMessage]
      const snapshot = (partial?: { content?: string; steps?: ToolStep[] }): Conversation => ({
        ...base,
        title,
        messages: messages.map((message) =>
          message.timestamp === assistantTimestamp
            ? {
                ...message,
                content: partial?.content ?? message.content,
                steps: partial?.steps ?? message.steps,
              }
            : message,
        ),
        updatedAt: Date.now(),
      })

      setErrorMessage(null)
      upsert(snapshot())
      setIsSending(true)

      const controller = new AbortController()
      abortRef.current = controller

      // 局部累加：每个 chunk 都走一遍 setState 里的 map 太吵，流结束时统一收口
      let liveContent = ''
      let failed = false
      const liveSteps: ToolStep[] = []

      /** 把当前累加结果镜像到界面 */
      const paint = () => {
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.id === base.id
              ? {
                  ...conversation,
                  messages: conversation.messages.map((message) =>
                    message.timestamp === assistantTimestamp
                      ? {
                          ...message,
                          content: liveContent,
                          steps: liveSteps.map((step) => ({ ...step })),
                        }
                      : message,
                  ),
                  title,
                  updatedAt: Date.now(),
                }
              : conversation,
          ),
        )
      }

      try {
        await streamChat(
          toOutboundMessages(base.messages),
          content,
          (chunk) => {
            liveContent += chunk
            paint()
          },
          (step) => {
            // calling 追加新条目；done/error 按 id 回填
            if (step.status === 'calling') {
              liveSteps.push(step)
            } else {
              const matchIndex = step.id
                ? liveSteps.findIndex((s) => s.id === step.id)
                : liveSteps.findIndex((s) => s.name === step.name && s.result === undefined)
              if (matchIndex >= 0) {
                liveSteps[matchIndex] = { ...liveSteps[matchIndex], ...step }
              } else {
                liveSteps.push(step)
              }
            }
            paint()
          },
          (text) => {
            // 流内非致命提示（如回答被长度上限截断）：复用顶部警告横幅，保留已生成内容
            setErrorMessage(text)
          },
          controller.signal,
        )
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          const msg = error instanceof Error ? error.message : '请求失败，请稍后重试。'
          setErrorMessage(`请求失败：${msg}`)
          liveContent = `抱歉，暂时无法回答。\n\n${msg}`
          failed = true
          paint()
        }
      } finally {
        abortRef.current = null
        setIsSending(false)
        // 失败提示只留在界面里，不写进历史：它不是回答，下一轮更不该带上它
        if (liveContent && !failed) {
          upsert(snapshot({ content: liveContent, steps: liveSteps }))
        }
      }
    },
    [upsert],
  )

  const handleSend = useCallback(
    async (content: string) => {
      const target = activeConversation ?? newConversation()
      await runSend(target, content)
    },
    [activeConversation, runSend],
  )

  const handleStop = () => {
    abortRef.current?.abort()
  }

  /** 把会话回退到某条消息之前：界面与本地存储一起改，不存在跨端一致性问题 */
  const rewindTo = useCallback(
    (conversation: Conversation, messageTimestamp: number): Conversation => {
      const truncated: Conversation = {
        ...conversation,
        messages: conversation.messages.filter(
          (message) => message.timestamp < messageTimestamp,
        ),
        updatedAt: Date.now(),
      }
      upsert(truncated)
      return truncated
    },
    [upsert],
  )

  /**
   * 重新生成：连同上一条用户消息一起回退再原样重发。
   * 若只删 assistant 回答、保留 user 消息，重发会让同一句话在历史里出现两遍。
   */
  const handleRegenerate = async () => {
    if (!activeConversation || isSending) {
      return
    }

    const lastUserMessage = [...activeConversation.messages]
      .reverse()
      .find((message) => message.role === 'user')
    if (!lastUserMessage) {
      return
    }

    setErrorMessage(null)
    const truncated = rewindTo(activeConversation, lastUserMessage.timestamp)
    await runSend(truncated, lastUserMessage.content)
  }

  /**
   * 编辑重发：回退到该条用户消息之前，把原文交回输入框由用户改。
   * 这里只返回内容、不直接操作输入框，是为了让 input 状态继续由 ChatInterface 持有。
   */
  const handleEditMessage = async (message: Message): Promise<string | null> => {
    if (isSending || message.role !== 'user' || !activeConversation) {
      return null
    }

    setErrorMessage(null)
    rewindTo(activeConversation, message.timestamp)
    return message.content
  }

  const handleNewChat = () => {
    if (hasEmptyConversation) {
      const emptyConversation = conversations.find(
        (conversation) => conversation.messages.length === 0,
      )
      if (emptyConversation) {
        setActiveConversationId(emptyConversation.id)
      }
      setErrorMessage(null)
      return
    }

    const conversation = newConversation()
    upsert(conversation)
    setActiveConversationId(conversation.id)
    setErrorMessage(null)
  }

  const handleSelectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId)
    setErrorMessage(null)
  }

  const handleDeleteConversation = (conversationId: string) => {
    removeConversation(conversationId).catch(() => setErrorMessage(STORAGE_DOWN))
    setConversations((prev) => {
      const filtered = prev.filter((conversation) => conversation.id !== conversationId)
      if (filtered.length === 0) {
        const fallback = newConversation()
        saveConversation(fallback).catch(() => undefined)
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

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-gradient-to-br from-slate-50 via-white to-emerald-50/70 text-sm text-slate-500">
        <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
        </svg>
        正在读取本地对话…
      </div>
    )
  }

  return (
    <ChatInterface
      conversations={conversations}
      activeConversationId={activeConversationId}
      hasEmptyConversation={hasEmptyConversation}
      messages={activeMessages}
      isSending={isSending}
      errorMessage={errorMessage}
      onStop={handleStop}
      onSend={handleSend}
      onRegenerate={handleRegenerate}
      onEditMessage={handleEditMessage}
      onNewChat={handleNewChat}
      onSelectConversation={handleSelectConversation}
      onDeleteConversation={handleDeleteConversation}
    />
  )
}

export default App
