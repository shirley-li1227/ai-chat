import {
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator'

/**
 * 生产环境启用 ValidationPipe({ whitelist, forbidNonWhitelisted })，
 * 字段必须全部显式声明，否则请求会被 400 拒绝。
 */
export class SaveApiConfigDto {
  @IsIn(['deepseek'], { message: 'provider 目前仅支持 deepseek' })
  provider: string

  @IsString()
  @IsNotEmpty({ message: 'apiKey 不能为空' })
  @MaxLength(256)
  // DeepSeek 密钥形如 sk-<随机串>，前置格式校验可挡住把 API Key 名称误填成别的凭据
  @Matches(/^sk-[A-Za-z0-9_-]{8,}$/, {
    message: 'apiKey 格式不正确，DeepSeek 密钥应以 sk- 开头',
  })
  apiKey: string

  @IsString()
  @IsNotEmpty({ message: 'baseUrl 不能为空' })
  @MaxLength(512)
  @Matches(/^https:\/\/[^/]+$/, {
    message: 'baseUrl 必须是 https 协议且不带结尾斜杠',
  })
  baseUrl: string

  @IsString()
  @IsNotEmpty({ message: 'model 不能为空' })
  @MaxLength(128)
  model: string
}
