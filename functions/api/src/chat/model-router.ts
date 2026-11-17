/**
 * 场景化模型选择：在同一个供应商（DeepSeek）的几个模型之间按本轮问题挑一个。
 *
 * 为什么放在服务端而不是让模型自己决定：模型自选要把「换个模型再答一遍」做成一次工具调用，
 * 多一跳、双份 token、失败难归因，还会白吃掉 AGENT_MAX_TURNS 的轮数预算。而这里的判定
 * 信号（问题长度、有没有代码、是不是要推理）本来就是确定可得的，没必要交给模型猜。
 *
 * 候选集来自 MODEL_ROUTING_CANDIDATES，**按档位从低到高**逗号分隔，例如
 * `deepseek-flash,deepseek-v4-pro`：不配就等于关掉这层，行为与改动前完全一致。
 * 模型名不写死在代码里——供应商的模型 id 会换，而且用户未必开通了那一档。
 */

/** 档位从低到高；空数组表示路由关闭 */
export function routingCandidates(): string[] {
  return (process.env.MODEL_ROUTING_CANDIDATES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 关掉则恒用配置里的主力模型，用于对比测试或排障 */
export function routingEnabled(): boolean {
  return process.env.MODEL_ROUTING_ENABLED !== 'false' && routingCandidates().length > 0
}

export interface RoutingInput {
  /** 本轮提问原文 */
  question: string
  /** 配置里的主力模型：路由关闭或判定失败时用它 */
  primary: string
}

export interface ModelDecision {
  model: string
  /** 给人看的中文理由，界面要解释「为什么是它」，否则用户只觉得同一句话有时快有时慢 */
  reason: string
  /** 0~1 的复杂度分，随事件下发，评测与排障都靠它 */
  score: number
}

/** 触发更重一档的信号：命中一条 +权重，累计过阈值即升档 */
const COMPLEX_SIGNALS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  // 明确要求深度思考的说法，优先级最高：用户显式要求不该被长度之类压过去
  { pattern: /仔细|详细|深入|一步步|逐步|好好想|认真|论证|证明|推导/, weight: 0.34, label: '要求深入' },
  { pattern: /设计|架构|重构|优化|排查|定位|为什么|原因|对比|评估|方案/, weight: 0.22, label: '分析设计类' },
  { pattern: /```|def |function |class |interface |=>|import /, weight: 0.26, label: '含代码' },
  // 表格/多列输出对格式稳定性要求高，弱模型容易把表格写崩
  { pattern: /表格|列表|分点|步骤|清单|格式/, weight: 0.12, label: '格式要求' },
]

/** 长度单独计分：短问题不值得升档，长输入往往伴随复杂任务 */
function lengthScore(question: string): number {
  const len = question.length
  if (len <= 40) return 0
  if (len <= 200) return 0.1
  if (len <= 800) return 0.22
  return 0.34
}

/**
 * 把提问映射到 0~1 的复杂度分。
 *
 * 上限封顶 1：信号叠满也不该越过最高档，否则多候选时永远选中最后一档，
 * 「按场景选」就退化成「永远用最贵的」。
 */
export function complexityScore(question: string): number {
  const hits = COMPLEX_SIGNALS.filter((s) => s.pattern.test(question))
  const raw = lengthScore(question) + hits.reduce((sum, s) => sum + s.weight, 0)
  return Math.min(1, Number(raw.toFixed(4)))
}

/** 命中了哪些信号，只用于拼理由文案 */
function matchedLabels(question: string): string[] {
  return COMPLEX_SIGNALS.filter((s) => s.pattern.test(question)).map((s) => s.label)
}

/**
 * 选择本轮实际使用的模型。
 *
 * 分数按档位线性映射：n 个候选就有 n-1 段，score 落在哪段用哪个。这样加第三档不用改逻辑。
 */
export function pickModel({ question, primary }: RoutingInput): ModelDecision {
  const candidates = routingCandidates()
  if (!routingEnabled() || candidates.length === 0) {
    return { model: primary, reason: '按主力模型作答（模型路由未配置）', score: 0 }
  }

  const score = complexityScore(question)
  const top = candidates.length - 1
  const index = Math.min(top, Math.floor(score * candidates.length))
  const model = candidates[index] ?? primary

  const labels = matchedLabels(question)
  const detail = labels.length ? `，命中信号：${labels.join('、')}` : ''
  const reason =
    index === 0
      ? `问题较轻（复杂度 ${score}），用第 1 档 ${model} 更快更省${detail}`
      : `复杂度 ${score}，升到第 ${index + 1} 档 ${model}${detail}`

  return { model, reason, score }
}

/**
 * 续传时必须沿用中断那一轮实际使用的模型。
 *
 * 上游没有「接着上一个模型继续写」的语义，换模型续写会让前后半段风格断裂甚至自相矛盾，
 * 而浏览器手上只有文本、看不出问题出在模型换了。库里没记（改动之前的旧数据）才回退路由器。
 */
export function resolveResumeModel(
  storedModel: string | null | undefined,
  fallback: ModelDecision,
): ModelDecision {
  const candidates = routingCandidates()
  const usable = storedModel && (candidates.length === 0 || candidates.includes(storedModel))
  if (usable) {
    return {
      model: storedModel as string,
      reason: `续传沿用中断那一轮的 ${storedModel}，避免前后半段换了模型`,
      score: fallback.score,
    }
  }
  return fallback
}
