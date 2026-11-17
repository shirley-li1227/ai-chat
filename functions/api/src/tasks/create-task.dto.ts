import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator'

/**
 * payload 的内部形状交给 kind 注册表校验（能给出可用工具清单），
 * whitelist 只裁剪 DTO 自身属性，不会动 payload 里的键。
 */
export class CreateTaskDto {
  @IsString({ message: 'kind 必须是字符串' })
  @IsNotEmpty({ message: 'kind 不能为空' })
  @MaxLength(64, { message: 'kind 最长 64 字' })
  kind: string

  @IsObject({ message: 'payload 必须是一个 JSON 对象' })
  payload: Record<string, unknown>

  @IsOptional()
  @IsString({ message: 'conversationId 必须是字符串' })
  @MaxLength(36, { message: 'conversationId 过长' })
  conversationId?: string

  /** 同一个键代表同一个请求，重复提交返回既有任务而不是再造一条 */
  @IsOptional()
  @IsString({ message: 'dedupeKey 必须是字符串' })
  @MaxLength(64, { message: 'dedupeKey 最长 64 字' })
  dedupeKey?: string
}
