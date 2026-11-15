import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common'

export const IS_PUBLIC_KEY = 'auth:isPublic'

/** 标记无需登录即可访问的接口（登录/注册/健康检查） */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

export interface AuthUser {
  id: string
  username: string
}

function switchToRequest(ctx: ExecutionContext): Record<string, any> {
  return ctx.switchToHttp().getRequest()
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => switchToRequest(ctx).user,
)

/** 当前请求携带的会话 token，退出登录时按它删除会话记录 */
export const CurrentToken = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => switchToRequest(ctx).authToken,
)
