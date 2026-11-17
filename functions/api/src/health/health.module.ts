import { Module } from '@nestjs/common'
import { ConfigModule as AppConfigModule } from '../config/config.module'
import { TasksModule } from '../tasks/tasks.module'
import { HealthController } from './health.controller'

@Module({
  // 导出 SecretCipher，探活需要上报加密是否真的生效；
  // TasksModule 提供队列水位，用来发现「任务一直在排队但没人执行」
  imports: [AppConfigModule, TasksModule],
  controllers: [HealthController],
})
export class HealthModule {}
