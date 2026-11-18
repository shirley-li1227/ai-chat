import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import type { MemorySource } from './memory-policy'

/**
 * 关于某个账号的长期事实，跨会话生效。
 *
 * 表设计的关键约束：
 * - 归属只到 userId，不到 conversationId：`conversationId` 仅记录「在哪次对话里记下的」，
 *   用于界面上说明来处，检索与注入一律按账号。
 * - `fingerprint` 是归一化正文的 sha256，配 (userId, fingerprint) 唯一索引：
 *   同一句话被模型重复记录时靠它挡住，界面里也就不会出现两条一模一样的记忆。
 * - 列类型只选 sqljs 与 PostgreSQL 都支持的写法，切库不用改实体。
 *
 * 生产 Postgres 的 synchronize 默认关闭且没有迁移目录，建这张表要手动跑 DDL，
 * 语句见 README「生产库结构变更」。
 */
@Entity('user_memories')
@Index(['userId', 'updatedAt'])
@Index(['userId', 'fingerprint'], { unique: true })
export class UserMemory {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /** 归属账号：所有读写都以它过滤，越权访问统一按 404 处理 */
  @Column({ type: 'varchar', length: 36 })
  userId: string

  /** 记忆正文，单条长度由 MEMORY_ITEM_MAX_CHARS 在服务层拦下 */
  @Column('text')
  content: string

  /** 去重指纹：归一化并转小写后的 sha256，64 位十六进制 */
  @Column({ type: 'varchar', length: 64 })
  fingerprint: string

  /** 联合类型列必须显式写 type，否则启动即报 DataTypeNotSupportedError */
  @Column({ type: 'varchar', length: 16, default: 'model' })
  source: MemorySource

  /** 在哪次对话里记下的，可为空：面板里手写的那批没有来处 */
  @Column({ type: 'varchar', length: 36, nullable: true })
  conversationId: string | null

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}
