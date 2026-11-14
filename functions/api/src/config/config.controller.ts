import { Controller, Get, Post, Delete, Body } from '@nestjs/common'
import { ConfigService } from './config.service'
import { SaveApiConfigDto } from './save-api-config.dto'

@Controller('api/config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  async get() {
    const config = await this.configService.get()
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
  async save(@Body() body: SaveApiConfigDto) {
    return this.configService.save({
      provider: body.provider,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      model: body.model,
    })
  }

  @Delete()
  async clear() {
    await this.configService.clear()
    return { success: true }
  }
}
