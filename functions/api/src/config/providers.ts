/**
 * 供应商注册表：后端关于「能接哪几家、每家的凭据长什么样」的唯一事实来源。
 *
 * 为什么要有这一份：接第二家时真正拦路的不是协议（几家都兼容 OpenAI Chat Completions，
 * `resolveCompletionsUrl()` 也早就支持根 / `/v1` / 完整路径三种填法），而是入口那三条
 * 按 DeepSeek 写死的全局校验——provider 白名单、Key 必须 `sk-` 开头、baseUrl 不许带路径。
 * 智谱的兼容端点恰好是 `https://open.bigmodel.cn/api/paas/v4`，带路径且 Key 形如 `id.secret`，
 * 用全局规则就永远存不进去。校验规则属于供应商，不属于本应用。
 *
 * 前端的 `PROVIDER_PRESETS` 会重复一份 id 与默认值（弹窗要立刻渲染，不该为几个字符串多等一次请求），
 * 两边一致性由 `evals/run-evals.mjs` 的结构断言钉住，不靠人记。
 */

export interface ProviderSpec {
  id: string
  label: string
  /** 用户在弹窗里看到的默认值；保存时按本表的 baseUrlRule 校验 */
  defaultBaseUrl: string
  defaultModel: string
  /** Key 形态校验：挡住把「密钥名称/别名」当成密钥粘贴的常见误操作，不做强度判断 */
  apiKeyRule: { pattern: RegExp; message: string }
  /** 一律强制 https（明文出网不可接受），路径部分按各家实际端点决定放不放行 */
  baseUrlRule: { pattern: RegExp; message: string }
  /**
   * 该家模型 id 的命名特征，用于把「不属于这一家」的路由候选挡在门外。
   * 候选本身按配置逐条填（见 api_config.routingCandidates），这里只作提示与兜底校验。
   */
  modelHint: RegExp
  docsUrl: string
}

const SHARED_BASE_URL_RULE = {
  pattern: /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(\/[A-Za-z0-9._~%\-/!]*)?$/,
  message: 'baseUrl 必须是 https 协议（可带路径，如 https://open.bigmodel.cn/api/paas/v4），且不含空格或查询串',
}

export const PROVIDER_REGISTRY: Record<string, ProviderSpec> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    apiKeyRule: {
      pattern: /^sk-[A-Za-z0-9_-]{8,}$/,
      message: 'apiKey 格式不正确，DeepSeek 密钥应以 sk- 开头',
    },
    baseUrlRule: SHARED_BASE_URL_RULE,
    modelHint: /^deepseek-/,
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    // 官方 OpenAI 兼容端点带版本号路径，别剥掉：只填 https://open.bigmodel.cn 会 404
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3',
    apiKeyRule: {
      pattern: /^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/,
      message: 'apiKey 格式不正确，智谱密钥形如「id.secret」两段（以点号分隔）',
    },
    baseUrlRule: SHARED_BASE_URL_RULE,
    modelHint: /^glm-/,
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  },
}

export const PROVIDER_IDS: string[] = Object.keys(PROVIDER_REGISTRY)

export function providerSpec(provider: string): ProviderSpec | null {
  return PROVIDER_REGISTRY[provider] ?? null
}

/** 未登记的供应商要在这里判死，别让它带着空规则走到落库那一步 */
export function requireProvider(provider: string): ProviderSpec {
  const spec = providerSpec(provider)
  if (!spec) {
    throw new Error(`未登记的供应商：${provider}（已支持：${PROVIDER_IDS.join('、')}）`)
  }
  return spec
}

/** 端点规范化：去尾斜杠，让库里的 baseUrl 只有一个形态，拼 URL 时不再纠结 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 路由候选的解析：逗号分隔、去空白、去重，保持用户写的从低到高顺序。
 * 顺序是语义的一部分——分数线性落档时第 0 个就是最便宜的那一档。
 */
export function parseCandidates(raw: string | null | undefined): string[] {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set(items)]
}
