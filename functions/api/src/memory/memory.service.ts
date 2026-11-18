import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'
import { UserMemory } from './memory.entity'
import {
  memoryEnabled,
  memoryFingerprint,
  memoryHandle,
  memoryInjectMaxChars,
  memoryItemMaxChars,
  memoryMaxEntries,
  normalizeMemoryContent,
  renderMemoryPrompt,
  resolveMemoryHandle,
  selectForInjection,
  type MemoryItem,
  type MemorySource,
} from './memory-policy'

export interface MemoryWriteResult {
  ok: boolean
  /** 回给模型的中文说明：成功就说清记成了什么，失败就说清下一步怎么改 */
  message: string
  item?: MemoryItem
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name)

  constructor(
    @InjectRepository(UserMemory)
    private readonly repo: Repository<UserMemory>,
  ) {}

  /**
   * 该身份的全部记忆，新→旧。
   *
   * 不加 take：条数上限由 trimToLimit 在每次写入后保证，读取再截一刀的话，
   * 超出的那部分就永远看不见、也永远淘汰不掉。
   *
   * 读失败一律退化成「没有记忆」而不是抛错：生产 Postgres 的 synchronize 是关掉的，
   * 建表 DDL 还没跑时这里会直接报错，而长期记忆只是锦上添花，
   * 不该把一次对话钉在缺表的运维步骤上。缺表由 /api/health 与日志暴露，不靠对话兜底。
   */
  async list(userId: string): Promise<MemoryItem[]> {
    try {
      const rows = await this.repo.find({
        where: { userId },
        order: { updatedAt: 'DESC' },
      })
      return rows.map(toItem)
    } catch (error) {
      this.logger.warn(
        `长期记忆读取失败，本轮按无记忆处理：${(error as Error).message}`,
      )
      return []
    }
  }

  /** 注入 system 的那段文本；关闭开关或没有记忆时返回 null，请求层据此决定是否多插一条 system */
  async renderForPrompt(userId: string): Promise<string | null> {
    if (!memoryEnabled()) {
      return null
    }
    const items = await this.list(userId)
    if (!items.length) {
      return null
    }
    return renderMemoryPrompt(selectForInjection(items, memoryInjectMaxChars()))
  }

  /**
   * 记一条。空与超长在服务层拦，而不是交给模型猜：
   * 数据库对 text 长度不设限，真让它写进去就会有一条几千字的任务日志长期跟着这个账号。
   */
  async remember(
    userId: string,
    raw: string,
    source: MemorySource = 'model',
    conversationId?: string,
  ): Promise<MemoryWriteResult> {
    if (!memoryEnabled()) {
      return {
        ok: false,
        message: '长期记忆功能已关闭（MEMORY_ENABLED=false），本轮请照常回答。',
      }
    }

    const content = normalizeMemoryContent(raw)
    if (!content) {
      return { ok: false, message: '记忆内容不能为空，请给出一句话的事实或偏好。' }
    }

    const limit = memoryItemMaxChars()
    if (content.length > limit) {
      return {
        ok: false,
        message:
          `单条记忆上限 ${limit} 字，这条 ${content.length} 字。` +
          '请只保留会长期影响回答的那一句，任务细节不必记录。',
      }
    }

    const fingerprint = memoryFingerprint(content)
    const existing = await this.repo.findOne({ where: { userId, fingerprint } })
    if (existing) {
      const touched = await this.repo.save(existing)
      return {
        ok: true,
        message: `这条早已记过（编号 ${memoryHandle(existing.id)}），已刷新它的时间，不必重复记录。`,
        item: toItem(touched),
      }
    }

    const entity = this.repo.create({
      userId,
      content,
      fingerprint,
      source,
      conversationId: conversationId ?? null,
    })

    let saved: UserMemory
    try {
      saved = await this.repo.save(entity)
    } catch (error) {
      return this.writeFailure(error, content)
    }

    await this.trimToLimit(userId)
    return {
      ok: true,
      message: `已记住（编号 ${memoryHandle(saved.id)}）：${saved.content}`,
      item: toItem(saved),
    }
  }

  /** 按编号忘掉一条，编号可以是模型抄下来的前缀 */
  async forget(userId: string, rawHandle: string): Promise<MemoryWriteResult> {
    if (!memoryEnabled()) {
      return {
        ok: false,
        message: '长期记忆功能已关闭（MEMORY_ENABLED=false），本轮请照常回答。',
      }
    }

    const items = await this.list(userId)
    const match = resolveMemoryHandle(items, rawHandle)
    if (!match.ok) {
      if (match.reason === 'ambiguous') {
        return {
          ok: false,
          message: `编号「${rawHandle}」同时匹配 ${match.candidates.join('、')}，请用完整编号重试。`,
        }
      }
      const handles = items.map((item) => memoryHandle(item.id))
      return {
        ok: false,
        message:
          `没有编号「${rawHandle}」的记忆。` +
          `当前可用编号：${handles.length ? handles.join('、') : '（还没有记住任何内容）'}。`,
      }
    }

    await this.repo.delete({ id: match.id, userId })
    const removed = items.find((item) => item.id === match.id)
    return {
      ok: true,
      message: `已忘掉：${removed?.content ?? rawHandle}`,
    }
  }

  /** 界面手动新增：与模型写的走同一套校验，只是来源标成 user */
  async createByUser(
    userId: string,
    raw: string,
  ): Promise<MemoryWriteResult> {
    return this.remember(userId, raw, 'user')
  }

  /** 界面删除：不存在或不是这个账号的都按 404，免得接口变成记忆 id 探测工具 */
  async remove(userId: string, id: string): Promise<void> {
    const found = await this.repo.findOne({ where: { id, userId } })
    if (!found) {
      throw new NotFoundException('记忆不存在')
    }
    await this.repo.remove(found)
  }

  /** 面板与评测都要看的实时水位 */
  snapshot() {
    return {
      enabled: memoryEnabled(),
      maxEntries: memoryMaxEntries(),
      itemMaxChars: memoryItemMaxChars(),
      injectMaxChars: memoryInjectMaxChars(),
    }
  }

  /**
   * 超出条数上限时淘汰最久没动过的。
   *
   * 淘汰而不是拒绝写入：用户刚说的一条新偏好，重要性高于半年前记下的那条旧习惯，
   * 让写入失败只会换来模型反复重试，配额照样花掉了。
   */
  private async trimToLimit(userId: string): Promise<void> {
    const items = await this.list(userId)
    const overflow = items.length - memoryMaxEntries()
    if (overflow <= 0) {
      return
    }
    const doomed = items.slice(items.length - overflow).map((item) => item.id)
    await this.repo.delete({ id: In(doomed), userId })
  }

  /**
   * 写入异常分两类：唯一索引撞车说明并发下另一个实例已经记了同一句话，那是成功；
   * 其余（例如生产库还没建表）如实回给模型，别让它以为记好了。
   */
  private writeFailure(error: unknown, content: string): MemoryWriteResult {
    const message = (error as Error).message ?? String(error)
    if (/unique|duplicate/i.test(message)) {
      return {
        ok: true,
        message: `这条早已记过：${content}，不必重复记录。`,
      }
    }
    this.logger.error(`长期记忆写入失败：${message}`)
    return {
      ok: false,
      message:
        `长期记忆暂时无法写入（${message.slice(0, 120)}），本轮请照常回答，` +
        '并告知用户这条没能保存。',
    }
  }
}

function toItem(row: UserMemory): MemoryItem {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    updatedAt: row.updatedAt ? row.updatedAt.getTime() : Date.now(),
  }
}
