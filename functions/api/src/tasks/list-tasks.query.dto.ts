import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'
import { TASK_STATUSES } from './task-policy'
import type { TaskStatus } from './task-policy'

export class ListTasksQueryDto {
  @IsOptional()
  @IsIn(TASK_STATUSES as unknown as string[], {
    message: `status 只能是 ${TASK_STATUSES.join(' / ')}`,
  })
  status?: TaskStatus

  @IsOptional()
  @IsString({ message: 'conversationId 必须是字符串' })
  @MaxLength(36, { message: 'conversationId 过长' })
  conversationId?: string
}
