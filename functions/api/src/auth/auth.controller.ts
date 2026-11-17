import { Body, Controller, Get, Post } from '@nestjs/common'
import { AuthService } from './auth.service'
import { LoginDto, RegisterDto } from './auth.dto'
import { CurrentToken, CurrentUser, Public } from './auth.decorators'
import { authEnabled } from './auth-mode'
import type { AuthUser } from './auth.decorators'

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 注册即登录：省掉「注册完再让用户把刚填的密码再敲一遍」 */
  @Public()
  @Post('register')
  register(@Body() body: RegisterDto) {
    return this.auth.register(body.username, body.password)
  }

  @Public()
  @Post('login')
  login(@Body() body: LoginDto) {
    return this.auth.login(body.username, body.password)
  }

  /**
   * 首屏先问一次模式：免登录时直接把演示身份交给前端，省掉「没有 token 就认定未登录」的误判。
   * 公开可访问是必要的（登录页之前就要拿到），代价只是暴露一个演示用的用户名。
   */
  @Public()
  @Get('mode')
  async mode() {
    if (authEnabled()) {
      return { authEnabled: true, user: null }
    }
    return { authEnabled: false, user: await this.auth.demoUser() }
  }

  @Post('logout')
  async logout(@CurrentToken() token: string) {
    await this.auth.logout(token)
    return { success: true }
  }

  /** 前端用它判断本地 token 是否还有效，避免带着过期 token 进入主界面 */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user
  }
}
