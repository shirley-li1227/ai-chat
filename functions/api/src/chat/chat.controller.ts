import { Controller, Post, Body, Res } from '@nestjs/common'
import { Response } from 'express'
import { ChatService } from './chat.service'
import { ChatRequestDto, ResumeChatDto } from './chat-request.dto'
import { CurrentUser } from '../auth/auth.decorators'
import type { AuthUser } from '../auth/auth.decorators'

@Controller('api/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * 断线信号来自 res，不是 req：请求体读完时 req 就 close 了，那时回答还没开始生成，
   * 控制器再挂监听已经错过事件，等于永远收不到断线。
   * 正常写完也会 close，所以只认「还没结束就被关闭」这一种。
   */
  private disconnectSignal(res: Response): AbortSignal {
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort()
      }
    })
    return controller.signal
  }

  @Post()
  async streamChat(
    @CurrentUser() user: AuthUser,
    @Body() body: ChatRequestDto,
    @Res() res: Response,
  ) {
    await this.chatService.streamChat(
      user.id,
      body.conversationId,
      body.content,
      res,
      this.disconnectSignal(res),
    )
  }

  /**
   * 断点续传：浏览器断线后带着已渲染的前半段重连，服务端只补后半段。
   * 与首发同样按连接生命周期中止——客户端一走，上游那次请求就该停，别继续烧额度。
   */
  @Post('resume')
  async resumeChat(
    @CurrentUser() user: AuthUser,
    @Body() body: ResumeChatDto,
    @Res() res: Response,
  ) {
    await this.chatService.resumeChat(
      user.id,
      body.conversationId,
      body.content,
      body.partial,
      res,
      this.disconnectSignal(res),
    )
  }
}
