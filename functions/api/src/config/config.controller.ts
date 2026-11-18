import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { ConfigService } from './config.service'
import { SaveApiConfigDto } from './save-api-config.dto'
import { CurrentUser } from '../auth/auth.decorators'
import type { AuthUser } from '../auth/auth.decorators'

@Controller('api/config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const items = await this.configService.listViews(user.id)
    const active = items.find((item) => item.active) ?? null
    return { configured: Boolean(active), active, items }
  }

  @Post()
  async save(@CurrentUser() user: AuthUser, @Body() body: SaveApiConfigDto) {
    const view = await this.configService.save(
      user.id,
      {
        provider: body.provider,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        model: body.model,
        routingCandidates: body.routingCandidates ?? null,
      },
      body.apply !== false,
    )
    return { success: true, config: view }
  }

  @Post(':provider/activate')
  async activate(@CurrentUser() user: AuthUser, @Param('provider') provider: string) {
    return { success: true, config: await this.configService.activate(user.id, provider) }
  }

  @Delete(':provider')
  async remove(@CurrentUser() user: AuthUser, @Param('provider') provider: string) {
    await this.configService.remove(user.id, provider)
    return { success: true }
  }

  @Delete()
  async clear(@CurrentUser() user: AuthUser) {
    await this.configService.clear(user.id)
    return { success: true }
  }
}
