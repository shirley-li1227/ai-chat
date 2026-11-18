import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { DataSource, IsNull, Repository } from 'typeorm'
import { ApiConfigEntity } from './api-config.entity'
import { SecretCipher } from '../security/secret-cipher'
import { normalizeBaseUrl, parseCandidates, providerSpec, requireProvider } from './providers'

export interface PlainApiConfig {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  /** 这一家的档位候选（从低到高）；null 表示没填，路由器退回环境变量 */
  routingCandidates: string | null
}

/** 对外可见的配置视图：只带掩码，永远不带明文 Key */
export interface ConfigView {
  provider: string
  label: string
  baseUrl: string
  model: string
  apiKeyMasked: string
  active: boolean
  routingCandidates: string | null
  updatedAt: number
}

export interface SaveConfigInput {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  routingCandidates?: string | null
}

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name)

  constructor(
    @InjectRepository(ApiConfigEntity)
    private readonly repo: Repository<ApiConfigEntity>,
    private readonly cipher: SecretCipher,
    private readonly dataSource: DataSource,
  ) {
    // 主密钥无效不阻塞启动，只告知当前处于“无法保存也无法复用已存 Key”的状态
    if (!this.cipher.enabled) {
      this.logger.warn(
        `${this.cipher.disableReason}，API Key 加密已停用。` +
          '保存配置与发起对话将返回错误，直到配好有效主密钥。',
      )
    }
  }

  /** 返回生效那份配置的解密结果，供 ChatService 直接调用上游使用 */
  async get(userId: string): Promise<PlainApiConfig | null> {
    const row = await this.effective(userId)
    if (!row) {
      return null
    }

    // 库里是密文却解不开（主密钥缺失或填错），给出可操作的提示而非 500
    if (this.cipher.isEncrypted(row.apiKey) && !this.cipher.enabled) {
      throw new ServiceUnavailableException(
        `${this.cipher.disableReason}，无法解密已保存的 API Key。` +
          '请在 functions/api/.env 配置正确的 ENCRYPTION_KEY 后重启后端。',
      )
    }

    if (!this.cipher.isEncrypted(row.apiKey)) {
      // 历史明文记录：能加密就立即就地加密，主密钥缺失时只读不改，不把明文再写一遍
      if (this.cipher.enabled) {
        const encrypted = this.cipher.encrypt(row.apiKey)
        await this.repo.update({ id: row.id }, { apiKey: encrypted })
        row.apiKey = encrypted
        this.logger.warn(`检测到明文历史配置（${row.provider}），已自动加密回写`)
      } else {
        this.logger.warn('检测到明文历史配置，但主密钥不可用，本次不迁移')
      }
    }

    return this.toPlain(row)
  }

  /** 每家一行，生效那份排最前 */
  async listViews(userId: string): Promise<ConfigView[]> {
    const rows = await this.rows(userId)
    const activeId = rows.find((row) => row.active)?.id ?? rows[0]?.id
    return rows
      .filter((row) => providerSpec(row.provider))
      .sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
      .map((row) => ({
        provider: row.provider,
        label: providerSpec(row.provider)?.label ?? row.provider,
        baseUrl: row.baseUrl,
        model: row.model,
        apiKeyMasked: this.mask(this.decryptForView(row)),
        active: row.id === activeId,
        routingCandidates: row.routingCandidates,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
      }))
  }

  async save(userId: string, data: SaveConfigInput, apply = true): Promise<ConfigView> {
    if (!this.cipher.enabled) {
      throw new BadRequestException(
        `${this.cipher.disableReason}，为防止 API Key 明文落库已拒绝保存。` +
          '请在 functions/api/.env 配置主密钥后重启后端，生成命令：' +
          `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      )
    }

    const spec = requireProvider(data.provider)
    const providedKey = (data.apiKey ?? '').trim()
    const payload = {
      provider: spec.id,
      // 留空或回传界面显示的掩码串都表示「这次不改 Key」：加密后的空串/掩码会让上游 401，
      // 而用户看到的只是「答不上来」，归因成本远高于保存时拦下来
      apiKey:
        !providedKey || this.isMask(providedKey) ? null : this.cipher.encrypt(providedKey),
      baseUrl: normalizeBaseUrl(data.baseUrl),
      model: data.model.trim(),
      routingCandidates: this.normalizeCandidates(data.routingCandidates),
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ApiConfigEntity)
      const existing = await repo.findOne({ where: { userId, provider: spec.id } })
      const row = existing ?? repo.create({ userId, provider: spec.id, apiKey: '', active: false })
      Object.assign(row, {
        baseUrl: payload.baseUrl,
        model: payload.model,
        routingCandidates: payload.routingCandidates,
      })
      if (payload.apiKey) {
        row.apiKey = payload.apiKey
      }
      if (!payload.apiKey && !existing) {
        throw new BadRequestException('首次保存该供应商的配置必须带上完整的 API Key')
      }

      const isFirstRow = (await repo.count({ where: { userId } })) === 0
      if (apply || isFirstRow) {
        await repo.update({ userId }, { active: false })
        row.active = true
      }
      return repo.save(row)
    })

    return this.viewOf(saved)
  }

  /** 切换生效那份：只翻指针，不动任何 Key */
  async activate(userId: string, provider: string): Promise<ConfigView> {
    const row = await this.repo.findOne({ where: { userId, provider } })
    if (!row) {
      throw new NotFoundException(`还没有保存过 ${this.labelOf(provider)} 的配置，先填一次 Key 再切换`)
    }
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ApiConfigEntity)
      await repo.update({ userId }, { active: false })
      await repo.update({ id: row.id }, { active: true })
    })
    return this.viewOf(row)
  }

  /**
   * 删掉某一家。删的正好是生效那份时，把剩下最近更新的那份顶上来：
   * 读路径本来就会退回最近一条，但列表会显示成「没有生效项」，口径不如提前定好。
   */
  async remove(userId: string, provider: string): Promise<void> {
    const row = await this.repo.findOne({ where: { userId, provider } })
    if (!row) {
      throw new NotFoundException(`还没有保存过 ${this.labelOf(provider)} 的配置`)
    }
    await this.repo.delete({ id: row.id })
    if (!row.active) {
      return
    }
    const next = (await this.rows(userId))[0]
    if (next) {
      await this.repo.update({ id: next.id }, { active: true })
    }
  }

  async clear(userId: string): Promise<void> {
    await this.repo.delete({ userId })
  }

  /**
   * 把鉴权上线前的无主配置归给指定用户。
   * 复合唯一索引在这里会咬人：无主行和用户已有的同供应商行不能并存，
   * 所以冲突的那条直接丢掉（它属于「同一家被填了两次」，留下用户自己那份）。
   */
  async claimUnowned(userId: string): Promise<void> {
    const orphans = await this.repo.find({ where: { userId: IsNull() } })
    for (const orphan of orphans) {
      const mine = await this.repo.findOne({ where: { userId, provider: orphan.provider } })
      if (mine) {
        await this.repo.delete({ id: orphan.id })
        continue
      }
      await this.repo.update({ id: orphan.id }, { userId })
    }
  }

  private async rows(userId: string): Promise<ApiConfigEntity[]> {
    return this.repo.find({ where: { userId }, order: { updatedAt: 'DESC' } })
  }

  /**
   * 生效那份 = 标了 active 的行；一条都没标就是改动之前的存量数据，退回最近一条。
   * 存量迁移因此不是上线前置条件。
   */
  private async effective(userId: string): Promise<ApiConfigEntity | null> {
    const rows = await this.rows(userId)
    return rows.find((row) => row.active) ?? rows[0] ?? null
  }

  private toPlain(row: ApiConfigEntity): PlainApiConfig {
    return {
      provider: row.provider,
      apiKey: this.cipher.isEncrypted(row.apiKey) && this.cipher.enabled
        ? this.cipher.decrypt(row.apiKey)
        : row.apiKey,
      baseUrl: row.baseUrl,
      model: row.model,
      routingCandidates: row.routingCandidates,
    }
  }

  private decryptForView(row: ApiConfigEntity): string {
    if (!this.cipher.isEncrypted(row.apiKey)) {
      return row.apiKey
    }
    // 主密钥不可用时列表仍要打得开，只是看不到尾 4 位；对话路径会在 get() 里报明确错误
    return this.cipher.enabled ? this.cipher.decrypt(row.apiKey) : ''
  }

  private async viewOf(row: ApiConfigEntity): Promise<ConfigView> {
    return {
      provider: row.provider,
      label: this.labelOf(row.provider),
      baseUrl: row.baseUrl,
      model: row.model,
      apiKeyMasked: this.mask(this.decryptForView(row)),
      active: row.active,
      routingCandidates: row.routingCandidates,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Date.now(),
    }
  }

  private mask(plainKey: string): string {
    return plainKey ? `${plainKey.slice(0, 4)}****${plainKey.slice(-4)}` : '****'
  }

  private isMask(value: string): boolean {
    return /^\S{4}\*{4}\S{4}$/.test(value.trim())
  }

  private normalizeCandidates(raw: string | null | undefined): string | null {
    const items = parseCandidates(raw)
    return items.length ? items.join(',') : null
  }

  private labelOf(provider: string): string {
    return providerSpec(provider)?.label ?? provider
  }
}
