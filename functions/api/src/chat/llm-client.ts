/**
 * 兼容三种填法：只填站点根、填到 /v1、直接填完整 /chat/completions。
 * baseUrl 来自环境变量，形态不可控，这里必须归一，否则拼出双路径 404。
 */
export function resolveCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`
}
