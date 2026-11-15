import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm'

@Entity('api_config')
export class ApiConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /**
   * 配置归属的用户。鉴权上线前这张表是单租户的，历史行为 NULL，
   * 由第一个注册账号认领（见 ConfigService.claimUnowned）。
   */
  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  userId: string | null

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
