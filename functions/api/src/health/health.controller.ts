import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { SecretCipher } from '../security/secret-cipher'
import { PROMPT_VERSION } from '../chat/prompt'
import { Public } from '../auth/auth.decorators'

@Controller('api/health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cipher: SecretCipher,
  ) {}

  /**
   * 供容器 HEALTHCHECK 与负载均衡探活。
   * 数据库不可用时返回 503，使编排层能识别为不健康并重启/摘流。
   */
  @Public()
  @Get()
  async check() {
    try {
      await this.dataSource.query('SELECT 1')
    } catch (error) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'down',
        reason: (error as Error).message,
      })
    }

    return {
      status: 'ok',
      database: 'up',
      // 主密钥无效不阻止启动，漏配只能在这里暴露：否则要到保存 API Key 才拿到 400
      encryption: this.cipher.enabled ? 'enabled' : 'disabled',
      encryptionReason: this.cipher.disableReason,
      // 提示词版本：线上跑的是哪一版必须不重新发布就能查到，
      // 否则评测结果无法与实例对齐，“改了提示词导致效果变化”无从证伪
      promptVersion: PROMPT_VERSION,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }
  }
}
