import { Module } from '@nestjs/common'
import { ConfigModule as AppConfigModule } from '../config/config.module'
import { HealthController } from './health.controller'

@Module({
  // 导出 SecretCipher，探活需要上报加密是否真的生效
  imports: [AppConfigModule],
  controllers: [HealthController],
})
export class HealthModule {}
