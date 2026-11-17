import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, LessThanOrEqual, Repository } from 'typeorm'
import type { FindOptionsWhere } from 'typeorm'
import { Task } from './task.entity'
import { resolveTaskInvocation } from './task-registry'
import {
  clipText,
  isClaimable,
  isTerminal,
  leaseMs,
  payloadMaxBytes,
  planFailure,
  resultMaxChars,
  claimScanLimit,
} from './task-policy'
import type { TaskStatus } from './task-policy'

/** 列表一次最多返回多少条，避免长任务历史把响应撑大 */
const LIST_LIMIT = 100

export interface EnqueueInput {
  kind: string
  payload: Record<string, unknown>
  conversationId?: string | null
  dedupeKey?: string | null
}

/**
 * 任务队列的两半：
 * - 面向用户的 enqueue / list / find / cancel（鉴权与归属校验都在这里）
 * - 面向执行器的 claimNext / renewLease / report / succeed / fail
 *
 * 执行器是独立进程，与 API 之间**只有这张表和这几个方法**这一层契约。
 * 把它们放在同一个 service 里，是为了让状态机只有一份实现——
 * 否则接口侧允许取消、执行器侧还在写结果，两边各写一套规则迟早漂移。
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name)

  constructor(
    @InjectRepository(Task)
    private readonly repo: Repository<Task>,
  ) {}

  async enqueue(userId: string, input: EnqueueInput): Promise<Task> {
    const payload = input.payload ?? {}
    // 现在就解析一次：接口收下、执行器读不懂的任务只会排队到天荒地老
    const resolved = resolveTaskInvocation({ kind: input.kind, payload })
    if (!resolved.ok) {
      throw new BadRequestException(resolved.error)
    }

    const json = JSON.stringify(payload)
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > payloadMaxBytes()) {
      throw new BadRequestException(
        `任务参数过大（${bytes} 字节，上限 ${payloadMaxBytes()} 字节），请拆成多个任务。`,
      )
    }

    const dedupeKey = input.dedupeKey?.trim() || null
    if (dedupeKey) {
      const existing = await this.repo.findOne({ where: { userId, dedupeKey } })
      if (existing) {
        // 同一个键代表同一个请求：重复提交返回既有任务，而不是再造一个
        return existing
      }
    }

    const task = this.repo.create({
      userId,
      kind: input.kind,
      payload: json,
      conversationId: input.conversationId?.trim() || null,
      dedupeKey,
      status: 'queued' as TaskStatus,
    })

    try {
      return await this.repo.save(task)
    } catch (error) {
      // 并发重复提交会撞 (userId, dedupeKey) 唯一索引，撞了就读回已存在的那条
      if (dedupeKey) {
        const existing = await this.repo.findOne({ where: { userId, dedupeKey } })
        if (existing) {
          return existing
        }
      }
      throw error instanceof Error
        ? new BadRequestException(`任务入队失败：${error.message}`)
        : error
    }
  }

  async list(
    userId: string,
    filter: { status?: TaskStatus; conversationId?: string } = {},
  ): Promise<{ items: Task[]; counts: { queued: number; running: number } }> {
    const where: Record<string, unknown> = { userId }
    if (filter.status) {
      where.status = filter.status
    }
    if (filter.conversationId) {
      where.conversationId = filter.conversationId
    }

    const items = await this.repo.find({
      where: where as FindOptionsWhere<Task>,
      order: { createdAt: 'DESC' },
      take: LIST_LIMIT,
    })
    return { items, counts: await this.stats(userId) }
  }

  async find(userId: string, id: string): Promise<Task> {
    return this.owned(userId, id)
  }

  /**
   * 取消：排队中的任务直接终态，执行中的只打标记。
   *
   * 执行器不看数据库就停不下来，所以 running 的取消是「协作式」的——
   * 它跑完这一轮会在 renewLease / succeed / fail 的归属校验上失败，
   * 结果被丢弃，任务保持 canceled。
   */
  async cancel(userId: string, id: string): Promise<Task> {
    const task = await this.owned(userId, id)
    if (isTerminal(task.status)) {
      throw new BadRequestException(`任务已经是「${task.status}」终态，无法取消。`)
    }

    task.status = 'canceled'
    task.leaseUntil = null
    task.finishedAt = Date.now()
    task.error = task.error ?? '用户已取消'
    return this.repo.save(task)
  }

  /** 队列水位，供健康检查与前端提示「积压但没人执行」 */
  async stats(userId?: string): Promise<{ queued: number; running: number }> {
    const where = userId ? { userId } : {}
    const [queued, running] = await Promise.all([
      this.repo.count({ where: { ...where, status: 'queued' } as FindOptionsWhere<Task> }),
      this.repo.count({ where: { ...where, status: 'running' } as FindOptionsWhere<Task> }),
    ])
    return { queued, running }
  }

  // ------------------------------------------------------------------ 执行器契约

  /**
   * 原子领取下一条可执行任务，没有则返回 null。
   *
   * 为什么不用 `SELECT ... FOR UPDATE SKIP LOCKED`：那是 PostgreSQL 专属语法，
   * 本地 sqljs 直接报错，而这套代码要同时跑在本机演示和云端 Postgres 上。
   * 改成「读候选 + 按领取条件 CAS 更新」，靠 affected 行数判断有没有抢到，
   * 两个驱动都能用；候选只有 claimScanLimit 条，撞车的概率低，撞了就换下一条。
   */
  async claimNext(runnerId: string): Promise<Task | null> {
    const now = Date.now()
    const candidates = await this.repo.find({
      where: [
        { status: 'queued' },
        { status: 'running' },
      ] as FindOptionsWhere<Task>[],
      order: { createdAt: 'ASC' },
      take: claimScanLimit(),
    })

    for (const candidate of candidates) {
      // 可领取性只由 isClaimable 这一处判定，SQL 里的条件是它的预筛
      if (!isClaimable(candidate, now)) {
        continue
      }

      const updated = await this.repo.update(claimCriteria(candidate.id, now), {
        status: 'running',
        runnerId,
        leaseUntil: now + leaseMs(),
        startedAt: now,
        attempts: candidate.attempts + 1,
        notBefore: null,
        updatedAt: new Date(),
      })
      if (!updated.affected) {
        // 别的执行器先一步抢走（或状态已变），继续看下一条
        continue
      }

      const claimed = await this.repo.findOne({ where: { id: candidate.id } })
      return claimed ?? null
    }
    return null
  }

  /** 续租：返回 false 表示任务已不再属于这个执行器（被抢占或已取消），应当停手 */
  async renewLease(id: string, runnerId: string): Promise<boolean> {
    const updated = await this.repo.update(
      { id, runnerId, status: 'running' },
      { leaseUntil: Date.now() + leaseMs(), updatedAt: new Date() },
    )
    return (updated.affected ?? 0) === 1
  }

  /** 执行器是否应当放弃当前任务（用户取消走的是状态，不是信号） */
  async isCanceled(id: string): Promise<boolean> {
    const task = await this.repo.findOne({ where: { id } })
    return !!task && task.status === 'canceled'
  }

  async report(id: string, runnerId: string, progress: number): Promise<boolean> {
    const updated = await this.repo.update(
      { id, runnerId, status: 'running' },
      {
        progress: Math.max(0, Math.min(100, Math.round(progress))),
        updatedAt: new Date(),
      },
    )
    return (updated.affected ?? 0) === 1
  }

  async succeed(id: string, runnerId: string, result: string): Promise<boolean> {
    const updated = await this.repo.update({ id, runnerId, status: 'running' }, {
      status: 'succeeded',
      result: clipText(result ?? '', resultMaxChars()),
      error: null,
      progress: 100,
      leaseUntil: null,
      finishedAt: Date.now(),
      updatedAt: new Date(),
    })
    if (!updated.affected) {
      this.logger.warn(`任务 ${id} 的结果被丢弃：已取消或已被其它执行器接管`)
    }
    return (updated.affected ?? 0) === 1
  }

  /**
   * 失败收口。retryable 且未超次数上限时退回 queued 并写退避时刻，
   * 否则进入 failed 终态——重试判定全部走 planFailure，执行器不需要自己数次数。
   */
  async fail(
    id: string,
    runnerId: string,
    error: string,
    options: { retryable?: boolean } = {},
  ): Promise<boolean> {
    const task = await this.repo.findOne({ where: { id, runnerId, status: 'running' } })
    if (!task) {
      return false
    }

    const plan = planFailure(task, error, options)
    const updated = await this.repo.update({ id, runnerId, status: 'running' }, {
      status: plan.status,
      error: plan.error,
      notBefore: plan.notBefore,
      leaseUntil: null,
      finishedAt: isTerminal(plan.status) ? Date.now() : null,
      progress: isTerminal(plan.status) ? task.progress : 0,
      updatedAt: new Date(),
    })
    return (updated.affected ?? 0) === 1
  }

  /** 归属校验：查得到 id 但不是你的，一律按不存在处理，接口不能变成任务 id 探测工具 */
  private async owned(userId: string, id: string): Promise<Task> {
    const task = await this.repo.findOne({ where: { id, userId } })
    if (!task) {
      throw new NotFoundException('任务不存在')
    }
    return task
  }
}

/**
 * 领取条件的数据库表达，与 isClaimable 等价：
 * 排队或租约已过期的执行中，且已过退避时刻。
 * 数组在 TypeORM 里是 OR，因此展开成「状态 × 退避门」的组合。
 */
function claimCriteria(id: string, now: number): FindOptionsWhere<Task>[] {
  const states: FindOptionsWhere<Task>[] = [
    { status: 'queued' },
    { status: 'running', leaseUntil: LessThanOrEqual(now) },
  ]
  const gates: FindOptionsWhere<Task>[] = [
    { notBefore: IsNull() },
    { notBefore: LessThanOrEqual(now) },
  ]
  return states.flatMap((state) => gates.map((gate) => ({ id, ...state, ...gate })))
}
