import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '../config/config.service'
import { ConversationsService } from '../conversations/conversations.service'
import { Response } from 'express'
import { TOOL_DEFINITIONS, executeTool } from '../agent/tools'
import type { PlainApiConfig } from '../config/config.service'
import { runWithConcurrency } from '../agent/tool-runner'
import { SYSTEM_PROMPT } from './prompt'
import { resolveCompletionsUrl } from './llm-client'
import { buildRollingSummary } from './context-summarizer'
import { estimateTokens, planWindow } from './token-estimator'

// 单次请求内 Agent 工具调用的最大迭代次数，防止模型陷入无限循环消耗额度
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? 6)

/**
 * 一轮 tool_calls 内并发执行的工具数上限。
 * 必须封顶：模型一次返回十几个 fetch_url 完全可能，不设上限就等于
 * 让模型决定实例的出站连接数，在 256MB 内存的云函数里很容易失控。
 */
const TOOL_CONCURRENCY = Math.max(
  1,
  Number(process.env.AGENT_TOOL_CONCURRENCY ?? 4),
)

/** 历史消息可用的 token 预算（不含 system 与摘要本身） */
const CONTEXT_TOKEN_BUDGET = Math.max(
  1000,
  Number(process.env.CONTEXT_TOKEN_BUDGET ?? 6000),
)

/** 窗口下限：哪怕摘要再长，也要保证至少带得走最近一问 */
const CONTEXT_MIN_TOKENS = 800

/** 关掉则退回“只裁剪不压缩”，用于对比测试或排障 */
const CONTEXT_SUMMARY_ENABLED = process.env.CONTEXT_SUMMARY_ENABLED !== 'false'

interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}

/** 持久化到 DB 的工具轨迹条目 */
interface StoredStep {
  id: string
  name: string
  arguments: string
  result: string
  ok: boolean
}

interface OutboundMessage {
  role: string
  content: string | null
  tool_calls?: unknown[]
  tool_call_id?: string
}

