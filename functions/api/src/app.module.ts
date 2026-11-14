import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { APP_GUARD } from '@nestjs/core'
import { ApiConfigEntity } from './config/api-config.entity'
import { Conversation } from './conversations/conversation.entity'
import { Message } from './conversations/message.entity'
import { ConfigModule as AppConfigModule } from './config/config.module'
import { ConversationsModule } from './conversations/conversations.module'
import { ChatModule } from './chat/chat.module'
import { HealthModule } from './health/health.module'

const isProduction = process.env.NODE_ENV === 'production'
const synchronize =
  isProduction && process.env.DB_SYNCHRONIZE !== 'true' ? false : true

@Module({
  imports: [
    // 全局环境变量模块，.env 已由 gitignore 排除，仅提交 .env.example
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '.env.local'] }),

    // 按 IP 限流，防止聊天接口被刷爆上游额度。
    // 注意：计数存在进程内存里，只对单实例有效。CloudBase 云函数会为每个 SSE
    // 连接拉起独立实例，实际放行量约为 limit × 实例数，需靠网关限频兜底。
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: Number(config.get('THROTTLE_TTL', 60000)),
            limit: Number(config.get('THROTTLE_LIMIT', 10)),
          },
        ],
      }),
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const type = config.get('DB_TYPE', 'sqljs')

        // 生产环境启用 sqljs 会给出显式警告：内存库 + 文件落盘，
        // 多实例或 Serverless 部署下数据会丢失，应改用外部数据库。
        if (isProduction && type === 'sqljs') {
          // eslint-disable-next-line no-console
          console.warn(
            '[WARN] 生产环境使用 sqljs 仅作单机演示；进程重启/多实例会导致数据丢失，请切换 DB_TYPE=postgres',
          )
        }

        if (type === 'postgres') {
          // 显式指定泛型并兼用默认值，避免 config.get 推导出联合类型
          return {
            type: 'postgres' as const,
            host: config.get<string>('DB_HOST') ?? 'localhost',
            port: Number(config.get<string>('DB_PORT') ?? 5432),
            username: config.get<string>('DB_USERNAME') ?? 'postgres',
            password: config.get<string>('DB_PASSWORD') ?? '',
            database: config.get<string>('DB_DATABASE') ?? 'ai_chat',
            entities: [ApiConfigEntity, Conversation, Message],
            synchronize,
            migrationsRun: !synchronize,
          }
        }

        return {
          type: 'sqljs' as const,
          location: config.get<string>('DB_LOCATION') ?? 'data/app.db',
          autoSave: true,
          entities: [ApiConfigEntity, Conversation, Message],
          synchronize,
        }
      },
    }),

    AppConfigModule,
    ConversationsModule,
    ChatModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
