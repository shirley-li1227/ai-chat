import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'

/**
 * 前端回传的历史工具轨迹。字段与界面里的 ToolStep 一一对应，
 * 服务端要据此还原成 assistant(tool_calls) → tool 的协议消息序列，
 * 少了 id 或 arguments 上游会直接判定消息链不合法。
 */
export class HistoryStepDto {
  @IsString()
  @IsNotEmpty({ message: 'toolCalls[].id 不能为空' })
  id: string

  @IsString()
  @IsNotEmpty({ message: 'toolCalls[].name 不能为空' })
  name: string

  @IsString()
  arguments: string

  @IsString()
  result: string

  @IsBoolean()
  ok: boolean
}

export class HistoryMessageDto {
  // 只接受这两类：tool/system 消息由服务端从 steps 还原，客户端不该自己塞
  @IsIn(['user', 'assistant'], { message: 'messages[].role 只能是 user 或 assistant' })
  role: 'user' | 'assistant'

  @IsString()
  content: string

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HistoryStepDto)
  toolCalls?: HistoryStepDto[]
}

export class ChatRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'content 不能为空' })
  @MaxLength(8000, { message: 'content 长度不能超过 8000 字符' })
  content: string

  /**
   * 本轮之前的完整对话历史（正序）。演示模式服务端不落库，上下文靠客户端每次带上，
   * 条数上限只为挡住异常 payload，真正的窗口裁剪由 token 预算负责。
   */
  @IsArray({ message: 'messages 必须是数组：演示模式的历史由前端随请求带上' })
  @ArrayMaxSize(200, { message: '历史消息过多（最多 200 条），请开启新对话' })
  @ValidateNested({ each: true })
  @Type(() => HistoryMessageDto)
  messages: HistoryMessageDto[]
}
