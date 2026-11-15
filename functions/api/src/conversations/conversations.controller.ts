import { Controller, Get, Post, Patch, Delete, Body, Param } from '@nestjs/common'
import { ConversationsService } from './conversations.service'
import { TruncateConversationDto } from './truncate-conversation.dto'

@Controller('api/conversations')
export class ConversationsController {
  constructor(private readonly service: ConversationsService) {}

  @Get()
  findAll() {
    return this.service.findAll()
  }

  @Post()
  create() {
    return this.service.create()
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id)
  }

  @Patch(':id')
  updateTitle(@Param('id') id: string, @Body() body: { title: string }) {
    return this.service.updateTitle(id, body.title)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id)
  }

  /**
   * 回到某个时刻：删除 fromTimestamp 及之后的消息。
   * “重新生成”与“编辑重发”共用这一个入口，两者只是前端传的基准时间不同。
   */
  @Post(':id/truncate')
  truncate(
    @Param('id') id: string,
    @Body() body: TruncateConversationDto,
  ) {
    return this.service.truncateFrom(id, body.fromTimestamp)
  }
}
