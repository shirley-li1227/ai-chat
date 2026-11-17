import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm'
import { Conversation } from './conversation.entity'

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  role: 'user' | 'assistant'

  @Column('text')
  content: string

  /**
   * Agent 工具调用轨迹（JSON 字符串），仅 assistant 消息可能有值。
   * 同时用于多轮会话还原完整的 tool_calls 上下文和前端展示执行步骤。
   */
  @Column('text', { nullable: true })
  toolCalls: string | null

  /**
   * 本轮实际使用的模型。模型路由后它不再等于配置里的主力模型，
   * 续传要靠这个字段接着同一个模型往下写，界面也靠它说明「刚才是谁在答」。
   */
  @Column('varchar', { length: 128, nullable: true })
  model: string | null

  @Column()
  timestamp: number

  @ManyToOne(() => Conversation, (c) => c.messages, { onDelete: 'CASCADE' })
  conversation: Conversation
}
