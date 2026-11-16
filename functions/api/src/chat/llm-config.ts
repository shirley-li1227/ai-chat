/** 上游调用所需的最小配置集 */
export interface PlainApiConfig {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
}

/**
 * 演示模式没有配置表，API Key 只来自函数环境变量。
 *
 * 缺失时返回 null 而不是在模块加载期抛错：否则漏配会让整个实例起不来，
 * 健康检查也答不上话，排查时反而分不清是部署挂了还是没配 Key。
 */
export function readEnvApiConfig(): PlainApiConfig | null {
  const apiKey = process.env.LLM_API_KEY?.trim()
  if (!apiKey) {
    return null
  }

  return {
    provider: process.env.LLM_PROVIDER?.trim() || 'DeepSeek',
    apiKey,
    baseUrl: process.env.LLM_BASE_URL?.trim() || 'https://api.deepseek.com/v1',
    model: process.env.LLM_MODEL?.trim() || 'deepseek-chat',
  }
}
