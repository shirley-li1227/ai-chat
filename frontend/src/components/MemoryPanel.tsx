import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { MemoryItem, MemoryLimits } from '../types'
import { createMemory, deleteMemory, fetchMemories } from '../client'

const SOURCE_TEXT: Record<MemoryItem['source'], string> = {
  model: 'Agent 记下',
  user: '手动添加',
}

const SOURCE_CLASS: Record<MemoryItem['source'], string> = {
  model: 'bg-sky-100 text-sky-700',
  user: 'bg-emerald-100 text-emerald-700',
}

function formatMoment(timestamp: number): string {
  const date = new Date(timestamp)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
}

interface MemoryPanelProps {
  /** 模型调 remember/forget 会改动清单，App 递增它来通知面板重取 */
  revision?: number
}

/**
 * 跨会话长期记忆面板。
 *
 * 不轮询：清单只会被「本浏览器发起的操作」改动——要么是用户在这里增删，
 * 要么是对话里的 remember/forget，后者由 revision 通知。
 * 定时拉取只会白占限流额度（后端按 IP 限流，和聊天接口同一个桶）。
 */
export default function MemoryPanel({ revision = 0 }: MemoryPanelProps) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [limits, setLimits] = useState<MemoryLimits | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchMemories()
      setItems(data.items)
      setLimits(data.limits)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '读取长期记忆失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  // 打开时取一次；面板关着时模型也可能刚记下新东西，revision 变化要连带把角标刷新
  useEffect(() => {
    if (!open && revision === 0) {
      return
    }
    // effect 体内不同步 setState，交给 timeout 触发，避免级联渲染
    const first = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(first)
  }, [open, refresh, revision])

  const maxChars = limits?.itemMaxChars ?? 200
  const overLimit = draft.trim().length > maxChars
  const closedBySwitch = limits?.enabled === false

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = draft.trim()
    if (!content) {
      setFormError('先写一句要长期记住的事实。')
      return
    }
    if (content.length > maxChars) {
      setFormError(`单条记忆上限 ${maxChars} 字，现在 ${content.length} 字。`)
      return
    }

    setSubmitting(true)
    setFormError(null)
    try {
      const data = await createMemory(content)
      setItems(data.items)
      setLimits(data.limits)
      setDraft('')
      setFormOpen(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存记忆失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemove = async (id: string) => {
    setRemovingId(id)
    try {
      const data = await deleteMemory(id)
      setItems(data.items)
      setLimits(data.limits)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '删除记忆失败')
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-xs text-slate-600 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50/60 hover:text-emerald-700"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 4a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.5A3.5 3.5 0 0 0 10 20a2.5 2.5 0 0 0 4 0 3.5 3.5 0 0 0 3-5.5 3.5 3.5 0 0 0-1-6.5 4 4 0 0 0-4-4z" />
          <path d="M12 4v16" />
        </svg>
        <span className="font-medium">长期记忆</span>
        {items.length > 0 ? (
          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
            {items.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-30" aria-hidden onClick={() => setOpen(false)} />
          <aside
            className="fixed right-4 top-20 z-40 flex max-h-[72vh] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur"
            aria-label="长期记忆面板"
          >
            <div className="flex items-center justify-between border-b border-slate-200/80 px-3 py-2">
              <div>
                <p className="text-sm font-semibold text-slate-700">长期记忆</p>
                <p className="text-[11px] text-slate-400">
                  {limits
                    ? `跨会话生效 · 最多 ${limits.maxEntries} 条 · 单条 ${limits.itemMaxChars} 字`
                    : '跨会话生效的关于你的事实'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="收起长期记忆面板"
                className="rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                收起
              </button>
            </div>

            {closedBySwitch ? (
              // 关掉开关后模型既不会记录也不会读取任何记忆，但库里那些还在：
              // 不说清楚，用户只会以为「记了没用」，而删除仍然可用（清库不该被开关挡住）
              <div className="border-b border-amber-200 bg-amber-50/90 px-3 py-2 text-[11px] text-amber-700">
                长期记忆已关闭（后端 MEMORY_ENABLED=false）：模型不再记录也不会读取任何条目，
                下面这些暂时不会变。删除仍然可用；要恢复就改回环境变量并重启后端。
              </div>
            ) : null}

            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {errorMessage ? (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50/90 px-3 py-2 text-[11px] text-red-600">
                  <span>{errorMessage}</span>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="shrink-0 rounded-lg border border-red-200 px-2 py-0.5 transition hover:bg-red-100"
                  >
                    重试
                  </button>
                </div>
              ) : null}

              {loading ? (
                <p className="flex items-center gap-2 px-1 py-6 text-xs text-slate-400">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
                  </svg>
                  正在读取长期记忆…
                </p>
              ) : items.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
                  还没有记住任何内容。对话里说「记一下我以后都要中文回答」，Agent 会自己写进来；
                  也可以点下方「手动记一条」。
                </p>
              ) : (
                items.map((item) => (
                  <article
                    key={item.id}
                    className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${SOURCE_CLASS[item.source]}`}
                      >
                        {SOURCE_TEXT[item.source]}
                      </span>
                      <span
                        className="shrink-0 font-mono text-[10px] text-slate-400"
                        title="Agent 用这个编号忘掉它"
                      >
                        [{item.handle}]
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-slate-400">
                        {formatMoment(item.updatedAt)}
                      </span>
                    </div>

                    <p className="mt-1.5 break-words text-[12px] leading-5 text-slate-700">
                      {item.content}
                    </p>

                    <div className="mt-1.5 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleRemove(item.id)}
                        disabled={removingId === item.id}
                        className="rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {removingId === item.id ? '删除中…' : '忘掉这条'}
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>

            <div className="border-t border-slate-200/80 p-3">
              {formOpen ? (
                <form onSubmit={handleSubmit} className="space-y-2">
                  <label className="block">
                    <span className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
                      <span>要长期记住的一句话</span>
                      <span className={overLimit ? 'text-red-500' : 'text-slate-400'}>
                        {draft.trim().length}/{maxChars}
                      </span>
                    </span>
                    <textarea
                      value={draft}
                      rows={2}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="例如：回复一律用中文，项目是 NestJS + React"
                      className="w-full resize-none rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-300"
                    />
                  </label>

                  {formError ? (
                    <p className="rounded-lg border border-red-200 bg-red-50/90 px-2 py-1.5 text-[11px] text-red-600">
                      {formError}
                    </p>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={submitting || !draft.trim() || overLimit}
                      className="flex-1 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300"
                    >
                      {submitting ? '保存中…' : '记住'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setFormOpen(false)
                        setFormError(null)
                      }}
                      className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-500 transition hover:bg-slate-50"
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setFormOpen(true)
                    setFormError(null)
                  }}
                  disabled={closedBySwitch}
                  title={closedBySwitch ? '后端已关闭长期记忆（MEMORY_ENABLED=false）' : undefined}
                  className="w-full rounded-xl border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-500 transition hover:border-emerald-300 hover:text-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  手动记一条
                </button>
              )}
            </div>
          </aside>
        </>
      ) : null}
    </div>
  )
}
