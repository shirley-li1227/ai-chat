import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

const ALGO = 'aes-256-gcm'
const PREFIX = 'gcm1:'

/**
 * API Key 静态加密。密文格式：gcm1:<iv-hex>:<tag-hex>:<cipher-base64>
 *
 * 主密钥缺失或非法时不在构造阶段抛错，以免阻塞后端启动；
 * 改为记录原因并在真正需要加解密时抛出，由调用方转成接口错误。
 * 关键点：任何情况下都不会退化成明文落库。
 */
export class SecretCipher {
  private readonly key: Buffer | null

  /** 加密不可用的原因；为 null 表示主密钥有效、加密可用 */
  readonly disableReason: string | null

  constructor(rawKey: string | undefined) {
    const normalized = (rawKey ?? '').trim()

    if (!normalized) {
      this.key = null
      this.disableReason = '未配置 ENCRYPTION_KEY'
    } else if (!/^[0-9a-f]{64}$/i.test(normalized)) {
      this.key = null
      this.disableReason =
        'ENCRYPTION_KEY 格式非法，必须是 64 位十六进制字符串（32 字节）'
    } else {
      this.key = Buffer.from(normalized, 'hex')
      this.disableReason = null
    }
  }

  get enabled(): boolean {
    return this.key !== null
  }

  /**
   * 惰性取密钥：主密钥无效时在这里抛错，而不是在启动时崩溃。
   * 错误信息带上修复动作，前端可直接展示给用户。
   */
  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error(
        `${this.disableReason}。为防止 API Key 明文落库，已拒绝本次操作。` +
          `请在 functions/api/.env 配置主密钥后重启后端，生成命令：` +
          `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      )
    }
    return this.key
  }

  encrypt(plain: string): string {
    const key = this.requireKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGO, key, iv)
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('base64')}`
  }

  /** 判断库中存的是密文还是待迁移的历史明文 */
  isEncrypted(stored: string): boolean {
    return stored.startsWith(PREFIX)
  }

  decrypt(stored: string): string {
    if (!this.isEncrypted(stored)) {
      // 正常流程不会走到这里：ConfigService 读取时会先完成加密迁移
      throw new Error('检测到未加密的 API Key 记录，加密迁移未完成')
    }

    const key = this.requireKey()
    const [ivHex, tagHex, data] = stored.slice(PREFIX.length).split(':')
    if (!ivHex || !tagHex || !data) {
      throw new Error('密文格式损坏，无法解密')
    }

    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }
}
