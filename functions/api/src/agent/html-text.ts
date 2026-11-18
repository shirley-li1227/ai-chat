/**
 * 增量 HTML 正文抽取。
 *
 * 为什么不用一次性正则：fetch_url 要把抽取到的正文**边下载边推给界面**，
 * 而 `<[^>]+>` 这类整篇替换必须等全文落地才有结果。留两份实现更糟——
 * 流式路径与一次性路径迟早给出不同文本，工具结果和界面看到的就对不上。
 * 所以这里只有一份：`htmlToText` 也改成它的单次封装。
 *
 * 与旧正则的口径差异只有一处，而且是往好了走：`<!-- … -->` 现在按注释整段丢弃，
 * 旧写法遇到注释里带 `>` 会漏出来半句话。
 */

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
}

/** 未闭合实体的等待上限：超过就不可能是上面这几个了，原样当正文处理 */
const MAX_ENTITY_CHARS = 8

/** 整段丢弃内容的标签：不丢就会把一屏 CSS/JS 当成网页正文喂给模型 */
const RAW_TAGS = ['script', 'style'] as const

type Mode = 'text' | 'tag' | 'comment' | 'raw'

/**
 * 开头还判断不出来的残缺串：'<'、'</'、'<!'、'<!-'、'<--' 都可能长成注释或标签，
 * 必须留到下一块再定性，否则切在中间的 '!--' 会当正文漏出来。
 */
const INCOMPLETE_OPENER = /^<[-/!?]*$/

/** 已能定性为markup 起点：普通标签、结束标签或 <!DOCTYPE> 这类声明 */
const MARKUP_START = /^<[/!a-zA-Z]/

/** 标签体的等待上限：畸形页面里永不出现的 '>' 不该把内存吃满 */
const MAX_TAG_CHARS = 4096

function isSpaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

export class HtmlTextStream {
  private mode: Mode = 'text'
  /** 尚未定论的尾巴：未闭合的标签、实体或结束串的一部分 */
  private pending = ''
  /** 已经攒出的正文 */
  private accumulated = ''
  /** 本次 push/end 新产出的正文，取走即清空——SSE delta 就是它 */
  private fragment = ''
  /** 上一次输出之后是否出现过空白或标签，用于把整篇的空白折叠压到一行上 */
  private gap = false
  /** raw 模式下在等的结束串，小写，例如 '</script' */
  private rawClose = ''
  private saturated = false

  /**
   * @param maxChars 正文长度上限，到量后不再产出。
   *   截断必须发生在这里而不是调用方 slice：流式路径的 delta 拼起来要
   *   逐字等于最终结果，事后裁剪会让界面已经显示的内容和落库的对不上。
   */
  constructor(private readonly maxChars: number = Number.POSITIVE_INFINITY) {}

  /** 到目前为止抽出的正文 */
  get value(): string {
    return this.accumulated
  }

  /** 已达上限：调用方据此提前收口，不必把整个响应下完 */
  get full(): boolean {
    return this.saturated
  }

  /** 喂入一段原始 HTML，返回本次新增的正文片段（可能为空串） */
  push(chunk: string): string {
    if (!chunk) {
      return ''
    }
    if (this.saturated) {
      this.pending = ''
      return ''
    }
    this.pending += chunk
    this.consume()
    return this.takeFragment()
  }

  /**
   * 收尾：还说不清的正文尾巴（'<'、'&am'）按字面留下，最后几个字不该凭空消失；
   * 停在 tag/raw/comment 里的尾巴是没闭合的标记本身，丢了才对——
   * 否则被 maxBytes 截断的页面会把半截 CSS 当作正文的结尾推给界面。
   */
  end(): string {
    const tail = this.mode === 'text' && !this.saturated ? this.pending : ''
    this.pending = ''
    this.mode = 'text'
    this.rawClose = ''
    if (tail) {
      this.writeNormalized(tail)
    }
    return this.takeFragment()
  }

  private takeFragment(): string {
    const out = this.fragment
    this.fragment = ''
    return out
  }

