import { Controller, Post, Body, Res, Req } from '@nestjs/common'
import { Response, Request } from 'express'
import { ChatService } from './chat.service'
import { ChatRequestDto } from './chat-request.dto'
import { readEnvApiConfig } from './llm-config'

@Controller('api/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async streamChat(
    @Body() body: ChatRequestDto,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    const abortController = new AbortController()
    req.on('close', () => abortController.abort())

    await this.chatService.streamChat(
      readEnvApiConfig(),
      body.messages,
      body.content,
      res,
      abortController.signal,
    )
  }
}
