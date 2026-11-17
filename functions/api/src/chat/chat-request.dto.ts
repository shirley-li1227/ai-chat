import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator'
import { MAX_RESUME_PARTIAL_CHARS } from './continuation'

export class ChatRequestDto {
  @IsUUID(undefined, { message: 'conversationId 必须是合法 UUID' })
  conversationId: string

  @IsString()
  @IsNotEmpty({ message: 'content 不能为空' })
  // 单条消息上限，避免超长 prompt 造成上游费用与内存压力
  @MaxLength(8000, { message: 'content 长度不能超过 8000 字符' })
  content: string
}

/**
 * 断点续传入参：content 仍是本轮原始提问，partial 是浏览器已经渲染出来的前半段回答。
 *
 * partial 上限与 continuation.ts 的 MAX_RESUME_PARTIAL_CHARS 是同一个数：
 * 再长下去请求体本身就要吃掉一块函数内存，而且这种回答多半已经跑题，
 * 不如让前端走「重新生成」。
 */
export class ResumeChatDto extends ChatRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'partial 不能为空：没有已生成内容请直接重新生成' })
  @MaxLength(MAX_RESUME_PARTIAL_CHARS, {
    message: `partial 长度不能超过 ${MAX_RESUME_PARTIAL_CHARS} 字符，请重新生成`,
  })
  partial: string
}
