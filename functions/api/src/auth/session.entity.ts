import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm'

/**
 * 会话即「服务端可撤销的 Bearer token」：token 随机生成、库里存明文，
 * 退出登录或删除账号时随行删除，比 JWT 更容易立刻失效，也不需要额外签名密钥。
 */
@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Index({ unique: true })
  @Column({ length: 64 })
  token: string

  /**
   * 归属用户。这里用 varchar 而非 uuid + 外键：本地 sqljs 与生产 Postgres 的
   * 主键类型不同，跨方言的库层外键要靠关系装饰器才能自动对齐，
   * 而归属过滤本来就在应用层按 userId 做，不依赖外键兜底。
   */
  @Index()
  @Column({ type: 'varchar', length: 36 })
  userId: string

  @Column()
  expiresAt: Date

  @CreateDateColumn()
  createdAt: Date
}
