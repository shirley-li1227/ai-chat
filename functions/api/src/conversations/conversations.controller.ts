import { Controller, Get, Post, Patch, Delete, Body, Param } from '@nestjs/common'
import { ConversationsService } from './conversations.service'
import { TruncateConversationDto } from './truncate-conversation.dto'
import { CurrentUser } from '../auth/auth.decorators'
import type { AuthUser } from '../auth/auth.decorators'

@Controller('api/conversations')
export class ConversationsController {
  constructor(
    private readonly service: ConversationsService,
  ) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.id)
  }

  @Post()
  create(@CurrentUser() user: AuthUser) {
    return this.service.create(user.id)
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user.id, id)
  }

  @Patch(':id')
  updateTitle(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { title: string },
  ) {
    return this.service.updateTitle(user.id, id, body.title)
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.id, id)
  }

  /**
   * 回到某个时刻：删除 fromTimestamp 及之后的消息。
   * “重新生成”与“编辑重发”共用这一个入口，两者只是前端传的基准时间不同。
   */
  @Post(':id/truncate')
  truncate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: TruncateConversationDto,
  ) {
    return this.service.truncateFrom(user.id, id, body.fromTimestamp)
  }
}
