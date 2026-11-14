import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ApiConfig } from '../types'
import type { ConfigResponse } from '../client'
import {
  PROVIDER_ORDER,
  PROVIDER_PRESETS,
  buildChatCompletionsUrl,
  createDefaultConfig,
  isValidConfig,
  maskApiKey,
} from '../apiConfig'

interface ApiConfigModalProps {
  open: boolean
  currentConfig: ConfigResponse | null
  onClose: () => void
  onSave: (config: ApiConfig) => Promise<void> | void
  onClear: () => Promise<void> | void
}

export default function ApiConfigModal({
  open,
  currentConfig,
  onClose,
  onSave,
  onClear,
}: ApiConfigModalProps) {
  const [draft, setDraft] = useState<ApiConfig>(
    () => createDefaultConfig('deepseek'),
  )
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    // Reset draft from currentConfig (apiKey is empty since backend doesn't return it)
    if (currentConfig) {
      setDraft({
        provider: currentConfig.provider as ApiConfig['provider'],
        apiKey: '',
        baseUrl: currentConfig.baseUrl,
        model: currentConfig.model,
      })
    } else {
      setDraft(createDefaultConfig('deepseek'))
    }
    setTouched(false)
  }, [open, currentConfig])

  useEffect(() => {
    if (!open) {
      return
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  const preset = PROVIDER_PRESETS[draft.provider]

  if (!open) {
    return null
  }

  const handleProviderChange = (provider: ApiConfig['provider']) => {
    const nextPreset = PROVIDER_PRESETS[provider]
    setDraft((prev) => ({
      provider,
      apiKey: prev.apiKey,
      baseUrl: nextPreset.defaultBaseUrl,
      model: nextPreset.defaultModel,
    }))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTouched(true)
    // If apiKey is empty but currentConfig exists, user didn't change key — still valid
    const configToSave: ApiConfig = {
      provider: draft.provider,
      apiKey: draft.apiKey.trim(),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
    }
    if (!configToSave.apiKey && currentConfig) {
      // No new key provided, skip validation of apiKey
      if (!configToSave.baseUrl || !configToSave.model) return
    } else if (!isValidConfig(configToSave)) {
      return
    }
    setSaving(true)
    try {
      await onSave(configToSave)
    } finally {
      setSaving(false)
    }
  }

  const fieldErrors = {
    apiKey:
      draft.apiKey.trim().length === 0
        ? '请填写 API Key'
        : null,
    baseUrl:
      draft.baseUrl.trim().length === 0
        ? '请填写 Base URL'
        : !/^https?:\/\//i.test(draft.baseUrl.trim())
          ? 'Base URL 必须以 http:// 或 https:// 开头'
          : null,
    model:
      draft.model.trim().length === 0
        ? '请填写模型名称'
        : null,
  }
  const showErrors = touched

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-config-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        <form onSubmit={handleSubmit}>
          <header className="flex items-start justify-between border-b border-slate-100 px-6 py-4">
            <div>
              <h2 id="api-config-title" className="text-lg font-semibold text-slate-800">
                大模型 API 设置
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12" />
                <path d="M18 6 6 18" />
              </svg>
            </button>
          </header>

          <div className="space-y-5 px-6 py-5">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">服务供应商</label>
              <div className="grid grid-cols-2 gap-3">
                {PROVIDER_ORDER.map((type) => {
                  const item = PROVIDER_PRESETS[type]
                  const active = draft.provider === type
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => handleProviderChange(type)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition ${
                        active
                          ? 'border-emerald-400 bg-emerald-50/80 shadow-sm ring-1 ring-emerald-200'
                          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className={`block text-sm font-semibold ${
                          active ? 'text-emerald-700' : 'text-slate-700'
                        }`}
                      >
                        {item.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">{item.description}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="api-key" className="text-sm font-medium text-slate-700">
                API Key
              </label>
              <input
                id="api-key"
                type="password"
                value={draft.apiKey}
                onChange={(event) => setDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
                placeholder={preset.apiKeyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />
              {showErrors && fieldErrors.apiKey ? (
                <p className="text-xs text-red-500">{fieldErrors.apiKey}</p>
              ) : draft.apiKey ? (
                <p className="text-xs text-slate-400">当前值：{maskApiKey(draft.apiKey)}</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="api-model" className="text-sm font-medium text-slate-700">
                {preset.modelLabel}
              </label>
              <input
                id="api-model"
                type="text"
                value={draft.model}
                onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
                placeholder={preset.modelPlaceholder}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />
              <p className="text-xs text-slate-400">{preset.modelHint}</p>
              {showErrors && fieldErrors.model ? (
                <p className="text-xs text-red-500">{fieldErrors.model}</p>
              ) : null}
            </div>

            <details className="group rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2">
              <summary className="cursor-pointer select-none text-sm font-medium text-slate-700">
                高级选项：Base URL
              </summary>
              <div className="mt-3 space-y-1.5">
                <input
                  type="text"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
                  placeholder={preset.defaultBaseUrl}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                />
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    后端将请求：
                    <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px] text-slate-600">
                      {buildChatCompletionsUrl(draft.baseUrl || preset.defaultBaseUrl)}
                    </code>
                  </span>
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, baseUrl: preset.defaultBaseUrl }))}
                    className="text-emerald-600 hover:underline"
                  >
                    恢复默认
                  </button>
                </div>
                {showErrors && fieldErrors.baseUrl ? (
                  <p className="text-xs text-red-500">{fieldErrors.baseUrl}</p>
                ) : null}
              </div>
            </details>

            <p className="text-xs text-slate-500">
              获取 Key：
              <a
                href={preset.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-1 text-emerald-600 underline-offset-2 hover:underline"
              >
                {preset.label} 开放平台文档
              </a>
            </p>
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-6 py-4">
            <div>
              {currentConfig ? (
                <button
                  type="button"
                  onClick={() => {
                    onClear()
                    setDraft(createDefaultConfig(draft.provider))
                  }}
                  className="text-xs text-red-500 underline-offset-2 hover:underline"
                >
                  清除已保存配置
                </button>
              ) : (
                <span className="text-xs text-slate-400">尚未保存任何配置</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300"
              >
                {saving ? '保存中...' : '保存并应用'}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}
