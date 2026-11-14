import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator'

export class ChatRequestDto {
  @IsUUID(undefined, { message: 'conversationId 必须是合法 UUID' })
  conversationId: string

  @IsString()
  @IsNotEmpty({ message: 'content 不能为空' })
  // 单条消息上限，避免超长 prompt 造成上游费用与内存压力
  @MaxLength(8000, { message: 'content 长度不能超过 8000 字符' })
  content: string
}
