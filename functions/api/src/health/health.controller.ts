import { Controller, Get } from '@nestjs/common'
import { PROMPT_VERSION } from '../chat/prompt'
import { readEnvApiConfig } from '../chat/llm-config'

@Controller('api/health')
export class HealthController {
  /**
   * 演示模式没有数据库可探活，这里回答的是「实例活着吗 + 能不能真的调模型」。
   * 漏配 LLM_API_KEY 不阻止启动，只在这里如实上报，
   * 否则要到第一次发消息才拿到 400，分不清是部署挂了还是没配 Key。
   */
  @Get()
  check() {
    const config = readEnvApiConfig()

    return {
      status: 'ok',
      llm: config ? 'configured' : 'missing',
      provider: config?.provider ?? null,
      model: config?.model ?? null,
      // 提示词版本：线上跑的是哪一版必须不重新发布就能查到，
      // 否则评测结果无法与实例对齐，"改了提示词导致效果变化"无从证伪
      promptVersion: PROMPT_VERSION,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }
  }
}
