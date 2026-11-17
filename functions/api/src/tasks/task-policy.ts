/**
 * 后台任务的队列策略：状态机、可领取判定、退避与上限。
 *
 * 为什么单独成文件：这些判定只依赖任务自身的几个字段，抽成纯函数后
 * 评测脚本不必起数据库就能断言「过期租约可被回收」「退避期内不可领」
 * 「终态不可再改」——而这三条恰恰是最容易在改字段时悄悄写错的。
 * TaskService 的领取条件也复用这里，避免 SQL 与内存判定各写一套而漂移。
 */

export const TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 终态不再接受任何写入，迟到的 runner 结果必须被丢弃而不是复活任务 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'canceled',
]

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** 队列判定只关心这几列，评测可以用内存对象直接构造 */
export interface TaskQueueFields {
  status: TaskStatus
  attempts: number
  leaseUntil: number | null
  notBefore: number | null
}

/** 执行器存活证明的有效期：进程崩在这里最长被占用这么久，之后别的实例可抢占 */
export function leaseMs(): number {
  return Math.max(5000, Number(process.env.TASK_LEASE_MS ?? 120000))
}

/** 单个任务最多执行几次（含首次），超过就判失败，不再无限重投 */
export function maxAttempts(): number {
  return Math.max(1, Number(process.env.TASK_MAX_ATTEMPTS ?? 3))
}

/**
 * 是否挂了后台执行器。没挂时不该把 run_in_background 广播给模型：
 * 模型会提交出一批永远排队、用户永远等不到的任务，比没有这个能力更糟。
 * 由部署方设置（worker 上线即打开），API 与工具共用同一个判定。
 */
export function backgroundTasksEnabled(): boolean {
  return process.env.BACKGROUND_TASKS_ENABLED === 'true'
}

/** 领取时一次扫描的候选条数上限 */
export function claimScanLimit(): number {
  return Math.max(1, Number(process.env.TASK_CLAIM_SCAN ?? 20))
}

/** payload 序列化后的字节上限：任务表是请求侧与执行侧共用的一张表，不能被撑爆 */
export function payloadMaxBytes(): number {
  return Math.max(256, Number(process.env.TASK_PAYLOAD_MAX_BYTES ?? 8192))
}

/** 结果与错误文本的落库上限 */
export function resultMaxChars(): number {
  return Math.max(200, Number(process.env.TASK_RESULT_MAX_CHARS ?? 20000))
}

/** 失败重试的指数退避：5s、10s、20s… 最多 5 分钟，避免崩坏的下游被反复戳 */
export function backoffMs(attemptsAlreadyMade: number): number {
  const base = 5000 * Math.pow(2, Math.max(0, attemptsAlreadyMade - 1))
  return Math.min(base, 300000)
}

/**
 * 现在能不能被某个执行器领走。
 * notBefore 是退避门；running 只有在租约过期后才是候选——
 * 租约没过期说明还有实例在跑，抢过来只会让同一次任务跑两遍。
 */
export function isClaimable(task: TaskQueueFields, now = Date.now()): boolean {
  if (task.notBefore !== null && task.notBefore > now) {
    return false
  }
  if (task.status === 'queued') {
    return true
  }
  if (task.status === 'running') {
    return task.leaseUntil !== null && task.leaseUntil <= now
  }
  return false
}

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'canceled'],
  running: ['queued', 'succeeded', 'failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 未显式声明可重试的失败按「不值得重跑」处理，直接终态 */
export type FailureOutcome = {
  status: TaskStatus
  error: string
  notBefore: number | null
}

export function planFailure(
  task: TaskQueueFields,
  error: string,
  options: { retryable?: boolean } = {},
): FailureOutcome {
  const text = clipText(error, resultMaxChars())
  if (options.retryable && task.attempts < maxAttempts()) {
    return {
      status: 'queued',
      error: `第 ${task.attempts}/${maxAttempts()} 次尝试失败：${text}`,
      notBefore: Date.now() + backoffMs(task.attempts),
    }
  }
  return {
    status: 'failed',
    error: text,
    notBefore: null,
  }
}

/** 长文本截断，并在结尾留下可辨认的标记，免得半截结果被当成完整输出 */
export function clipText(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, max)}\n…（内容超出 ${max} 字已截断，共 ${value.length} 字）`
}
