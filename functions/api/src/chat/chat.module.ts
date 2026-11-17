import { Module } from '@nestjs/common'
import { ChatService } from './chat.service'
import { ChatController } from './chat.controller'
import { ConfigModule } from '../config/config.module'
import { ConversationsModule } from '../conversations/conversations.module'
import { TasksModule } from '../tasks/tasks.module'

@Module({
  imports: [ConfigModule, ConversationsModule, TasksModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
