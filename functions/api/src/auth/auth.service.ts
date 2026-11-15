import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { randomBytes } from 'crypto'
import { User } from './user.entity'
import { Session } from './session.entity'
import { hashPassword, verifyPassword } from './password-hasher'
import type { AuthUser } from './auth.decorators'
import { ConfigService } from '../config/config.service'
import { ConversationsService } from '../conversations/conversations.service'

export interface AuthResult {
  token: string
  user: AuthUser
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 用户名不存在时也拿它跑一次 scrypt：两条分支耗时一致，
 * 攻击者就无法用响应时间枚举出哪些用户名已注册。
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$ZpTCZEIICuZ76yVpO8hTrw==$6+2N18+AyY2WXikfUPjGFCl0iekf4yAaUnDJJnKAcZ4='

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    private readonly config: ConfigService,
    private readonly conversations: ConversationsService,
  ) {}

  async register(username: string, password: string): Promise<AuthResult> {
    const normalized = username.trim().toLowerCase()
    const taken = await this.users.findOne({ where: { username: normalized } })
    if (taken) {
      throw new ConflictException('该用户名已被注册')
    }

    // 认领无主历史数据必须在建号前判断：注册完再查就永远不是第一个了
    const isFirstUser = (await this.users.count()) === 0
    const user = await this.users.save(
      this.users.create({
        username: normalized,
        passwordHash: await hashPassword(password),
      }),
    )

    if (isFirstUser) {
      await Promise.all([
        this.config.claimUnowned(user.id),
        this.conversations.claimUnowned(user.id),
      ])
    }

    return this.startSession(user)
  }

  async login(username: string, password: string): Promise<AuthResult> {
    const user = await this.users.findOne({
      where: { username: username.trim().toLowerCase() },
    })
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH)
    if (!user || !ok) {
      throw new UnauthorizedException('用户名或密码不正确')
    }

    return this.startSession(user)
  }

  async logout(token: string): Promise<void> {
    await this.sessions.delete({ token })
  }

  /** token → 当前用户；已过期就顺手删掉，返回 null 交给守卫统一报 401 */
  async resolve(token: string): Promise<AuthUser | null> {
    const session = await this.sessions.findOne({ where: { token } })
    if (!session) {
      return null
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.sessions.delete({ id: session.id })
      return null
    }

    const user = await this.users.findOne({ where: { id: session.userId } })
    return user ? { id: user.id, username: user.username } : null
  }

  private async startSession(user: User): Promise<AuthResult> {
    const token = randomBytes(32).toString('hex')
    await this.sessions.save(
      this.sessions.create({
        token,
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      }),
    )
    return { token, user: { id: user.id, username: user.username } }
  }
}
