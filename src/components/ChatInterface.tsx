import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Conversation, Message } from '../types'

interface ChatInterfaceProps {
  conversations: Conversation[]
  activeConversationId: string
  hasEmptyConversation: boolean
  messages: Message[]
  isSending?: boolean
  errorMessage?: string | null
  onSend: (content: string) => Promise<void> | void
  onNewChat: () => void
  onSelectConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function ChatInterface({
  conversations,
  activeConversationId,
  hasEmptyConversation,
  messages,
  isSending = false,
  errorMessage = null,
  onSend,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('')
  const [copiedTimestamp, setCopiedTimestamp] = useState<number | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const canSend = useMemo(() => input.trim().length > 0 && !isSending, [input, isSending])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isSending])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = input.trim()
    if (!content || isSending) {
      return
    }

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
          <header className="border-b border-slate-200/70 bg-white/70 px-5 py-4 text-sm font-medium text-slate-700 backdrop-blur-sm">
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-700">AI 聊天助手</span>
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

          <main className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {messages.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white/80 p-8 text-center text-sm text-slate-500 shadow-sm">
                输入问题开始对话
              </div>
            ) : null}

            {messages.map((message) => {
              const isUser = message.role === 'user'
              return (
                <div key={message.timestamp} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[82%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1.5`}>
                    <div
                      className={[
                        'rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm',
                        isUser
                          ? 'rounded-br-md bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-emerald-200/60'
                          : 'rounded-bl-md border border-slate-200/80 bg-white text-slate-800',
                      ].join(' ')}
                    >
                      <div className="break-words [&_a]:text-blue-600">
                        <ReactMarkdown
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
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={bottomRef} />
          </main>

          <form onSubmit={handleSubmit} className="border-t border-slate-200/70 bg-white/80 p-4 backdrop-blur-sm">
            <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="输入你的问题..."
              rows={1}
                className="max-h-32 min-h-10 flex-1 resize-y border-none bg-transparent px-2 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
              disabled={isSending}
            />
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
