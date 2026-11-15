/**
 * 上下文窗口预算：按估算 token 从最新往回裁剪，超限的旧轮次交给摘要压缩。
 *
 * 为什么不装 tiktoken / gpt-tokenizer：
 * 1. DeepSeek 的分词器与 cl100k 并不完全一致，装一个"精确到别的模型"的库反而给人虚假的安全感；
 * 2. gpt-tokenizer 体积数 MB，云函数包体只有 256MB 内存、冷启动时间也敏感；
 * 3. 这里的用途是"决定丢多少轮"，是粗粒度决策，±20% 误差只影响窗口边界一两轮，可接受。
 *
 * 估算口径（偏保守，宁可少塞也不要撞上限）：
 * - CJK 字符：1 token / 字（DeepSeek 中文常见 0.6~1.0，取上界）
 * - 其他字符：4 字符 / token
 * - 每条消息额外 4 token 的角色分隔开销
 * - 工具轨迹按其 JSON 原文计入（还原成协议消息时还要再乘 1 条 assistant + n 条 tool）
 */

/** 单条消息协议层之外的固定开销估算 */
const MESSAGE_OVERHEAD_TOKENS = 4

const CJK_RANGES = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/

/**
 * 估算一段文本的 token 数。
 * 非 ASCII 一律按"一个字一 token"处理，避免把日文/中文标点漏算。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RANGES.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export interface TokenCountable {
  role: string
  content: string
  toolCalls?: string | null
}

/**
 * 估算一条持久化消息占用上下文的 token。
 * 带工具轨迹的消息在发给上游时会展开成 assistant(tool_calls) + n 条 tool 消息，
 * 因此每条工具消息都要单独计一次角色开销。
 */
export function estimateMessageTokens(m: TokenCountable): number {
  let total =
    MESSAGE_OVERHEAD_TOKENS + estimateTokens(m.content) + estimateTokens(m.role)

  if (m.toolCalls) {
    total += estimateTokens(m.toolCalls)
    try {
      const steps = JSON.parse(m.toolCalls) as unknown[]
      total += steps.length * MESSAGE_OVERHEAD_TOKENS
    } catch {
      // 轨迹损坏时按原文长度估，宁可多算
    }
  }
  return total
}

export interface WindowPlan<T extends TokenCountable> {
  /** 保留下来、按时间正序发送的消息 */
  kept: T[]
  /** 被滑出窗口的旧消息，需要并入摘要 */
  dropped: T[]
  keptTokens: number
  droppedTokens: number
}

/**
 * 在预算内保留最近的消息，把更早的消息让给摘要。
 *
 * @param messages 按时间正序的消息列表（含本轮刚写入的 user 消息）
 * @param budget   可用于历史消息的 token 上限（调用方需先扣掉 system/摘要的额度）
 *
 * 关键约束：**最新一条永远保留**。哪怕它单独就超预算也不能丢——
 * 丢了它这轮请求就没有用户问题，模型会答非所问，比撞上限更糟。
 */
export function planWindow<T extends TokenCountable>(
  messages: T[],
  budget: number,
): WindowPlan<T> {
  const kept: T[] = []
  let keptTokens = 0
  // 未触发裁剪时为 0，表示一条都不丢
  let dropThrough = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateMessageTokens(messages[i])
    // 最新一条无条件保留，从倒数第二条起才受预算约束
    if (kept.length > 0 && keptTokens + tokens > budget) {
      dropThrough = i + 1
      break
    }
    keptTokens += tokens
    kept.unshift(messages[i])
  }

  const dropped = messages.slice(0, dropThrough)
  const droppedTokens = dropped.reduce(
    (acc, m) => acc + estimateMessageTokens(m),
    0,
  )

  return { kept, dropped, keptTokens, droppedTokens }
}