interface StreamState {
  content: string
  finishReason: string | null
  toolCalls: Map<number, { id: string; name: string; arguments: string }>
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name)

  constructor(
    private readonly configService: ConfigService,
    private readonly conversationsService: ConversationsService,
  ) {}

  /**
   * 把持久化的工具轨迹展开为符合 OpenAI 协议的多轮消息：
   * assistant(tool_calls) → tool(结果) → assistant(正文)，顺序不能错。
   */
  private expandHistory(m: {
    role: string
    content: string
    toolCalls: string | null
  }): OutboundMessage[] {
    const expanded: OutboundMessage[] = []
    let steps: StoredStep[] = []
    if (m.toolCalls) {
      try {
        steps = JSON.parse(m.toolCalls) as StoredStep[]
      } catch {
        this.logger.warn('工具轨迹解析失败，已忽略')
      }
    }

    if (steps.length) {
      expanded.push({
        role: 'assistant',
        content: '',
        tool_calls: steps.map((s) => ({
          id: s.id,
          type: 'function',
          function: { name: s.name, arguments: s.arguments },
        })),
      })
      for (const s of steps) {
        expanded.push({ role: 'tool', tool_call_id: s.id, content: s.result ?? '' })
      }
    }

    expanded.push({ role: m.role, content: m.content })
    return expanded
  }

  /**
   * 组装本轮要发送的历史：最近若干轮原文 + 更早内容的滚动摘要。
   *
   * 摘要边界（summaryUntil）随裁剪一起推进，因此同一段旧对话不会被反复压缩，
   * 也不会既出现在摘要里又原文重发。
   */
  private async buildContext(
    userId: string,
    config: PlainApiConfig,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<{ historyMessages: OutboundMessage[]; summary: string | null }> {
    const ctx = await this.conversationsService.loadContext(
      userId,
      conversationId,
    )
    const messages = ctx.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        toolCalls: m.toolCalls ?? null,
      }))

    // 摘要正文自己也要吃额度，先扣掉它实际占用的部分再算窗口
    const priorSummary = ctx.summary
    const budget = Math.max(
      CONTEXT_MIN_TOKENS,
      CONTEXT_TOKEN_BUDGET - estimateTokens(priorSummary ?? ''),
    )
    const { kept, dropped } = planWindow(messages, budget)

    const expand = (list: typeof kept) =>
      list.flatMap((m) => this.expandHistory(m))

    if (!dropped.length) {
      return { historyMessages: expand(kept), summary: priorSummary }
    }

    if (!CONTEXT_SUMMARY_ENABLED) {
      // 只丢不压：旧内容直接退出上下文，代价是模型失去早期记忆
      this.logger.warn(`上下文超预算，已丢弃 ${dropped.length} 条更早消息（摘要开关已关闭）`)
      return { historyMessages: expand(kept), summary: priorSummary }
    }

    const nextSummary = await buildRollingSummary(
      config,
      {
        priorSummary,
        // 工具轨迹不进摘要：它的结论已经体现在 assistant 正文里，重复计入只会推高成本
        dropped: dropped.map((m) => ({ role: m.role, content: m.content })),
      },
      signal,
    )
    const boundary = dropped[dropped.length - 1].timestamp
    await this.conversationsService.saveContext(
      userId,
      conversationId,
      nextSummary,
      boundary,
    )

    return { historyMessages: expand(kept), summary: nextSummary }
  }

  async streamChat(
    userId: string,
    conversationId: string,
    content: string,
    res: Response,
    signal?: AbortSignal,
  ): Promise<void> {
    const config = await this.configService.get(userId)
    if (!config) {
      throw new BadRequestException('尚未配置大模型 API，请先在设置中填写接口信息。')
    }

    // 多实例/冷启动下该对话可能不在当前实例的库里，先确保存在，避免下面直接 404
    await this.conversationsService.ensureExists(userId, conversationId)

    // 保存用户消息
    await this.conversationsService.addMessage(
      userId,
      conversationId,
      'user',
      content,
    )

    // 读取会话上下文：最近若干轮发原文，更早的内容走滚动摘要
    const { historyMessages, summary } = await this.buildContext(
      userId,
      config,
      conversationId,
      signal,
    )

    const messages: OutboundMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(summary
        ? [
            {
              role: 'system',
              content:
                '以下是本对话更早内容的摘要，请当作已知事实使用，不要向用户复述摘要本身：\n' +
                summary,
            },
          ]
        : []),
      ...historyMessages,
    ]

    const url = resolveCompletionsUrl(config.baseUrl)

    const steps: StoredStep[] = []

    // SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const sendEvent = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    let finalContent = ''
    const seenToolCallIds = new Set<string>()
    // 标记最近一轮是否以 tool_calls 结束：循环耗尽时据此区分「轮数上限」与「被截断」
    let endedWithToolCall = false

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            stream: true,
            tools: TOOL_DEFINITIONS,
          }),
          signal,
        })

        if (!response.ok) {
          const errText = await response.text().catch(() => '')
          sendEvent({ error: this.formatError(response, errText, config.provider) })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        const state = await this.consumeStream(response, sendEvent)
        messages.push({ role: 'assistant', content: state.content })
        finalContent += state.content

        // 模型决定调用工具
        if (state.finishReason === 'tool_calls' && state.toolCalls.size > 0) {
          endedWithToolCall = true
          const calls: ToolCall[] = [...state.toolCalls.values()].map((tc) => ({
            id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments || '{}' },
          })) as ToolCall[]

          // 回填 assistant 的 tool_calls，供下一轮请求使用
          messages[messages.length - 1].tool_calls = calls

          // 先统一登记步骤并发 calling 事件，再并发执行：
          // 展示顺序不再取决于执行顺序，前端靠 tool_call_id 对位更新
          const prepared = calls.map((call) => {
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(call.function.arguments) as Record<string, unknown>
            } catch {
              this.logger.warn(`工具参数解析失败: ${call.function.arguments}`)
            }

            if (!seenToolCallIds.has(call.id)) {
              seenToolCallIds.add(call.id)
              steps.push({
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
                result: '',
                ok: false,
              })
              sendEvent({
                tool: { id: call.id, name: call.function.name, args, status: 'calling' },
              })
            }

            return { call, args }
          })

          // executeTool 内部已吃掉异常，这里的失败分支只为未来可能 reject 的工具兼容
          const outcomes = await runWithConcurrency(
            prepared,
            TOOL_CONCURRENCY,
            ({ call, args }) => executeTool(call.function.name, args),
          )

          // 结果按 calls 原顺序回填，保证 tool 消息与 tool_calls 一一对应
          for (let i = 0; i < prepared.length; i++) {
            const { call, args } = prepared[i]
            const outcome = outcomes[i]
            const ok = outcome.ok === true ? outcome.value.ok : false
            const output =
              outcome.ok === true
                ? outcome.value.output
                : `工具执行异常：${(outcome.reason as Error)?.message ?? String(outcome.reason)}`

            const recorded = steps.find((s) => s.id === call.id)
            if (recorded) {
              recorded.result = output
              recorded.ok = ok
            }

            sendEvent({
              tool: {
                id: call.id,
                name: call.function.name,
                args,
                status: ok ? 'done' : 'error',
                result: output,
              },
            })

            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: output,
            })
          }
          // 继续下一轮，让模型基于工具结果作答
          continue
        }

        // 无工具调用，本轮即最终回答
        endedWithToolCall = false
        break
      }

      // 循环结束仍无任何文本：模型全程调工具直到轮数耗尽，或被 max_tokens
      // 截断后没留下文本。必须明确报错，而不是静默 [DONE] 让流"正常"结束
      if (!finalContent) {
        sendEvent({
          error: endedWithToolCall
            ? `模型连续调用工具达到 ${MAX_TURNS} 轮上限仍未给出回答，请简化问题后重试。`
            : '模型未生成有效回答，可能被输出长度上限截断，请重试或换一种问法。',
        })
      }

      if (finalContent) {
        await this.conversationsService.addMessage(
          userId,
          conversationId,
          'assistant',
          finalContent,
          steps,
        )
      }

      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // 用户中断：保留已生成的部分回答及工具轨迹
        if (finalContent) {
          await this.conversationsService
            .addMessage(userId, conversationId, 'assistant', finalContent, steps)
            .catch(() => undefined)
        }
        res.end()
        return
      }
      this.logger.error('聊天请求失败', (error as Error).stack)
      sendEvent({
        error: `请求失败：${(error as Error).message}`,
      })
      res.end()
    }
  }

  /**
   * 消费上游 SSE 流，逐字转发文本增量，并累积 tool_calls 分片。
   */
  private async consumeStream(
    response: ResponseType,
    sendEvent: (payload: Record<string, unknown>) => void,
  ): Promise<StreamState> {
    const state: StreamState = { content: '', finishReason: null, toolCalls: new Map() }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('无法读取上游响应流')
    }
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string | null
            }>
          }
          const choice = parsed.choices?.[0]
          if (!choice) continue

          if (choice.delta?.content) {
            state.content += choice.delta.content
            sendEvent({ content: choice.delta.content })
          }

          for (const tc of choice.delta?.tool_calls ?? []) {
            const index = tc.index ?? 0
            const current = state.toolCalls.get(index) ?? { id: '', name: '', arguments: '' }
            if (tc.id) current.id = tc.id
            if (tc.function?.name) current.name += tc.function.name
            if (tc.function?.arguments) current.arguments += tc.function.arguments
            state.toolCalls.set(index, current)
          }

          if (choice.finish_reason) {
            state.finishReason = choice.finish_reason
          }
        } catch {
          // 忽略无法解析的行
        }
      }
    }

    // 上游以 finish_reason: length 截断（输出达到 max_tokens 上限）：
    // 这不是正常结束，不提示的话半截回答会被当成完整结果展示并入库
    if (state.finishReason === 'length') {
      sendEvent({ notice: '本次输出达到长度上限被截断，可回复「继续」让模型接着写' })
    }

    return state
  }

  private formatError(
    response: ResponseType,
    errText: string,
    provider: string,
  ): string {
    let detail = ''
    try {
      const json = JSON.parse(errText) as { error?: { message?: string }; message?: string }
      detail = json.error?.message || json.message || errText
    } catch {
      detail = errText
    }

    const status = response.status
    if (status === 401 || status === 403) {
      return `${provider} API Key 校验未通过（${status}），请检查密钥是否有效、是否已过期。`
    }
    if (status === 429) {
      return `${provider} 接口调用过于频繁或余额不足（429），请稍后重试或检查账户额度。`
    }
    return `${provider} 接口调用失败（${status}）：${detail.slice(0, 200) || response.statusText}`
  }
}

type ResponseType = Awaited<ReturnType<typeof fetch>>
