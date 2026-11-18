import { Module } from '@nestjs/common'
import { ChatService } from './chat.service'
import { ChatController } from './chat.controller'
import { ConfigModule } from '../config/config.module'
import { ConversationsModule } from '../conversations/conversations.module'
import { TasksModule } from '../tasks/tasks.module'
import { MemoryModule } from '../memory/memory.module'

@Module({
  imports: [ConfigModule, ConversationsModule, TasksModule, MemoryModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
