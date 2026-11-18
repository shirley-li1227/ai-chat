import { createHash } from 'node:crypto'

/**
 * 跨会话长期记忆的纯策略层：开关、上限、去重指纹、注入文本组装、编号解析。
 *
 * 为什么单独成文件（和 tasks/task-policy.ts 同一个理由）：这些判定既被 Nest 服务用，
 * 也要被评测脚本在无数据库、无容器的条件下直接断言，混进 service 里就只能靠起服务来验证。
 */

/** model=模型在对话里自主记录，user=用户在「长期记忆」面板里亲手写的 */
export type MemorySource = 'model' | 'user'

/** 策略层眼里的一条记忆：时间统一用毫秒，排序与淘汰只看 updatedAt */
export interface MemoryItem {
  id: string
  content: string
  source: MemorySource
  updatedAt: number
}

function clamp(value: number, floor: number, ceiling: number): number {
  if (!Number.isFinite(value)) {
    return floor
  }
  return Math.min(ceiling, Math.max(floor, Math.round(value)))
}

/**
 * 只认字面 'false' 关闭，缺省即开启——与 CONTEXT_SUMMARY_ENABLED、MODEL_ROUTING_ENABLED 同口径。
 * 关掉后不再广播 remember/forget，也不再注入任何记忆，行为回到「只有会话内摘要」。
 */
export function memoryEnabled(): boolean {
  return process.env.MEMORY_ENABLED !== 'false'
}

/** 单条记忆的字数上限：超过这个长度的一般是任务上下文，不是长期事实 */
export function memoryItemMaxChars(): number {
  return clamp(Number(process.env.MEMORY_ITEM_MAX_CHARS ?? 200), 40, 500)
}

/** 每个身份最多留多少条，超出按最后更新时间淘汰最旧的 */
export function memoryMaxEntries(): number {
  return clamp(Number(process.env.MEMORY_MAX_ENTRIES ?? 100), 5, 500)
}

/** 注入 system 的字符预算：长期记忆不该把上下文窗口吃掉，宁可少带几条 */
export function memoryInjectMaxChars(): number {
  return clamp(Number(process.env.MEMORY_INJECT_MAX_CHARS ?? 1500), 200, 4000)
}

/** 归一化正文：折叠空白、去首尾，让「同一句话多打两个空格」不至于记成两条 */
export function normalizeMemoryContent(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * 去重指纹。哈希成定长十六进制而不是存归一化正文，一是长度可控（varchar(64)），
 * 二是大小写不同的同一句话不该记两遍——事实本身没有大小写。
 */
export function memoryFingerprint(content: string): string {
  return createHash('sha256')
    .update(normalizeMemoryContent(content).toLowerCase())
    .digest('hex')
}

/**
 * 给模型看的编号：取 uuid 去掉连字符后的前 8 位。
 * 完整 uuid 又长又容易被模型抄错一位，而 8 位十六进制在几十条量级下撞号的概率可以忽略，
 * 且解析时仍要求「在该用户的条目里唯一」，撞上了就报歧义而不是误删。
 */
export function memoryHandle(id: string): string {
  return id.replace(/-/g, '').slice(0, 8)
}

export interface InjectionPlan {
  /** 预算内带得走的条目，按 updatedAt 新→旧 */
  chosen: MemoryItem[]
  /** 因条数或预算被挡在外面的数量，注入文本里要如实告诉模型 */
  omitted: number
}

/**
 * 挑选注入条目。
 *
 * 新→旧而不是旧→新：最近记下的偏好通常正是当前话题需要的，预算不够时先牺牲陈旧的那些。
 * 预算按「渲染后整行」计，不然编号与分隔符这些固定开销会悄悄把字符数顶上去。
 */
export function selectForInjection(
  items: MemoryItem[],
  budget = memoryInjectMaxChars(),
): InjectionPlan {
  const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt)
  const chosen: MemoryItem[] = []
  let used = 0

  for (const item of sorted) {
    const cost = memoryHandle(item.id).length + item.content.length + 4
    if (used + cost > budget) {
      return { chosen, omitted: sorted.length - chosen.length }
    }
    used += cost
    chosen.push(item)
  }

  return { chosen, omitted: 0 }
}

/**
 * 注入到 system 的那段文本。
 *
 * 三句话是给模型的行为边界，不是给人看的注释：不带编号它没法调 forget，
 * 不说「本轮明确说法优先」它就会拿旧偏好压过用户刚提的要求，
 * 不声明「别复述」它就会把清单原样吐回界面。
 */
export function renderMemoryPrompt(plan: InjectionPlan): string | null {
  if (!plan.chosen.length) {
    return null
  }

  const lines = plan.chosen.map((item) => `- [${memoryHandle(item.id)}] ${item.content}`)
  const tail = plan.omitted
    ? `\n（另有 ${plan.omitted} 条更早的记忆因超出注入预算未列出。）`
    : ''

  return (
    '以下是这位用户的长期记忆，来自以往的其他会话，请当作已知背景使用：\n' +
    lines.join('\n') +
    tail +
    '\n规则：用户本轮的明确说法优先于这些记录，冲突时用 forget 删掉过时的那条（编号见上方方括号）；' +
    '不要把本清单复述给用户，也不要在回答里标注编号。'
  )
}

export type HandleMatch =
  | { ok: true; id: string }
  | { ok: false; reason: 'unknown' | 'ambiguous'; candidates: string[] }

/**
 * 把模型给的编号解析成真实条目 id，支持完整 uuid 与前缀。
 *
 * 前缀匹配是有意放宽的：模型经常只抄前几位。放宽的前提是「在该用户的条目里唯一」，
 * 一旦有多个候选就报歧义并列出完整编号，让它下一轮自己选对，而不是猜一个删掉。
 */
export function resolveMemoryHandle(
  items: MemoryItem[],
  rawHandle: string,
): HandleMatch {
  const needle = normalizeHandle(rawHandle)
  if (!needle) {
    return { ok: false, reason: 'unknown', candidates: [] }
  }

  const exact = items.find(
    (item) => item.id === rawHandle.trim() || memoryHandle(item.id) === needle,
  )
  if (exact) {
    return { ok: true, id: exact.id }
  }

  const prefixed = items.filter((item) => idOf(item).startsWith(needle))
  if (prefixed.length === 1) {
    return { ok: true, id: prefixed[0].id }
  }
  if (prefixed.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: prefixed.map((item) => memoryHandle(item.id)),
    }
  }
  return { ok: false, reason: 'unknown', candidates: [] }
}

function idOf(item: MemoryItem): string {
  return item.id.replace(/-/g, '').toLowerCase()
}

function normalizeHandle(raw: string): string {
  return raw.replace(/[\s[\]()「」]/g, '').replace(/^-+|-+$/g, '').toLowerCase()
}
