import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { BackgroundTask, TaskKindInfo, TaskStatus } from '../types'
import { cancelTask, createTask, fetchTaskKinds, fetchTasks } from '../client'

/** 进行中与排队中都要继续轮询；终态一旦确定就不再变化 */
const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'running']
const POLL_FAST_MS = 2000
const POLL_SLOW_MS = 15000

const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const STATUS_CLASS: Record<TaskStatus, string> = {
  queued: 'bg-slate-100 text-slate-600',
  running: 'bg-amber-100 text-amber-700',
  succeeded: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-600',
  canceled: 'bg-slate-100 text-slate-500',
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** 卡片副标题：把 payload 里最有辨识度的一个字段挑出来，避免只显示 kind */
function taskSummary(task: BackgroundTask): string {
  const name = task.payload.name
  return typeof name === 'string' && name ? `${task.kind} · ${name}` : task.kind
}

export default function TaskPanel() {
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const [runnerEnabled, setRunnerEnabled] = useState(true)
  const [kinds, setKinds] = useState<TaskKindInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchTasks()
      setTasks(data.items)
      setRunnerEnabled(data.runnerEnabled)
      setErrorMessage(null)
    } catch (error) {
      // 首次加载失败要说“读取失败”，之后失败只说明暂停刷新，否则轮询会反复盖住列表
      setErrorMessage(
        error instanceof Error ? error.message : '读取后台任务失败，请稍后重试。',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  // 有活跃任务时密集轮询，否则退回慢轮询：任务面板不是聊天主链路，
  // 空转时不该一直占用请求额度（后端按 IP 限流，聊天接口在同一台机器上）。
  const hasActive = tasks.some((task) => ACTIVE_STATUSES.includes(task.status))
  useEffect(() => {
    const tick = () => {
      void refresh()
    }
    // 首帧用 timeout 触发，effect 体内不同步 setState，避免级联渲染
    const first = window.setTimeout(tick, 0)
    const interval = window.setInterval(tick, open && hasActive ? POLL_FAST_MS : POLL_SLOW_MS)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(interval)
    }
  }, [refresh, open, hasActive])

  useEffect(() => {
    if (!open || kinds.length) {
      return
    }
    fetchTaskKinds()
      .then((meta) => {
        setKinds(meta.kinds)
        setRunnerEnabled(meta.runnerEnabled)
      })
      .catch(() => setFormError('任务类型读取失败，无法新建任务。'))
  }, [open, kinds.length])

  const activeCount = tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)).length
  // 目前只有一种任务类型，多类型时在这里换成下拉选择
  const activeKind = kinds[0]

  const handleCancel = async (id: string) => {
    setCancelingId(id)
    try {
      const updated = await cancelTask(id)
      setTasks((prev) => prev.map((task) => (task.id === id ? updated : task)))
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '取消任务失败')
    } finally {
      setCancelingId(null)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeKind) {
      setFormError('没有可用的任务类型。')
      return
    }

    const payload: Record<string, unknown> = {}
    for (const field of activeKind.fields) {
      const raw = (form[field.name] ?? '').trim()
      if (!raw) {
        if (field.required) {
          setFormError(`请填写「${field.name}」`)
          return
        }
        continue
      }
      if (field.type === 'object') {
        try {
          payload[field.name] = JSON.parse(raw) as unknown
        } catch {
          setFormError(`「${field.name}」需要是合法的 JSON 对象`)
          return
        }
      } else if (field.type === 'number') {
        const value = Number(raw)
        if (!Number.isFinite(value)) {
          setFormError(`「${field.name}」需要是数字`)
          return
        }
        payload[field.name] = value
      } else {
        payload[field.name] = raw
      }
    }

    setSubmitting(true)
    setFormError(null)
    try {
      const created = await createTask({ kind: activeKind.kind, payload })
      setTasks((prev) => [created, ...prev])
      setForm({})
      setFormOpen(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '提交任务失败')
    } finally {
      setSubmitting(false)
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
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span className="font-medium">后台任务</span>
        {activeCount > 0 ? (
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
            {activeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-30" aria-hidden onClick={() => setOpen(false)} />
          <aside
            className="fixed right-4 top-20 z-40 flex max-h-[72vh] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur"
            aria-label="后台任务面板"
          >
            <div className="flex items-center justify-between border-b border-slate-200/80 px-3 py-2">
              <div>
                <p className="text-sm font-semibold text-slate-700">后台任务</p>
                <p className="text-[11px] text-slate-400">
                  {hasActive ? '正在自动刷新' : '每 15 秒刷新一次'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="收起后台任务面板"
                className="rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                收起
              </button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {!runnerEnabled ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50/90 px-3 py-2 text-[11px] leading-5 text-amber-700">
                  执行器当前未启用，任务提交后会一直停在队列里。部署 worker 并把
                  BACKGROUND_TASKS_ENABLED 设为 true 后才会真正执行。
                </p>
              ) : null}

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
                  正在读取后台任务…
                </p>
              ) : tasks.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
                  还没有后台任务。对话里让 Agent「放到后台抓取」，或点下方「新建任务」。
                </p>
              ) : (
                tasks.map((task) => (
                  <article
                    key={task.id}
                    className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASS[task.status]}`}
                      >
                        {STATUS_TEXT[task.status]}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600">
                        {taskSummary(task)}
                      </span>
                      <span className="shrink-0 text-[10px] text-slate-400">
                        {formatClock(task.createdAt)}
                      </span>
                    </div>

                    {task.status === 'running' ? (
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-emerald-400 transition-all"
                          style={{ width: `${Math.max(6, Math.min(100, task.progress))}%` }}
                        />
                      </div>
                    ) : null}

                    {task.error ? (
                      <p className="mt-1.5 line-clamp-2 text-[11px] leading-5 text-red-500">
                        {task.error}
                      </p>
                    ) : null}

                    <div className="mt-1.5 flex items-center gap-2">
                      {task.result ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedId((current) => (current === task.id ? null : task.id))
                          }
                          className="rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-200/70 hover:text-slate-700"
                        >
                          {expandedId === task.id ? '收起结果' : '查看结果'}
                        </button>
                      ) : null}
                      {ACTIVE_STATUSES.includes(task.status) ? (
                        <button
                          type="button"
                          onClick={() => handleCancel(task.id)}
                          disabled={cancelingId === task.id}
                          className="rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {cancelingId === task.id ? '取消中…' : '取消'}
                        </button>
                      ) : null}
                      {task.attempts > 1 ? (
                        <span className="ml-auto text-[10px] text-slate-400">
                          已尝试 {task.attempts} 次
                        </span>
                      ) : null}
                    </div>

                    {expandedId === task.id && task.result ? (
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/90 p-2 text-[11px] leading-5 text-slate-600">
                        {task.result}
                      </pre>
                    ) : null}
                  </article>
                ))
              )}
            </div>

            <div className="border-t border-slate-200/80 p-3">
              {formOpen ? (
                <form onSubmit={handleSubmit} className="space-y-2">
                  <p className="text-[11px] font-medium text-slate-600">新建后台任务</p>
                  {activeKind ? (
                    <p className="text-[10px] leading-4 text-slate-400">{activeKind.description}</p>
                  ) : null}

                  {activeKind?.fields.map((field) => (
                    <label key={field.name} className="block">
                      <span className="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
                        {field.name}
                        {field.required ? ' *' : ''}
                      </span>
                      {field.enum?.length ? (
                        <select
                          value={form[field.name] ?? ''}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, [field.name]: event.target.value }))
                          }
                          className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-emerald-300"
                        >
                          <option value="">请选择</option>
                          {field.enum.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={form[field.name] ?? ''}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, [field.name]: event.target.value }))
                          }
                          placeholder={field.description}
                          className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-slate-700 outline-none focus:border-emerald-300"
                        />
                      )}
                    </label>
                  ))}

                  {formError ? (
                    <p className="rounded-lg border border-red-200 bg-red-50/90 px-2 py-1.5 text-[11px] text-red-600">
                      {formError}
                    </p>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={submitting || !activeKind}
                      className="flex-1 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300"
                    >
                      {submitting ? '提交中…' : '提交任务'}
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
                  className="w-full rounded-xl border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-500 transition hover:border-emerald-300 hover:text-emerald-600"
                >
                  新建任务
                </button>
              )}
            </div>
          </aside>
        </>
      ) : null}
    </div>
  )
}
