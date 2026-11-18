import { Entity, Index, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm'

@Entity('api_config')
// 一个账号在每家供应商上最多一份配置；切家只是换「哪份生效」，不是覆盖上一份的 Key
@Index(['userId', 'provider'], { unique: true })
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

  /**
   * 该份配置是否生效。一个账号同时只有一份生效，由 ConfigService 在一个事务里
   * 「先全置 false 再置目标为 true」保证：库里一条都没有时读路径退回最近一条，
   * 于是改动之前的存量行不用迁移也照样能用。
   * 不在库上加部分唯一索引：SQLite 写 `= 1`、Postgres 写 `= true`，
   * 一条装饰器没法同时喂两种方言，为一个布尔值引入方言分支不值。
   */
  @Column({ type: 'boolean', default: false })
  active: boolean

  /**
   * 该家的模型档位候选，从低到高逗号分隔。
   * 放在配置行而不是环境变量：候选名属于供应商，`deepseek-v4-pro` 发给智谱网关只会拿 4xx，
   * 而全局变量分不出「这几档是谁家的」。留空则退回 MODEL_ROUTING_CANDIDATES（存量部署的行为）。
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  routingCandidates: string | null

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}
