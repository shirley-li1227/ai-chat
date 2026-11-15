import { IsInt, Min } from 'class-validator'

/**
 * 截断请求体：删除 timestamp >= fromTimestamp 的全部消息。
 *
 * 只接受时间戳而不是消息 id：消息实体没有对外暴露稳定 id 用途，
 * 而前端列表本来就以 timestamp 为 key，少一层映射就少一处不一致。
 */
export class TruncateConversationDto {
  // 严格限定整数：浮点、字符串、负数都会让范围查询拿到预期外的值
  @IsInt({ message: 'fromTimestamp 必须是整数毫秒时间戳' })
  @Min(0, { message: 'fromTimestamp 不能为负' })
  fromTimestamp: number
}
