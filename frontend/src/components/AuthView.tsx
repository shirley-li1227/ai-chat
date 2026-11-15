import { useState } from 'react'
import type { FormEvent } from 'react'
import { loginUser, registerUser } from '../client'
import type { AuthSession } from '../client'

interface AuthViewProps {
  /** 登录/注册成功后交回会话，由 App 写入 token 并加载该账号的数据 */
  onSession: (session: AuthSession) => void
}

type Mode = 'login' | 'register'

/** fetch 在连不上后端时抛的是 TypeError，翻译成项目统一的离线提示 */
function describeError(error: unknown, mode: Mode): string {
  if (error instanceof TypeError) {
    return '无法连接到后端服务，请确认已启动 npm run dev:api'
  }
  const message = error instanceof Error ? error.message : ''
  if (message) {
    return message
  }
  return mode === 'login' ? '登录失败，请稍后重试' : '注册失败，请稍后重试'
}

export default function AuthView({ onSession }: AuthViewProps) {
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) {
      return
    }

    // 用户名统一小写：后端按小写存唯一索引，避免 Testalpha / testalpha 各占一个账号
    const name = username.trim().toLowerCase()
    if (!name || !password) {
      setError('请填写用户名和密码。')
      return
    }
    // 前端先挡一层，省掉一次必然 400 的往返；后端 DTO 仍是最终裁判
    if (mode === 'register' && (name.length < 3 || password.length < 8)) {
      setError('用户名至少 3 个字符，密码至少 8 个字符。')
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      const session =
        mode === 'login'
          ? await loginUser(name, password)
          : await registerUser(name, password)
      onSession(session)
    } catch (caught) {
      setError(describeError(caught, mode))
    } finally {
      setSubmitting(false)
    }
  }

  const switchMode = (next: Mode) => {
    if (next === mode) {
      return
    }
    setMode(next)
    setError(null)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-emerald-50/70 px-4 py-10">
      <div className="w-full max-w-md rounded-3xl border border-slate-200/70 bg-white/85 p-8 shadow-[0_20px_60px_-35px_rgba(16,185,129,0.45)] backdrop-blur">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-5.5A8 8 0 0 1 12 4h1a8 8 0 0 1 8 8z" />
            </svg>
          </span>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">AI 聊天助手</h1>
            <p className="text-xs text-slate-500">登录后继续使用，API Key 与对话都保存在账号里</p>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-1 rounded-full bg-slate-100 p-1 text-sm">
          {(['login', 'register'] as Mode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => switchMode(item)}
              className={`rounded-full px-3 py-1.5 font-medium transition ${
                mode === item
                  ? 'bg-white text-emerald-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {item === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm text-slate-600">
            <span className="mb-1.5 block font-medium">用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              maxLength={32}
              placeholder="3-32 位，字母、数字、._-"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
            />
          </label>

          <label className="block text-sm text-slate-600">
            <span className="mb-1.5 block font-medium">密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              maxLength={128}
              placeholder={mode === 'login' ? '输入登录密码' : '至少 8 位'}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
            />
          </label>

          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50/90 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
              </svg>
            ) : null}
            {mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>

        <p className="mt-5 text-xs leading-relaxed text-slate-400">
          {mode === 'register'
            ? '注册即创建独立账号：大模型 API Key 与对话记录都只属于这个账号，换设备登录后仍可使用，无需重新填写 Key。'
            : '首次注册后会自动登录；之后的登录会直接带出该账号已保存的 API Key 与历史对话。'}
        </p>
      </div>
    </div>
  )
}
