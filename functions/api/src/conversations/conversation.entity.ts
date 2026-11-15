import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm'
import { Message } from './message.entity'

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /**
   * 会话归属用户。鉴权上线前的历史会话为 NULL，由第一个注册账号认领
   * （见 ConversationsService.claimUnowned），否则本地已有记录会在登录后消失。
   */
  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  userId: string | null

  @Column({ default: '新对话' })
  title: string

  /**
   * 滑出上下文窗口的旧轮次归并成的滚动摘要。
   * 存库里而不是每轮重算：否则随着对话变长，每次请求都要重新压一遍，
   * 压缩本身的 token 成本会反超它省下的量。
   */
  @Column('text', { nullable: true })
  contextSummary: string | null

  /**
   * 摘要已覆盖到的消息时间戳（含）。时间戳 <= 该值的消息视为“已在摘要里”，
   * 后续裁剪时可直接跳过，避免同一段对话既在摘要里又在窗口里重复发送。
   */
  @Column({ type: Number, nullable: true })
  summaryUntil: number | null

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date

  @OneToMany(() => Message, (m) => m.conversation, { cascade: true })
  messages: Message[]
}
