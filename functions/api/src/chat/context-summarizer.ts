import { Logger } from '@nestjs/common'
import type { PlainApiConfig } from '../config/config.service'
import { SUMMARY_PROMPT } from './prompt'
import { completeOnce } from './llm-client'

const logger = new Logger('ContextSummarizer')

/** 单条消息进摘要前的截断长度：问答不对称，回答通常更长更水 */
const PER_MESSAGE_CAP: Record<string, number> = {
  user: 200,
  assistant: 400,
}

/** 摘要输入的上限，防止"为了压缩反而烧掉更多 token" */
const MAX_SOURCE_LINES = 40
const MAX_SOURCE_CHARS = 6000

export interface SummaryInput {
  priorSummary: string | null
  /** 本轮被滑出窗口的旧消息，按时间正序 */
  dropped: Array<{ role: string; content: string }>
}

/**
 * 把被裁剪掉的旧轮次并入一份滚动摘要。
 *
 * 设计要点：
 * 1. **合并而非重写**：传入已有摘要，让模型做增量归并，避免每次从最早消息重算；
 * 2. **输入必须截断**：待压缩的消息可能很长，直接塞进去会本末倒置，因此每条截断、
 *    并且整体限 40 行 / 6000 字；
 * 3. **绝不抛错**：摘要只是锦上添花，失败就退回抽取式要点。主对话绝不能因为
 *    压缩失败而中断，那会把一个成本优化变成可用性事故。
 */
export async function buildRollingSummary(
  config: PlainApiConfig,
  input: SummaryInput,
  signal?: AbortSignal,
): Promise<string> {
  const sources = renderSources(input.dropped)

  if (!sources) {
    return input.priorSummary ?? ''
  }

  try {
    const text = await completeOnce(
      config,
      [
        { role: 'system', content: SUMMARY_PROMPT },
        {
          role: 'user',
          content: [
            '已有摘要：',
            input.priorSummary?.trim() ? input.priorSummary.trim() : '（无）',
            '',
            '新增对话：',
            sources,
          ].join('\n'),
        },
      ],
      // 摘要只需要短文本，max_tokens 收紧到 400，单次成本可控且不会反向膨胀
      { maxTokens: 400, temperature: 0.2, timeoutMs: 20000, signal },
    )

    if (text) {
      return text
    }
    logger.warn('摘要返回空内容，退回抽取式要点')
  } catch (error) {
    // 用户中断（AbortError）时不要继续花额度，直接沿用旧摘要
    if ((error as Error).name === 'AbortError') {
      throw error
    }
    logger.warn(`摘要生成失败，退回抽取式要点：${(error as Error).message}`)
  }

  return extractiveDigest(input.priorSummary, input.dropped)
}

/**
 * 兜底：不调用模型，直接把旧消息压成要点清单。
 * 信息密度低于 LLM 摘要，但零成本、零失败，保证上下文一定有"旧事"的痕迹。
 */
export function extractiveDigest(
  priorSummary: string | null,
  dropped: Array<{ role: string; content: string }>,
): string {
  const bullets = dropped
    .filter((m) => m.content.trim())
    .slice(0, MAX_SOURCE_LINES)
    .map((m) => `- ${m.role === 'user' ? '用户' : '助手'}：${clip(m)}`)

  if (!bullets.length) {
    return priorSummary ?? ''
  }

  const head = priorSummary?.trim() ? `${priorSummary.trim()}\n- （以下为早期对话要点）` : '（早期对话要点）'
  return `${head}\n${bullets.join('\n')}`
}

function renderSources(dropped: SummaryInput['dropped']): string {
  const lines: string[] = []
  let chars = 0

  // 只取最旧的一部分也没意义，按时间正序取满上限即止
  for (const m of dropped) {
    const content = m.content.trim()
    if (!content) continue

    const clipped = clip(m)
    const line = `${m.role === 'user' ? '用户' : '助手'}：${clipped}`
    if (lines.length >= MAX_SOURCE_LINES) break
    if (chars + line.length > MAX_SOURCE_CHARS) break

    lines.push(line)
    chars += line.length
  }

  return lines.join('\n')
}

function clip(m: { role: string; content: string }): string {
  const cap = PER_MESSAGE_CAP[m.role] ?? 300
  const content = m.content.trim().replace(/\s+/g, ' ')
  return content.length > cap ? `${content.slice(0, cap)}…` : content
}
