import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /**
   * 登录名统一小写存储，唯一性由库层约束保证；
   * 大小写不敏感可避免「Alice / alice」两个账号互相顶号。
   */
  @Index({ unique: true })
  @Column({ length: 32 })
  username: string

  /** scrypt$N$r$p$salt$hash，见 password-hasher.ts；绝不存明文 */
  @Column({ length: 256 })
  passwordHash: string

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}
