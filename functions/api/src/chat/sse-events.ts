/**
 * SSE 事件体的唯一组装处。
 *
 * 为什么要从 chat.service 里抽出来：这些 payload 是前后端的接口契约，
 * 前端按 `tool.id` 归位、按 `status` 决定追加还是覆盖。散在循环里写就没人能保证
 * 每个事件都带上 id——漏一次，并发执行的多个工具就会把进度画到同一步上。
 * 评测脚本也只有在纯函数上才断言得了这份契约（不必起服务）。
 */

import type { ToolProgress } from '../agent/tools'

export interface ToolStreamPatch {
  delta?: string
  progress?: ToolProgress
}

// 用 type 而不是 interface：调用方 sendEvent 的参数是 Record<string, unknown>，
// 只有对象字面量类型才自带隐式索引签名，换成 interface 会在赋值处报类型不兼容
export type ToolEvent = {
  tool: {
    id: string
    name: string
    args?: Record<string, unknown>
    status: 'calling' | 'streaming' | 'done' | 'error'
    result?: string
    delta?: string
    progress?: ToolProgress
  }
}

export function toolCallingEvent(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolEvent {
  return { tool: { id, name, args, status: 'calling' } }
}

/** 执行期间的增量：正文片段与量化进度可以同时有，也可以只有其一 */
export function toolStreamingEvent(
  id: string,
  name: string,
  patch: ToolStreamPatch,
): ToolEvent {
  return { tool: { id, name, status: 'streaming', ...patch } }
}

/** 终态事件带完整 result，前端据此覆盖累积的 delta——两边是同一份文本，界面不会跳字 */
export function toolResultEvent(
  id: string,
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  output: string,
): ToolEvent {
  return { tool: { id, name, args, status: ok ? 'done' : 'error', result: output } }
}
