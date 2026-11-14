import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import helmet from 'helmet'
import express from 'express'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)

  // 安全响应头；本项目前端与 API 同源，故关闭会误伤资源加载的默认策略
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  )

  // 请求体上限，避免超大 payload 打爆内存
  app.use(express.json({ limit: '256kb' }))
  app.use(express.urlencoded({ extended: true, limit: '256kb' }))

  // 统一校验：剥离未声明字段（whitelist）并做类型转换
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )

  const origins = (config.get<string>('CORS_ORIGINS', '') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  app.enableCors({
    // 白名单为空时同源部署无需放行；配置了才允许跨域
    origin: origins.length > 0 ? origins : false,
    credentials: true,
  })

  // 保证 SIGTERM 时 onModuleDestroy 被执行，让数据库完成落盘
  app.enableShutdownHooks()

  const port = Number(config.get('PORT', 3001))
  await app.listen(port)

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log(`NestJS backend running on http://localhost:${port}`)
  }
}

bootstrap()
