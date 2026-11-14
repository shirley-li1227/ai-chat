import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm'

@Entity('api_config')
export class ApiConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ default: 'deepseek' })
  provider: string

  /**
   * 大模型 API Key。配置了 ENCRYPTION_KEY 时存 AES-256-GCM 密文，
   * 长度大于明文，预留 512 位容纳 iv/tag/密文前缀。
   */
  @Column({ length: 512 })
  apiKey: string

  @Column()
  baseUrl: string

  @Column()
  model: string

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}
