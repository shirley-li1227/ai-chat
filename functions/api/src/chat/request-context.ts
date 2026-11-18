import type { OutboundMessage } from './continuation'
import { SYSTEM_PROMPT } from './prompt'

/**
 * 一轮请求的上下文组装：常驻 system + 长期记忆 + 会话摘要 + 历史。
 *
 * 抽成纯函数的理由是那条硬约束——**系统提示与长期记忆都在请求层注入，不写进会话历史**：
 * 只有把它们和 history 分开摆在这里，才断言得「记忆不会流进裁剪、摘要与落库」，
 * 也才解释得清为什么前端编辑历史、乃至历史被整段丢弃都不会把记忆带进模型输出。
 */

/** 摘要段的固定抬头：界面与评测都靠它认出哪条 system 是摘要 */
export const SUMMARY_LEAD =
  '以下是本对话更早内容的摘要，请当作已知事实使用，不要向用户复述摘要本身：\n'

export interface RequestContextInput {
  history: OutboundMessage[]
  /** 会话内的滚动摘要，无摘要时不注入 */
  summary?: string | null
  /** 跨会话的长期记忆，关闭开关或没有记忆时不注入 */
  memory?: string | null
}

/**
 * system 段排在 history 之前，长期记忆排在摘要之前。
 *
 * 这个先后是有讲究的：记忆是跨会话的稳定事实，摘要只是本会话早期内容的压缩，
 * 越靠近历史的部分越该是「这一场对话特有的」，模型对紧邻历史的指令也更买账。
 */
export function buildRequestMessages(input: RequestContextInput): OutboundMessage[] {
  const prefix: OutboundMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  if (input.memory) {
    prefix.push({ role: 'system', content: input.memory })
  }
  if (input.summary) {
    prefix.push({ role: 'system', content: `${SUMMARY_LEAD}${input.summary}` })
  }

  return [...prefix, ...input.history]
}
