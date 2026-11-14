import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Conversation } from './conversation.entity'
import { Message } from './message.entity'

@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly msgRepo: Repository<Message>,
  ) {}

  async findAll(): Promise<Conversation[]> {
    return this.convRepo.find({
      order: { createdAt: 'DESC' },
      relations: { messages: false },
    })
  }

  async findOne(id: string): Promise<Conversation> {
    const conv = await this.convRepo.findOne({
      where: { id },
      relations: { messages: true },
    })
    if (!conv) {
      throw new NotFoundException('对话不存在')
    }
    conv.messages.sort((a, b) => a.timestamp - b.timestamp)
    return conv
  }

  async create(): Promise<Conversation> {
    const conv = this.convRepo.create({ title: '新对话' })
    return this.convRepo.save(conv)
  }

  async updateTitle(id: string, title: string): Promise<Conversation> {
    const conv = await this.convRepo.findOne({ where: { id } })
    if (!conv) {
      throw new NotFoundException('对话不存在')
    }
    conv.title = title
    return this.convRepo.save(conv)
  }

  async remove(id: string): Promise<void> {
    const conv = await this.convRepo.findOne({ where: { id } })
    if (!conv) {
      throw new NotFoundException('对话不存在')
    }
    await this.convRepo.remove(conv)
  }

  async addMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    steps?: Array<{ id: string; name: string; arguments: string; result: string; ok: boolean }>,
  ): Promise<Message> {
    const conv = await this.convRepo.findOne({ where: { id: conversationId } })
    if (!conv) {
      throw new NotFoundException('对话不存在')
    }
    const msg = this.msgRepo.create({
      role,
      content,
      // 工具轨迹序列化为 JSON，便于下轮会话还原 OpenAI 协议的 tool_calls 结构
      toolCalls: steps && steps.length ? JSON.stringify(steps) : null,
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
}
