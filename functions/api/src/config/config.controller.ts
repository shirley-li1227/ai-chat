import { Controller, Get, Post, Delete, Body } from '@nestjs/common'
import { ConfigService } from './config.service'
import { SaveApiConfigDto } from './save-api-config.dto'
import { CurrentUser } from '../auth/auth.decorators'
import type { AuthUser } from '../auth/auth.decorators'

@Controller('api/config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const config = await this.configService.get(user.id)
    if (!config) {
      return { configured: false }
    }
    return {
      configured: true,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyMasked: `${config.apiKey.slice(0, 4)}****${config.apiKey.slice(-4)}`,
    }
  }

  @Post()
  save(@CurrentUser() user: AuthUser, @Body() body: SaveApiConfigDto) {
    return this.configService.save(user.id, {
      provider: body.provider,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      model: body.model,
    })
  }

  @Delete()
  async clear(@CurrentUser() user: AuthUser) {
    await this.configService.clear(user.id)
    return { success: true }
  }
}
