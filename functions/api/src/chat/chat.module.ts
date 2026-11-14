import { Module } from '@nestjs/common'
import { ChatService } from './chat.service'
import { ChatController } from './chat.controller'
import { ConfigModule } from '../config/config.module'
import { ConversationsModule } from '../conversations/conversations.module'

@Module({
  imports: [ConfigModule, ConversationsModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
