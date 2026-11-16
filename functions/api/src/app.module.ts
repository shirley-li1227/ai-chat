import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { APP_GUARD } from '@nestjs/core'
import { ChatModule } from './chat/chat.module'
import { HealthModule } from './health/health.module'

const isProduction = process.env.NODE_ENV === 'production'

@Module({
  imports: [
    // 全局环境变量模块，.env 已由 gitignore 排除
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '.env.local'] }),

    // 按 IP 限流。演示模式没有登录态，出站大模型额度唯一的刹车就是这里。
    // 注意：计数存在进程内存里，只对单实例有效。CloudBase 云函数会为每个 SSE
    // 连接拉起独立实例，实际放行量约为 limit × 实例数，需靠网关限频兜底。
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // 本地开发放行：开发时 StrictMode 每个请求双发，10 次/分钟会误报「请求失败」
        skipIf: () => !isProduction,
        throttlers: [
          {
            ttl: Number(config.get('THROTTLE_TTL', 60000)),
            limit: Number(config.get('THROTTLE_LIMIT', 10)),
          },
        ],
      }),
    }),

    ChatModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
