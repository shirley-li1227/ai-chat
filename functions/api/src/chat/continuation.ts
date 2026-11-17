/**
 * 断点续传的上下文拼装。
 *
 * 上游 Chat Completions 没有「从第 N 个 token 继续」这种语义，能做的只有
 * 把已生成的那段作为 assistant 前缀重新发一次，让模型顺着写下去，
 * 服务端只推送后半段增量。所以这段逻辑的全部价值在于：
 * 用户看到的是一条完整的回答，而不是一句「请求失败」。
 */

export interface OutboundMessage {
  role: string
  content: string | null
  tool_calls?: unknown[]
  tool_call_id?: string
}

/**
 * 续传时允许带回的已生成长度上限，与 ResumeChatDto 的 @MaxLength 对齐。
 * 超上限说明这一轮长得离谱，续传的请求体本身就会把函数内存吃掉一块，
 * 不如让前端走「重新生成」。
 */
export const MAX_RESUME_PARTIAL_CHARS = 30000

export class ResumeRejectedError extends Error {}

/**
 * 组装续传请求的会话部分。
 *
 * 顺序固定为 …(历史) → user(提问) → assistant(已生成前半段)，
 * 模型据此把后半段接在前半段之后。
 *
 * 提问只在历史里确实没有时才补：sqljs 每个实例一份 /tmp 库，
 * 重连很可能落到从没写过这条提问的实例上。补进来的这份**不入库**，
 * 否则回到原实例就会看到同一句话两遍。
 */
export function buildContinuationMessages(
  history: OutboundMessage[],
  question: string,
  partial: string,
): OutboundMessage[] {
  if (!partial.trim()) {
    throw new ResumeRejectedError('没有已生成内容，无法续传，请直接重新生成。')
  }
  if (partial.length > MAX_RESUME_PARTIAL_CHARS) {
    throw new ResumeRejectedError('已生成内容超出续传上限，请重新生成。')
  }

  const messages = [...history]
  const last = messages[messages.length - 1]

  if (last?.role === 'assistant' && last.content === partial) {
    // 历史末尾就是这段半截回答：不删掉它就会和前缀重复一遍
    messages.pop()
  }

  const questionInPlace =
    messages[messages.length - 1]?.role === 'user' &&
    messages[messages.length - 1]?.content === question
  if (!questionInPlace) {
    messages.push({ role: 'user', content: question })
  }

  messages.push({ role: 'assistant', content: partial })
  return messages
}

/**
 * 上游返回码里哪些值得自动重连续写。
 *
 * 4xx（除超时/限流）是请求本身的问题——密钥失效、上下文非法、模型名写错——
 * 重连只会再烧一次额度并把同一个错误复述三遍；408/429/5xx 才是临时故障。
 */
export function retryableForStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/**
 * 续传重新入库时保住中断那一轮的工具步骤。
 *
 * 它们真的执行过、结果真的用掉了，丢掉等于把已经花掉的成本从界面和下一轮上下文里
 * 抹掉。按 id 去重后接在新步骤前面，保持首次请求里的展示顺序。
 */
export function mergeToolSteps<T extends { id: string }>(prior: T[], next: T[]): T[] {
  const seen = new Set(prior.map((step) => step.id))
  return [...prior, ...next.filter((step) => !seen.has(step.id))]
}
