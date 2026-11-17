import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, MoreThanOrEqual, Repository } from 'typeorm'
import { Conversation } from './conversation.entity'
import { Message } from './message.entity'

/** 一次请求需要的全部上下文状态 */
export interface ConversationContext {
  messages: Message[]
  summary: string | null
  summaryUntil: number | null
}

@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly msgRepo: Repository<Message>,
  ) {}

  async findAll(userId: string): Promise<Conversation[]> {
    return this.convRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      relations: { messages: false },
    })
  }

  async findOne(userId: string, id: string): Promise<Conversation> {
    const conv = await this.owned(userId, id, { messages: true })
    conv.messages.sort((a, b) => a.timestamp - b.timestamp)
    return conv
  }

  async create(userId: string): Promise<Conversation> {
    const conv = this.convRepo.create({ title: '新对话', userId })
    return this.convRepo.save(conv)
  }

  /**
   * 确保指定 id 的对话存在：不存在则用该 id 新建。
   * 用于 sqljs 每实例私有 /tmp、多实例或冷启动导致对话在其它实例缺失时，
   * 避免 chat 直接抛 NotFoundException（404）。
   *
   * id 已存在但属于别人时一律按“不存在”处理：既不能读写他人会话，
   * 也不能拿同一个 id 去撞主键。
   */
  async ensureExists(userId: string, id: string): Promise<void> {
    const existing = await this.convRepo.findOne({ where: { id } })
    if (existing) {
      if (existing.userId !== userId) {
        throw new NotFoundException('对话不存在')
      }
      return
    }

    const created = this.convRepo.create({ id, title: '新对话', userId })
    await this.convRepo.save(created)
  }

  async updateTitle(
    userId: string,
    id: string,
    title: string,
  ): Promise<Conversation> {
    const conv = await this.owned(userId, id)
    conv.title = title
    return this.convRepo.save(conv)
  }

  async remove(userId: string, id: string): Promise<void> {
    const conv = await this.owned(userId, id)
    await this.convRepo.remove(conv)
  }

  /**
   * 一次性取回裁剪上下文所需的全部信息，避免 ChatService 为了算窗口再跑一次查询。
   */
  async loadContext(
    userId: string,
    id: string,
  ): Promise<ConversationContext> {
    const conv = await this.owned(userId, id, { messages: true })
    const messages = [...conv.messages].sort((a, b) => a.timestamp - b.timestamp)
    return {
      messages,
      summary: conv.contextSummary ?? null,
      summaryUntil: conv.summaryUntil ?? null,
    }
  }

  /**
   * 写入滚动摘要。摘要没变时不写，否则 UpdateDateColumn 会无意义地推后 updatedAt，
   * 前端会话列表排序会因此跳动。
   */
  async saveContext(
    userId: string,
    id: string,
    summary: string,
    summaryUntil: number,
  ): Promise<void> {
    const conv = await this.convRepo.findOne({ where: { id, userId } })
    if (!conv) {
      return
    }
    if (conv.contextSummary === summary && conv.summaryUntil === summaryUntil) {
      return
    }
    conv.contextSummary = summary
    conv.summaryUntil = summaryUntil
    await this.convRepo.save(conv)
  }

  /**
   * 截断到某条消息之前：删除 timestamp >= fromTimestamp 的全部消息。
   *
   * “重新生成”和“编辑重发”都建立在这个操作上：两者本质都是“回到某个时刻重来”。
   * 按时间戳而不是消息 id 删除，是因为前端列表本来就以 timestamp 为 key，
   * 两边用同一套坐标系不容易错位。
   *
   * 摘要一致性：若旧摘要已经覆盖了被删的消息（summaryUntil >= fromTimestamp），
   * 摘要里就会残留根本不存在的对话，必须一并作废重新开始。
   */
  async truncateFrom(
    userId: string,
    id: string,
    fromTimestamp: number,
  ): Promise<{ removed: number; summaryReset: boolean }> {
    const conv = await this.owned(userId, id)

    const doomed = await this.msgRepo.find({
      where: {
        conversation: { id },
        timestamp: MoreThanOrEqual(fromTimestamp),
      },
    })
    if (doomed.length) {
      await this.msgRepo.remove(doomed)
    }

    let summaryReset = false
    if (conv.summaryUntil !== null && conv.summaryUntil >= fromTimestamp) {
      conv.contextSummary = null
      conv.summaryUntil = null
      await this.convRepo.save(conv)
      summaryReset = true
    }

    return { removed: doomed.length, summaryReset }
  }

  /**
   * 续传前撤掉上一轮留下的半截回答。
   *
   * 浏览器断连时本服务会走中断分支把已生成部分入库，续传完成后又要写一条完整的，
   * 两条并存就成了「同一句话回答了两遍、后半截那条还短」。
   *
   * 只删末条且必须与续传前缀同源（互为前缀）：半截回答一定排在最后，
   * 而上一轮那条完整回答不可能这次又被当成半截生成出来。
   * 删的动作交给 truncateFrom，摘要越界的作废逻辑也就一并复用了。
   */
  async dropPartialTail(
    userId: string,
    id: string,
    partial: string,
  ): Promise<{ removed: boolean; toolCalls: string | null; model: string | null }> {
    if (!partial) {
      return { removed: false, toolCalls: null, model: null }
    }

    const conv = await this.owned(userId, id, { messages: true })
    const last = [...conv.messages].sort((a, b) => a.timestamp - b.timestamp).pop()
    if (!last || last.role !== 'assistant' || !last.content) {
      return { removed: false, toolCalls: null, model: null }
    }

    const sameTurn =
      partial.startsWith(last.content) || last.content.startsWith(partial)
    if (!sameTurn) {
      return { removed: false, toolCalls: null, model: null }
    }

    const { toolCalls, model } = last
    await this.truncateFrom(userId, id, last.timestamp)
    return { removed: true, toolCalls, model: model ?? null }
  }

  async addMessage(
    userId: string,
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    steps?: Array<{ id: string; name: string; arguments: string; result: string; ok: boolean }>,
    model?: string | null,
  ): Promise<Message> {
    const conv = await this.owned(userId, conversationId)
    const msg = this.msgRepo.create({
      role,
      content,
      // 工具轨迹序列化为 JSON，便于下轮会话还原 OpenAI 协议的 tool_calls 结构
      toolCalls: steps && steps.length ? JSON.stringify(steps) : null,
      model: model ?? null,
      timestamp: Date.now(),
      conversation: conv,
    })
    const saved = await this.msgRepo.save(msg)

    // Auto-update title from first user message
    if (role === 'user') {
      const userMsgs = await this.msgRepo.find({ where: { conversation: { id: conversationId }, role: 'user' } })
      if (userMsgs.length === 1) {
        conv.title = content.slice(0, 24) || '新对话'
        await this.convRepo.save(conv)
      }
    }

    return saved
  }

  /** 把鉴权上线前的无主会话归给指定用户 */
  async claimUnowned(userId: string): Promise<void> {
    await this.convRepo.update({ userId: IsNull() }, { userId })
  }

  /**
   * 归属校验的唯一入口：id 查得到但 userId 不匹配时，一律按 404 处理，
   * 不区分“不存在”和“不是你的”，免得接口变成会话 id 探测工具。
   */
  private async owned(
    userId: string,
    id: string,
    relations?: { messages: boolean },
  ): Promise<Conversation> {
    const conv = await this.convRepo.findOne({ where: { id, userId }, relations })
    if (!conv) {
      throw new NotFoundException('对话不存在')
    }
    return conv
  }
}