  private consume(): void {
    for (;;) {
      if (!this.pending) {
        return
      }

      if (this.mode === 'tag') {
        const close = this.pending.indexOf('>')
        if (close === -1) {
          // 标签体必须等 '>' 到齐才定性：块切在 '<scr' 时就把名字记下来，
          // 后面 <script> 的正文会被当普通文字吐给模型。
          // 上限只防畸形页面里永不出现的 '>'，正常标签体不会是这个量级。
          if (this.pending.length > MAX_TAG_CHARS) {
            this.pending = ''
          }
          return
        }
        const opener = this.pending.slice(0, close)
        this.pending = this.pending.slice(close + 1)
        this.gap = true
        const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(opener)?.[1].toLowerCase() ?? ''
        if (!opener.startsWith('</') && RAW_TAGS.includes(name as (typeof RAW_TAGS)[number])) {
          this.mode = 'raw'
          // 结束串带上 '<'，否则正文里的 "script" 一词也会算命中
          this.rawClose = `</${name}`
        } else {
          this.mode = 'text'
        }
        continue
      }

      if (this.mode === 'comment') {
        const close = this.pending.indexOf('-->')
        if (close === -1) {
          // '--' 可能被切在两块之间，留 2 个字符下一轮再看
          this.pending = this.pending.slice(Math.max(0, this.pending.length - 2))
          return
        }
        this.pending = this.pending.slice(close + 3)
        this.gap = true
        this.mode = 'text'
        continue
      }

      if (this.mode === 'raw') {
        const lower = this.pending.toLowerCase()
        const hit = lower.indexOf(this.rawClose)
        if (hit === -1) {
          const keep = this.rawClose.length - 1
          this.pending = this.pending.slice(Math.max(0, this.pending.length - keep))
          return
        }
        this.pending = this.pending.slice(hit + this.rawClose.length)
        this.rawClose = ''
        this.mode = 'tag'
        continue
      }

      if (!this.scanText()) {
        return
      }
    }
  }

  /**
   * 文本模式：把安全的正文先吐出去，遇到 '<' 或 '&' 就切换状态。
   * 返回 false 表示尾巴还说不清，要等下一块。
   */
  private scanText(): boolean {
    const lt = this.pending.indexOf('<')
    const amp = this.pending.indexOf('&')
    const at = lt === -1 ? amp : amp === -1 || lt < amp ? lt : amp
    if (at === -1) {
      this.writeNormalized(this.pending)
      this.pending = ''
      return true
    }

    if (at > 0) {
      this.writeNormalized(this.pending.slice(0, at))
      this.pending = this.pending.slice(at)
    }

    if (this.pending[0] === '&') {
      const semi = this.pending.indexOf(';')
      if (semi === -1) {
        if (this.pending.length > MAX_ENTITY_CHARS) {
          // 等不成实体了，把 '&' 当普通字符吐出去继续走
          this.writeNormalized(this.pending.slice(0, 1))
          this.pending = this.pending.slice(1)
          return true
        }
        return false
      }
      const token = this.pending.slice(0, semi + 1)
      this.writeNormalized(ENTITIES[token] ?? token)
      this.pending = this.pending.slice(semi + 1)
      return true
    }

    // 到这里 pending 以 '<' 开头
    if (this.pending.startsWith('<!--')) {
      this.pending = this.pending.slice(4)
      this.mode = 'comment'
      return true
    }
    if (INCOMPLETE_OPENER.test(this.pending)) {
      // 只写了 '<'、'</'、'<!'、'<!-'，下一块才看得清是注释还是标签
      return false
    }
    if (MARKUP_START.test(this.pending)) {
      // 定性交给 tag 分支：它等 '>' 收口后才决定是普通标签还是 script/style
      this.mode = 'tag'
      return true
    }
    // 不是标签起点（例如 "a < b"），原样当正文
    this.writeNormalized('<')
    this.pending = this.pending.slice(1)
    return true
  }

  /**
   * 折叠空白并写入正文。
   *
   * 空白不立刻输出而是记成 gap：它可能来自标签、也可能来自源码里的换行缩进，
   * 两者在结果里都只该值一个空格，且段落开头不该有。
   *
   * 逐字写进 accumulated 而不是先攒成本地变量：空格要不要补、正文到没到上限
   * 都得看**当前**已产出的长度，攒着批量写会让这两个判断在整段内都用同一个旧值，
   * 一次到位的解析和分块解析就会给出不同文本。
   */
  private writeNormalized(raw: string): void {
    if (!raw || this.saturated) {
      return
    }
    for (const ch of raw) {
      if (isSpaceChar(ch)) {
        this.gap = true
        continue
      }
      const space = this.gap && this.accumulated ? ' ' : ''
      if (this.accumulated.length + space.length + ch.length > this.maxChars) {
        this.saturated = true
        return
      }
      this.gap = false
      this.accumulated += space + ch
      this.fragment += space + ch
    }
  }
}

/** 一次性抽取：与流式共用同一份状态机，保证两条路径给出逐字相同的结果 */
export function htmlToText(html: string): string {
  const stream = new HtmlTextStream()
  stream.push(html)
  stream.end()
  return stream.value
}
