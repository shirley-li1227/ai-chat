import { Controller, Get, Post, Patch, Delete, Body, Param } from '@nestjs/common'
import { ConversationsService } from './conversations.service'

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
}
