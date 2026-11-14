import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ApiConfigEntity } from './api-config.entity'
import { SecretCipher } from '../security/secret-cipher'

export interface PlainApiConfig {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
}

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name)

  constructor(
    @InjectRepository(ApiConfigEntity)
    private readonly repo: Repository<ApiConfigEntity>,
    private readonly cipher: SecretCipher,
  ) {
    // 主密钥无效不阻塞启动，只告知当前处于“无法保存也无法复用已存 Key”的状态
    if (!this.cipher.enabled) {
      this.logger.warn(
        `${this.cipher.disableReason}，API Key 加密已停用。` +
          '保存配置与发起对话将返回错误，直到配好有效主密钥。',
      )
    }
  }

  /** 返回解密后的配置，供 ChatService 直接调用上游使用 */
  async get(): Promise<PlainApiConfig | null> {
    const entity = await this.latest()
    if (!entity) {
      return null
    }

    const plainConfig: PlainApiConfig = {
      provider: entity.provider,
      apiKey: entity.apiKey,
      baseUrl: entity.baseUrl,
      model: entity.model,
    }

    // 历史明文记录：能加密就立即加密回写完成一次性迁移；
    // 主密钥缺失时只读不改，不把明文再写一遍，也不阻断已有会话。
    if (!this.cipher.isEncrypted(entity.apiKey)) {
      if (this.cipher.enabled) {
        await this.save(plainConfig)
        this.logger.warn('检测到明文历史配置，已自动加密回写')
      } else {
        this.logger.warn('检测到明文历史配置，但主密钥不可用，本次不迁移')
      }
      return plainConfig
    }

    // 库里是密文却解不开（主密钥缺失或填错），给出可操作的提示而非 500
    if (!this.cipher.enabled) {
      throw new ServiceUnavailableException(
        `${this.cipher.disableReason}，无法解密已保存的 API Key。` +
          '请在 functions/api/.env 配置正确的 ENCRYPTION_KEY 后重启后端。',
      )
    }

    return {
      ...plainConfig,
      apiKey: this.cipher.decrypt(entity.apiKey),
    }
  }

  /**
   * 取最近一条配置。单行表用 findOne 必须带 where，
   * 这里改用 find + take:1 避开该限制。
   */
  private async latest(): Promise<ApiConfigEntity | null> {
    const items = await this.repo.find({
      order: { updatedAt: 'DESC' },
      take: 1,
    })
    return items[0] ?? null
  }

  /** 落库前加密；主密钥不可用则直接拒绝，任何情况下都不会写入明文 */
  async save(data: PlainApiConfig): Promise<ApiConfigEntity> {
    if (!this.cipher.enabled) {
      throw new BadRequestException(
        `${this.cipher.disableReason}，为防止 API Key 明文落库已拒绝保存。` +
          '请在 functions/api/.env 配置主密钥后重启后端，生成命令：' +
          `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      )
    }

    const payload = {
      provider: data.provider,
      apiKey: this.cipher.encrypt(data.apiKey),
      baseUrl: data.baseUrl,
      model: data.model,
    }
    const existing = await this.latest()
    if (existing) {
      Object.assign(existing, payload)
      return this.repo.save(existing)
    }
    const entity = this.repo.create(payload)
    return this.repo.save(entity)
  }

  async clear(): Promise<void> {
    await this.repo.clear()
  }
}
