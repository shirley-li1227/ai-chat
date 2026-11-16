import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { Response } from 'express'
import { TOOL_DEFINITIONS, executeTool } from '../agent/tools'
import { runWithConcurrency } from '../agent/tool-runner'
import { SYSTEM_PROMPT } from './prompt'
import { resolveCompletionsUrl } from './llm-client'
import type { PlainApiConfig } from './llm-config'
import { planWindow } from './token-estimator'
import type { HistoryMessageDto } from './chat-request.dto'

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

/** 历史消息可用的 token 预算：超出的更早轮次直接退出上下文 */
const CONTEXT_TOKEN_BUDGET = Math.max(
  1000,
  Number(process.env.CONTEXT_TOKEN_BUDGET ?? 6000),
)

interface ToolCall {
  id: string
  function: { name: string; arguments: string }
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

  /**
   * 把带工具轨迹的历史消息展开为符合 OpenAI 协议的多轮消息：
   * assistant(tool_calls) → tool(结果) → assistant(正文)，顺序不能错。
   */
  private expandHistory(m: HistoryMessageDto): OutboundMessage[] {
    const expanded: OutboundMessage[] = []
    const steps = m.toolCalls ?? []

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
   * 无状态下发历史：客户端每轮把整段对话传上来，这里只按 token 预算裁窗。
   *
   * 与落库版本的差别是滑出窗口的旧内容直接消失，没有滚动摘要可回填——
   * 摘要本身要有地方存才谈得上「滚动」，而这一版什么都不存。
   */
  private buildMessages(history: HistoryMessageDto[], content: string): OutboundMessage[] {
    // toolCalls 传 JSON 原文给裁剪器估算（含每条 tool 消息的角色开销），
    // 同时挂一份结构化原样，裁剪后还要靠它还原协议消息
    const all = [...history, { role: 'user' as const, content }].map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
      raw: m,
    }))

    const { kept, dropped } = planWindow(all, CONTEXT_TOKEN_BUDGET)

    if (dropped.length) {
      this.logger.warn(`上下文超预算，已丢弃 ${dropped.length} 条更早消息`)
    }

    return kept.flatMap((m) => this.expandHistory(m.raw))
  }

  async streamChat(
    config: PlainApiConfig | null,
    history: HistoryMessageDto[],
    content: string,
    res: Response,
    signal?: AbortSignal,
  ): Promise<void> {
    // 放在写 SSE 响应头之前：此刻还是普通请求，能正常返回 400 结构化错误
    if (!config) {
      throw new BadRequestException(
        '后端未配置大模型 API Key，请在 functions/api/.env 或云函数环境变量中设置 LLM_API_KEY。',
      )
    }

    const messages: OutboundMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.buildMessages(history, content),
    ]

    const url = resolveCompletionsUrl(config.baseUrl)

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

      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // 用户中断：半截回答留在客户端界面里，由它自己决定是否落盘
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
    // 这不是正常结束，不提示的话半截回答会被当成完整结果展示
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
