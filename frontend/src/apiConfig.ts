import type { ApiConfig, ProviderType } from './types'

export interface ProviderPreset {
  type: ProviderType
  label: string
  description: string
  defaultBaseUrl: string
  defaultModel: string
  modelLabel: string
  modelPlaceholder: string
  modelHint: string
  apiKeyPlaceholder: string
  docsUrl: string
}

export const PROVIDER_PRESETS: Record<ProviderType, ProviderPreset> = {
  deepseek: {
    type: 'deepseek',
    label: 'DeepSeek',
    description: '深度求索官方开放接口，兼容 OpenAI Chat Completions 协议。',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    modelLabel: '模型名称',
    modelPlaceholder: 'deepseek-chat / deepseek-reasoner',
    modelHint: '常用取值：deepseek-chat、deepseek-reasoner。',
    apiKeyPlaceholder: 'sk-...',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
  },
}

export const PROVIDER_ORDER: ProviderType[] = ['deepseek']

export function createDefaultConfig(provider: ProviderType): ApiConfig {
  const preset = PROVIDER_PRESETS[provider]
  return {
    provider,
    apiKey: '',
    baseUrl: preset.defaultBaseUrl,
    model: preset.defaultModel,
  }
}

export function isValidConfig(config: ApiConfig): boolean {
  return (
    typeof config.apiKey === 'string' &&
    config.apiKey.trim().length > 0 &&
    typeof config.baseUrl === 'string' &&
    /^https?:\/\//i.test(config.baseUrl.trim()) &&
    typeof config.model === 'string' &&
    config.model.trim().length > 0
  )
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed
  }
  return `${trimmed}/chat/completions`
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return '\u2022'.repeat(apiKey.length)
  }
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`
}
