import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { TasksService } from './task.service'
import { CreateTaskDto } from './create-task.dto'
import { ListTasksQueryDto } from './list-tasks.query.dto'
import { describeTaskKinds } from './task-registry'
import { backgroundTasksEnabled } from './task-policy'
import { CurrentUser } from '../auth/auth.decorators'
import type { AuthUser } from '../auth/auth.decorators'

@Controller('api/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /**
   * 必须先于 :id 声明，否则 "meta/kinds" 会被当作任务 id 走到详情接口。
   * runnerEnabled 一并回给前端：没有执行器时任务只会排队，界面要能说明这一点。
   */
  @Get('meta/kinds')
  kinds() {
    return { kinds: describeTaskKinds(), runnerEnabled: backgroundTasksEnabled() }
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() query: ListTasksQueryDto) {
    const { items, counts } = await this.tasks.list(user.id, {
      status: query.status,
      conversationId: query.conversationId,
    })
    return { items, counts, runnerEnabled: backgroundTasksEnabled() }
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateTaskDto) {
    return this.tasks.enqueue(user.id, body)
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.find(user.id, id)
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.cancel(user.id, id)
  }
}
