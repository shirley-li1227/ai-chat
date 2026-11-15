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
import { AuthModule } from './auth/auth.module'
import { AuthGuard } from './auth/auth.guard'
import { User } from './auth/user.entity'
import { Session } from './auth/session.entity'

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
        // 本地开发放行：计数只在进程内存里，对 Serverless 本就不生效；
        // 开发时 StrictMode 每个请求双发，10 次/分钟会挡住流式收尾后的重载，误报「请求失败」
        skipIf: () => !isProduction,
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
          // 内置 PostgreSQL 是否强制 SSL 由控制台「SSL 配置」开关决定；
          // 关闭强制时可用非 SSL 连接，故默认不启用，通过 DB_SSL=true 显式打开。
          const sslEnabled = config.get<string>('DB_SSL', 'false') === 'true'
          // 显式指定泛型并兼用默认值，避免 config.get 推导出联合类型
          return {
            type: 'postgres' as const,
            host: config.get<string>('DB_HOST') ?? 'localhost',
            port: Number(config.get<string>('DB_PORT') ?? 5432),
            username: config.get<string>('DB_USERNAME') ?? 'postgres',
            password: config.get<string>('DB_PASSWORD') ?? '',
            database: config.get<string>('DB_DATABASE') ?? 'ai_chat',
            ssl: sslEnabled ? { rejectUnauthorized: false } : false,
            entities: [ApiConfigEntity, Conversation, Message, User, Session],
            synchronize,
            migrationsRun: !synchronize,
          }
        }

        return {
          type: 'sqljs' as const,
          location: config.get<string>('DB_LOCATION') ?? 'data/app.db',
          autoSave: true,
          entities: [ApiConfigEntity, Conversation, Message, User, Session],
          synchronize,
        }
      },
    }),

    AppConfigModule,
    ConversationsModule,
    ChatModule,
    HealthModule,
    AuthModule,
  ],
  // 顺序即执行顺序：先按 IP 限流，再校验登录态。
  // AuthGuard 挂在 globally 而不是逐个控制器加，新接口默认就是需要登录的。
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
