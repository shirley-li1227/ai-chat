import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import type { TaskStatus } from './task-policy'

/**
 * 一次「提交后异步执行」的工作单元。
 *
 * 表设计的关键约束：
 * - 时间戳一律用毫秒 bigint 而不是 datetime，与 Message.timestamp 保持同一套坐标系，
 *   前端排序与租约判定都不用再处理时区。
 * - `runnerId` + `leaseUntil` 是执行器的存活证明：实例被回收或进程崩掉时，
 *   任务不会永远卡在 running，租约到期后别的执行器可以重新领走。
 * - `notBefore` 承载重试退避，`attempts` 承载次数上限，两者共同决定可领取性。
 * - 列类型只选 sqljs 与 PostgreSQL 都支持的写法，切库不用改实体。
 */
@Entity('tasks')
@Index(['userId', 'createdAt'])
@Index(['userId', 'dedupeKey'], { unique: true })
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /** 归属账号，所有读写都以它过滤；越权访问统一按 404 处理 */
  @Column({ type: 'varchar', length: 36 })
  userId: string

  /** 从哪次对话提交的任务，可空：任务面板允许脱离会话直接提交 */
  @Column({ type: 'varchar', length: 36, nullable: true })
  conversationId: string | null

  /** 任务类型，决定执行器怎么跑，取值见 task-registry.ts */
  @Column({ type: 'varchar', length: 64 })
  kind: string

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status: TaskStatus

  /** 类型相关的入参，序列化为 JSON 文本；执行前会按 kind 的声明校验 */
  @Column('text')
  payload: string

  /** 成功后的输出文本，按 resultMaxChars 截断 */
  @Column('text', { nullable: true })
  result: string | null

  /** 失败原因；重试中的任务也会留着上一次的原因，便于排查 */
  @Column('text', { nullable: true })
  error: string | null

  /** 0–100，由执行器上报；单个工具调用这类任务可以不报 */
  @Column({ type: 'int', default: 0 })
  progress: number

  /** 已尝试次数，领取时自增；达到 TASK_MAX_ATTEMPTS 后不再重投 */
  @Column({ type: 'int', default: 0 })
  attempts: number

  /** 提交时的去重键：同账号重复提交（例如前端重连后重发）返回同一条任务 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  dedupeKey: string | null

  /** 当前持有该任务的执行器标识，写回结果时据此判断是否还被自己占着 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  runnerId: string | null

  /** 租约到期时刻（毫秒）。过期即可被别的执行器抢占 */
  @Column({ type: Number, nullable: true })
  leaseUntil: number | null

  /** 不早于此时刻领取，用于重试退避 */
  @Column({ type: Number, nullable: true })
  notBefore: number | null

  @Column({ type: Number, nullable: true })
  startedAt: number | null

  @Column({ type: Number, nullable: true })
  finishedAt: number | null

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}
