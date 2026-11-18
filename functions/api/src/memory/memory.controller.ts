import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common'
import { MemoryService } from './memory.service'
import { SaveMemoryDto } from './save-memory.dto'
import { memoryHandle } from './memory-policy'
import { CurrentUser } from '../auth/auth.decorators'
import type { AuthUser } from '../auth/auth.decorators'

/**
 * 三个接口回同一种形状（整份清单 + 上限 + 一句说明）。
 *
 * 为什么增删也返全量：写入会连带淘汰最旧的那条，删除会改变剩余条目的注入位次，
 * 让前端再发一次 GET 只是多一个必然不一致的窗口，不如一次把真相给全。
 */
@Controller('api/memories')
export class MemoryController {
  constructor(private readonly memories: MemoryService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return this.envelope(user.id)
  }

  /** 手动补一条：来源记成 user，与模型自主记下的在面板里区分开 */
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: SaveMemoryDto) {
    const result = await this.memories.createByUser(user.id, body.content)
    if (!result.ok) {
      throw new BadRequestException(result.message)
    }
    return { ...(await this.envelope(user.id)), message: result.message }
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.memories.remove(user.id, id)
    return { ...(await this.envelope(user.id)), message: '已删除' }
  }

  /**
   * handle 一并回给前端：界面上那条记忆和模型口中的 [a1b2c3] 必须对得上，
   * 否则用户想纠正「它记错了的那条」时无从指认。
   */
  private async envelope(userId: string) {
    const items = await this.memories.list(userId)
    return {
      items: items.map((item) => ({
        id: item.id,
        handle: memoryHandle(item.id),
        content: item.content,
        source: item.source,
        updatedAt: item.updatedAt,
      })),
      limits: this.memories.snapshot(),
    }
  }
}
