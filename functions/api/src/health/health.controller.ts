import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { SecretCipher } from '../security/secret-cipher'

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
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }
  }
}
