import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm'
import { Message } from './message.entity'

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ default: '新对话' })
  title: string

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date

  @OneToMany(() => Message, (m) => m.conversation, { cascade: true })
  messages: Message[]
}
