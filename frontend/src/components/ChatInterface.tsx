import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Conversation, Message, ToolStep } from '../types'
import type { ConfigResponse, AuthUser } from '../client'
import TaskPanel from './TaskPanel'

/** 等待首个 token 时的占位：空气泡只有内边距，看不出正在生成 */
function GeneratingIndicator() {
  return (
    <span className="inline-flex items-center gap-2 text-slate-400">
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4 animate-spin"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
      </svg>
      <span>正在思考…</span>
    </span>
  )
}

/** Agent 工具轨迹展示面板 */
function ToolStepsPanel({ steps }: { steps: ToolStep[] }) {
  const [expanded, setExpanded] = useState(true)

  if (!steps.length) {
    return null
  }

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-50/80">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-600 transition hover:bg-slate-100"
      >
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span>调用工具 {steps.length} 次</span>
      </button>

      {expanded ? (
        <ul className="space-y-1.5 border-t border-slate-200/70 px-3 py-2">
          {steps.map((step, index) => (
            <li key={step.id ?? `${step.name}-${index}`} className="text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                    step.status === 'calling'
                      ? 'bg-amber-100 text-amber-600'
                      : step.status === 'error'
                        ? 'bg-red-100 text-red-600'
                        : 'bg-emerald-100 text-emerald-600'
                  }`}
                >
                  {step.status === 'calling' ? '…' : step.status === 'error' ? '!' : '✓'}
                </span>
                <span className="font-mono font-medium text-slate-700">{step.name}</span>
                <span className="text-slate-400">
                  {step.status === 'calling' ? '执行中' : step.status === 'error' ? '失败' : '完成'}
                </span>
              </div>

              {Object.keys(step.args).length > 0 ? (
                <p className="mt-0.5 truncate pl-6 font-mono text-slate-400">
                  {JSON.stringify(step.args)}
                </p>
              ) : null}

              {step.result ? (
                <p className="mt-0.5 line-clamp-3 pl-6 text-slate-500">{step.result}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

interface ChatInterfaceProps {
  user: AuthUser
  /** 免登录模式：当前身份由后端直接给出，没有会话可退出，也不该给出退出入口 */
  demoMode?: boolean
  conversations: Conversation[]
  activeConversationId: string
  hasEmptyConversation: boolean
  messages: Message[]
  isSending?: boolean
  errorMessage?: string | null
  apiConfig: ConfigResponse | null
  hasConfig: boolean
  onOpenConfig: () => void
  onStop?: () => void
  onSend: (content: string) => Promise<void> | void
  /** 重新生成最后一轮回答 */
  onRegenerate?: () => Promise<void> | void
  /** 回退到该条消息之前并交回原文；返回 null 表示未成功，不应预填输入框 */
  onEditMessage?: (message: Message) => Promise<string | null>
  onNewChat: () => void
  onSelectConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onLogout: () => void
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function ChatInterface({
  user,
  demoMode,
  conversations,
  activeConversationId,
  hasEmptyConversation,
  messages,
  isSending = false,
  errorMessage = null,
  apiConfig,
  hasConfig,
  onOpenConfig,
  onStop,
  onSend,
  onRegenerate,
  onEditMessage,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onLogout,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('')
  const [copiedTimestamp, setCopiedTimestamp] = useState<number | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  // 正在回退的消息时间戳：截断是异步的，不锁住会出现连点两次都删一次
  const [rewindingTimestamp, setRewindingTimestamp] = useState<number | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const rafRef = useRef<number | null>(null)
  // 粘底标记：用户向上翻阅历史时暂停自动跟随，避免被强制拉回底部
  const stickToBottomRef = useRef(true)

  const canSend = useMemo(
    () => input.trim().length > 0 && !isSending && hasConfig,
    [input, isSending, hasConfig],
  )

  // 只有最后一条回答提供“重新生成”：早期回答往回重生会一并丢掉之后的上下文，
  // 属于影响较大的操作，不放到每个气泡上避免误点
  const lastAssistantTimestamp = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'assistant') {
        return messages[index].timestamp
      }
    }
    return null
  }, [messages])

  // 流式输出时每个 chunk 都会改变 messages，若逐次触发平滑滚动会相互打断产生抖动。
  // 这里按帧合并为一次瞬时定位，只滚动容器自身而不影响祖先滚动。
  useEffect(() => {
    if (!stickToBottomRef.current) {
      return
    }
    if (rafRef.current !== null) {
      return
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = mainRef.current
      if (el) {
        el.scrollTop = el.scrollHeight
      }
    })
  }, [messages])

  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    },
    [],
  )

  const handleMainScroll = () => {
    const el = mainRef.current
    if (!el) {
      return
    }
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // 阈值容忍滚轮惯性；小于 80px 视为贴底
    stickToBottomRef.current = distanceToBottom < 80
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = input.trim()
    if (!content || isSending) {
      return
    }

    // 发送新消息时重新开启粘底，保证能看到本轮回答
    stickToBottomRef.current = true
    setInput('')
    await onSend(content)
  }

  const handleInputKeyDown = async (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) {
      return
    }

    event.preventDefault()
    const content = input.trim()
    if (!content || isSending) {
      return
    }

    stickToBottomRef.current = true
    setInput('')
    await onSend(content)
  }

  const handleCopy = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedTimestamp(message.timestamp)
      setCopyError(null)
      window.setTimeout(() => {
        setCopiedTimestamp((current) => (current === message.timestamp ? null : current))
      }, 1500)
    } catch {
      setCopyError('复制失败，请手动复制。')
    }
  }

  const handleRegenerate = async () => {
    if (!onRegenerate || isSending || rewindingTimestamp !== null) {
      return
    }
    // 重生会开启新一轮输出，重新贴底否则新回答在屏外
    stickToBottomRef.current = true
    await onRegenerate()
  }

  const handleEdit = async (message: Message) => {
    if (!onEditMessage || isSending || rewindingTimestamp !== null) {
      return
    }

    setRewindingTimestamp(message.timestamp)
    try {
      const content = await onEditMessage(message)
      if (content !== null) {
        setInput(content)
        inputRef.current?.focus()
      }
    } finally {
      setRewindingTimestamp(null)
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#e2f7ef_0%,_#f4f7fb_45%,_#eef2ff_100%)] p-4 md:p-6">
      <div className="mx-auto flex h-[calc(100vh-2rem)] w-full max-w-7xl overflow-hidden rounded-3xl border border-white/70 bg-white/70 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.45)] backdrop-blur-xl md:h-[calc(100vh-3rem)]">
        <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200/70 bg-white/80">
          <div className="border-b border-slate-200/70 p-4">
          <button
            type="button"
            onClick={onNewChat}
            disabled={isSending || hasEmptyConversation}
            className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300"
          >
            开启新对话
          </button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {conversations.map((conversation) => {
            const isActive = conversation.id === activeConversationId
            return (
              <div
                key={conversation.id}
                className={`group rounded-xl border p-2.5 transition ${
                  isActive
                    ? 'border-emerald-300/90 bg-emerald-50/80 shadow-sm ring-1 ring-emerald-200'
                    : 'border-transparent bg-slate-50/80 hover:border-slate-200 hover:bg-white'
                }`}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectConversation(conversation.id)}
                    disabled={isSending || isActive}
                    aria-pressed={isActive}
                    className={`min-w-0 flex-1 rounded-lg px-1 py-1 text-left transition disabled:cursor-default ${
                      isActive ? 'cursor-default' : 'cursor-pointer'
                    }`}
                  >
                    <p
                      className={`truncate text-sm font-medium ${
                        isActive ? 'text-emerald-700' : 'text-slate-700'
                      }`}
                    >
                      {conversation.title}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      创建于 {formatTime(conversation.createdAt)}
                    </p>
                  </button>
                    <button
                    type="button"
                    onClick={() => onDeleteConversation(conversation.id)}
                    disabled={isSending}
                    aria-label={`删除会话 ${conversation.title}`}
                    className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
          </div>
          <div className="border-t border-slate-200/70 p-4">
            <div className="flex items-center gap-2 text-slate-500">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-700" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M12 2v20" />
                <path d="M4.93 6 19.07 18" />
                <path d="M4.93 18 19.07 6" />
                <path d="M2 12h20" />
              </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700">Snow</p>
                <p className="text-xs text-slate-400">AI Chat</p>
              </div>
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-slate-50/50">
          <header className="flex items-center justify-between gap-3 border-b border-slate-200/70 bg-white/70 px-5 py-4 text-sm font-medium text-slate-700 backdrop-blur-sm">
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-700">AI 聊天助手</span>
            <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenConfig}
              disabled={isSending}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-xs text-slate-600 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50/60 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="打开大模型 API 设置"
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  hasConfig ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
              />
              <span className="font-medium">
                {apiConfig ? `${apiConfig.provider} · ${apiConfig.model}` : '未配置 API'}
              </span>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.82-.33 1.7 1.7 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.51 1.7 1.7 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .33-1.82 1.7 1.7 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.51-1 1.7 1.7 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.82.33H9a1.7 1.7 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.82V9a1.7 1.7 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
              </svg>
            </button>

            <TaskPanel />

            <span
              className="hidden items-center gap-1.5 rounded-full bg-slate-100/90 px-3 py-1.5 text-xs font-medium text-slate-600 sm:inline-flex"
              title={
                demoMode
                  ? `免登录模式，直接以后端既有数据「${user.username}」的身份使用`
                  : `当前账号：${user.username}`
              }
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20a8 8 0 0 1 16 0" />
              </svg>
              {user.username}
              {demoMode ? (
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                  免登录
                </span>
              ) : null}
            </span>

            {demoMode ? null : (
            <button
              type="button"
              onClick={onLogout}
              disabled={isSending}
              className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-xs text-slate-500 shadow-sm transition hover:border-red-200 hover:bg-red-50/60 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
              title={isSending ? '生成中无法退出，请先停止回答' : '退出当前账号'}
            >
              退出登录
            </button>
            )}
            </div>
          </header>

          {errorMessage ? (
            <div className="mx-5 mt-4 rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-2.5 text-sm text-amber-700 shadow-sm">
            {errorMessage}
            </div>
          ) : null}
          {copyError ? (
            <div className="mx-5 mt-4 rounded-xl border border-red-200 bg-red-50/90 px-4 py-2.5 text-sm text-red-600 shadow-sm">
            {copyError}
            </div>
          ) : null}

          <main
            ref={mainRef}
            onScroll={handleMainScroll}
            className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5"
          >
            {messages.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white/80 p-8 text-center text-sm text-slate-500 shadow-sm">
                {hasConfig ? (
                  '输入问题开始对话'
                ) : (
                  <span className="inline-flex flex-col items-center gap-3">
                    <span>尚未配置大模型 API，无法发起对话。</span>
                    <button
                      type="button"
                      onClick={onOpenConfig}
                      className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-xs font-medium text-white shadow-sm transition hover:from-emerald-600 hover:to-teal-600"
                    >
                      立即配置
                    </button>
                  </span>
                )}
              </div>
            ) : null}

            {messages.map((message) => {
              const isUser = message.role === 'user'
              const isGenerating =
                isSending && !isUser && message.timestamp === lastAssistantTimestamp
              return (
                <div key={message.timestamp} className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
                  {/* min-w-0 解除 flex 子项 min-width:auto 的下限，避免宽表格顶破 82% 宽度上限 */}
                  <div className={`flex min-w-0 max-w-[82%] flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
                    <div
                      className={[
                        'w-full max-w-full overflow-hidden rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm',
                        isUser
                          ? 'rounded-br-md bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-emerald-200/60'
                          : 'rounded-bl-md border border-slate-200/80 bg-white text-slate-800',
                      ].join(' ')}
                    >
                      <div className="break-words [&_a]:text-blue-600 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6">
                        {!isUser && message.steps?.length ? (
                          <ToolStepsPanel steps={message.steps} />
                        ) : null}
                        {isGenerating && !message.content && !message.steps?.length ? (
                          <GeneratingIndicator />
                        ) : null}
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            code({ className, children, ...props }) {
                              const match = /language-(\w+)/.exec(className ?? '')
                              const code = String(children).replace(/\n$/, '')
                              const language = match?.[1]

                              if (!language) {
                                return (
                                  <code
                                    className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.92em]"
                                    {...props}
                                  >
                                    {children}
                                  </code>
                                )
                              }

                              return (
                                <SyntaxHighlighter
                                  language={language}
                                  style={oneDark}
                                  customStyle={{ margin: 0, borderRadius: 8, padding: '12px' }}
                                >
                                  {code}
                                </SyntaxHighlighter>
                              )
                            },
                            table({ children }) {
                              return (
                                <div className="my-3 w-full overflow-x-auto rounded-lg border border-slate-200">
                                  {/* 不锁定列宽：去掉 min-w-max，让自动布局在容器宽度内优先换行，
                                      仅在列数过多实在容不下时才横向滚动 */}
                                  <table className="w-full max-w-full border-collapse text-left text-[0.92em]">
                                    {children}
                                  </table>
                                </div>
                              )
                            },
                            thead({ children }) {
                              return <thead className="bg-slate-100/80 text-slate-700">{children}</thead>
                            },
                            tbody({ children }) {
                              return <tbody className="divide-y divide-slate-200 bg-white">{children}</tbody>
                            },
                            tr({ children }) {
                              return <tr className="align-top">{children}</tr>
                            },
                            th({ children }) {
                              return (
                                <th className="w-auto break-words px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 [&_p]:my-0">
                                  {children}
                                </th>
                              )
                            },
                            td({ children }) {
                              return (
                                <td className="w-auto break-words px-3 py-2 align-top text-slate-700 [overflow-wrap:anywhere] [&_p]:my-0">
                                  {children}
                                </td>
                              )
                            },
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-xs text-slate-400">{formatTime(message.timestamp)}</span>
                      {!isUser ? (
                        <button
                          type="button"
                          onClick={() => handleCopy(message)}
                          className="rounded-md px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                        >
                          {copiedTimestamp === message.timestamp ? '已复制' : '复制'}
                        </button>
                      ) : null}
                      {isUser ? (
                        <button
                          type="button"
                          onClick={() => handleEdit(message)}
                          disabled={isSending || !hasConfig || rewindingTimestamp !== null}
                          className="rounded-md px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {rewindingTimestamp === message.timestamp ? '回退中…' : '编辑重发'}
                        </button>
                      ) : null}
                      {!isUser && message.timestamp === lastAssistantTimestamp ? (
                        <button
                          type="button"
                          onClick={handleRegenerate}
                          disabled={isSending || !hasConfig || rewindingTimestamp !== null}
                          className="rounded-md px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          重新生成
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </main>

          <form onSubmit={handleSubmit} className="border-t border-slate-200/70 bg-white/80 p-4 backdrop-blur-sm">
            <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={hasConfig ? '输入你的问题...' : '请先在右上方“API 设置”中配置大模型接口'}
              rows={1}
                className="max-h-32 min-h-10 flex-1 resize-y border-none bg-transparent px-2 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
              disabled={isSending || !hasConfig}
            />
            {isSending ? (
              <button
                type="button"
                onClick={() => onStop?.()}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
              >
                停止
              </button>
            ) : null}
            <button
              type="submit"
              disabled={!canSend}
                className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300"
            >
              {isSending ? '思考中...' : '发送'}
            </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  )
}
