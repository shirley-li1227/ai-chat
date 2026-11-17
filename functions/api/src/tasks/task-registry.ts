import { backgroundableToolNames, findToolSpec, validateToolArgs } from '../agent/tools'

/**
 * 任务类型注册表：声明「有哪些 kind、每种 kind 的 payload 长什么样、
 * 领取后应该怎么执行」。
 *
 * 提交校验与执行解释共用 resolve()，因此不会出现「接口收下了、
 * 执行器读不懂」的任务——这类错位通常要等到排队很久之后才暴露。
 * 新增一种后台能力（例如批量抓取汇总、报告生成）就是在这里加一个 spec，
 * 接口的 kind 列表、前端的表单说明和执行器的分发会一起生效。
 */

/** 执行器拿到的可执行说明，目前只有「跑一个已注册工具」 */
export type TaskInvocation = {
  type: 'tool'
  name: string
  args: Record<string, unknown>
}

export interface TaskFieldSpec {
  name: string
  type: 'string' | 'object' | 'number' | 'boolean'
  required: boolean
  description: string
  enum?: string[]
}

export interface TaskKindSpec {
  kind: string
  description: string
  fields: TaskFieldSpec[]
  resolve(
    payload: Record<string, unknown>,
  ): { ok: true; invocation: TaskInvocation } | { ok: false; error: string }
}

export const TOOL_CALL_KIND = 'tool_call'

const toolCallKind: TaskKindSpec = {
  kind: TOOL_CALL_KIND,
  description:
    '在后台执行一个已注册的工具，适合耗时明显超过一次对话等待的操作（例如抓取一个很大的页面）。',
  fields: [
    {
      name: 'name',
      type: 'string',
      required: true,
      description: `要后台执行的工具名，当前支持：${backgroundableToolNames().join('、')}`,
      enum: backgroundableToolNames(),
    },
    {
      name: 'arguments',
      type: 'object',
      required: true,
      description: '该工具自身的参数对象，字段与该工具声明一致',
    },
  ],
  resolve(payload) {
    const names = backgroundableToolNames()
    const name = String(payload.name ?? '').trim()
    if (!name) {
      return { ok: false, error: 'payload.name 不能为空，可用工具：' + (names.join('、') || '（无）') }
    }
    const spec = findToolSpec(name)
    if (!spec) {
      return { ok: false, error: `工具 ${name} 未注册` }
    }
    if (!spec.background) {
      return {
        ok: false,
        error: `工具 ${name} 不适合后台执行（它的结果需要在当前回答里立即用上）；可后台执行的是 ${
          names.join('、') || '（无）'
        }`,
      }
    }

    const rawArgs = payload.arguments ?? {}
    if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return { ok: false, error: 'payload.arguments 必须是一个 JSON 对象' }
    }
    const problem = validateToolArgs(spec, rawArgs)
    if (problem) {
      return { ok: false, error: `payload.arguments ${problem}` }
    }

    return { ok: true, invocation: { type: 'tool', name, args: rawArgs as Record<string, unknown> } }
  },
}

export const TASK_KINDS: TaskKindSpec[] = [toolCallKind]

export function findTaskKind(kind: string): TaskKindSpec | undefined {
  return TASK_KINDS.find((spec) => spec.kind === kind)
}

/** 给前端与模型看的 kind 说明 */
export function describeTaskKinds(): { kind: string; description: string; fields: TaskFieldSpec[] }[] {
  return TASK_KINDS.map(({ kind, description, fields }) => ({ kind, description, fields }))
}

export function unknownKindError(kind: string): string {
  return `未知的任务类型 "${kind}"，可用类型：${TASK_KINDS.map((spec) => spec.kind).join('、')}`
}

/**
 * 把一条任务解析成可执行说明。
 * @param payload 已解析的对象，或落库的 JSON 文本
 */
export function resolveTaskInvocation(
  task: { kind: string; payload: Record<string, unknown> | string },
): { ok: true; invocation: TaskInvocation } | { ok: false; error: string } {
  const spec = findTaskKind(task.kind)
  if (!spec) {
    return { ok: false, error: unknownKindError(task.kind) }
  }

  let payload: unknown = task.payload
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as unknown
    } catch {
      return { ok: false, error: '任务 payload 不是合法 JSON' }
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '任务 payload 必须是一个 JSON 对象' }
  }
  return spec.resolve(payload as Record<string, unknown>)
}
