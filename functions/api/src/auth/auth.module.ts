import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { User } from './user.entity'
import { Session } from './session.entity'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { AuthGuard } from './auth.guard'
import { ConfigModule } from '../config/config.module'
import { ConversationsModule } from '../conversations/conversations.module'

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Session]),
    // 首个账号要认领鉴权上线前的无主数据，依赖这两个模块的服务
    ConfigModule,
    ConversationsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
