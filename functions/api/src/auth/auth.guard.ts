import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthService } from './auth.service'
import { IS_PUBLIC_KEY } from './auth.decorators'
import { authEnabled } from './auth-mode'

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) {
      return true
    }

    const request = context.switchToHttp().getRequest<Record<string, any>>()

    // 免登录模式：不校验 token，一律挂演示身份。旁路只放在这一处，
    // 控制器与业务服务照常从 @CurrentUser() 取值，不需要知道现在是什么模式。
    if (!authEnabled()) {
      request.user = await this.auth.demoUser()
      request.authToken = null
      return true
    }

    const token = readBearerToken(request.headers?.authorization)
    if (!token) {
      throw new UnauthorizedException('请先登录')
    }

    const user = await this.auth.resolve(token)
    if (!user) {
      throw new UnauthorizedException('登录已过期，请重新登录')
    }

    request.user = user
    request.authToken = token
    return true
  }
}

function readBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null
  }
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}
