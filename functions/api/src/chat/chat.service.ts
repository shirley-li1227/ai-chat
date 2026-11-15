import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '../config/config.service'
import { ConversationsService } from '../conversations/conversations.service'
import { Response } from 'express'
import { TOOL_DEFINITIONS, executeTool } from '../agent/tools'

const SYSTEM_PROMPT = `你是一位友善、专业的 AI 助手，具备调用外部工具的能力。

## 工具使用准则
1. 你可以调用 get_current_time、calculator、fetch_url 等工具。是否调用、调用哪个、调用几次，完全由你自主判断。
2. 涉及算术运算必须用 calculator，禁止心算；询问当前时间必须用 get_current_time，禁止凭记忆推测；需要网页上的实时信息用 fetch_url。
3. 若一次工具返回不足以回答，可继续调用其他工具，逐步收敛后再作答；不要编造工具未返回的内容。
4. 工具返回错误或结果异常时，应说明原因并尝试调整参数重试，而不是直接放弃。
5. 不需要工具的问题（闲聊、写作、开放讨论）直接回答，不要为了调用而调用。

## 输出格式规范
1. 使用 Markdown 组织回答；代码块必须带语言标记（如 \`\`\`python）。
2. 输出表格时，务必严格遵守 GFM 表格语法：
   - 每行表格数据独占一行，行末必须使用换行符 \\n 结束；
   - 分隔行（形如 |---|---|）紧跟在表头下方，不允许与表头挤在同一行；
   - 单元格之间使用竖线 | 分隔，不要在行内追加多余空格；
   - 严禁把整张表格压缩到一行内。
3. 列表、标题、段落之间也要保持正常换行，避免所有内容连成一片。
4. 回答力求简洁清晰，如信息不足或存在多种可能，请主动说明。`

// 单次请求内 Agent 工具调用的最大迭代次数，防止模型陷入无限循环消耗额度
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? 6)

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

  async streamChat(
    conversationId: string,
    content: string,
    res: Response,
    signal?: AbortSignal,
  ): Promise<void> {
    const config = await this.configService.get()
    if (!config) {
      throw new BadRequestException('尚未配置大模型 API，请先在设置中填写接口信息。')
    }

    // 多实例/冷启动下该对话可能不在当前实例的库里，先确保存在，避免下面直接 404
    await this.conversationsService.ensureExists(conversationId)

    // 保存用户消息
    await this.conversationsService.addMessage(conversationId, 'user', content)

    // 读取会话上下文，含历史工具轨迹
    const conversation = await this.conversationsService.findOne(conversationId)
    const historyMessages = conversation.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .flatMap((m) =>
        this.expandHistory({ role: m.role, content: m.content, toolCalls: m.toolCalls ?? null }),
      )

    const messages: OutboundMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historyMessages,
    ]

    const baseUrl = config.baseUrl.trim().replace(/\/+$/, '')
    const url = /\/chat\/completions$/i.test(baseUrl)
      ? baseUrl
      : `${baseUrl}/chat/completions`

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

          for (const call of calls) {
            let parsedArgs: Record<string, unknown> = {}
            try {
              parsedArgs = JSON.parse(call.function.arguments) as Record<string, unknown>
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
                tool: { id: call.id, name: call.function.name, args: parsedArgs, status: 'calling' },
              })
            }

            const result = await executeTool(call.function.name, parsedArgs)
            const recorded = steps.find((s) => s.id === call.id)
            if (recorded) {
              recorded.result = result.output
              recorded.ok = result.ok
            }

            sendEvent({
              tool: {
                id: call.id,
                name: call.function.name,
                args: parsedArgs,
                status: result.ok ? 'done' : 'error',
                result: result.output,
              },
            })

            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: result.output,
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
            .addMessage(conversationId, 'assistant', finalContent, steps)
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
