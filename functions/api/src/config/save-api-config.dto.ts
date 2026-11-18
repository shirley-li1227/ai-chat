import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator'
import { PROVIDER_IDS, providerSpec, requireProvider } from './providers'

/**
 * provider 决定用哪套凭据规则，所以 apiKey / baseUrl 的格式校验不能写成全局常量正则。
 * 三个约束都从注册表取规则，消息里带上「这一家长什么样」，否则用户只会看到「格式不正确」。
 */
function specOf(args: ValidationArguments) {
  return providerSpec((args.object as SaveApiConfigDto).provider)
}

/** 未登记的供应商由 @IsIn 报错，属性级约束此时一律放行，避免同一次提交报三条 */
function appliesHere(args: ValidationArguments): boolean {
  return specOf(args) !== null
}

@ValidatorConstraint({ name: 'providerApiKey', async: false })
export class ProviderApiKeyRule implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (!appliesHere(args)) {
      return true
    }
    // 空串=「这次不改 Key」，交给服务层判断是不是首次保存；格式规则只管真填了的情况
    if (typeof value !== 'string' || !value.trim()) {
      return true
    }
    return specOf(args)!.apiKeyRule.pattern.test(value.trim())
  }

  defaultMessage(args: ValidationArguments): string {
    return specOf(args)?.apiKeyRule.message ?? 'apiKey 格式不正确'
  }
}

@ValidatorConstraint({ name: 'providerBaseUrl', async: false })
export class ProviderBaseUrlRule implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (!appliesHere(args)) {
      return true
    }
    const url = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
    return specOf(args)!.baseUrlRule.pattern.test(url)
  }

  defaultMessage(args: ValidationArguments): string {
    const spec = specOf(args)
    return spec ? `${spec.label} 的 baseUrl：${spec.baseUrlRule.message}` : 'baseUrl 格式不正确'
  }
}

/**
 * 路由候选属于这一家。挡掉「把 DeepSeek 的档位填进智谱配置」——那种请求只会拿到上游 4xx，
 * 而界面上看只是「答不上来」，归因成本远高于保存时的一句提示。
 * 只认注册表里别家的命名特征，别名（中转站自定义名）不在此列，照放。
 */
@ValidatorConstraint({ name: 'providerCandidates', async: false })
export class ProviderCandidatesRule implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const spec = specOf(args)
    if (!spec || typeof value !== 'string' || !value.trim()) {
      return true
    }
    return split(value).every((model) => !foreignProviderOf(model, spec.id))
  }

  defaultMessage(args: ValidationArguments): string {
    const spec = specOf(args)
    if (!spec) {
      return 'routingCandidates 格式不正确'
    }
    const foreign = split(String(args.value ?? '')).find((model) => foreignProviderOf(model, spec.id))
    return `候选档位里的「${foreign ?? ''}」不属于 ${spec.label}，发给这一家只会报错。请填写该账号确实开通的模型名`
  }
}

function split(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function foreignProviderOf(model: string, providerId: string): string | null {
  return (
    PROVIDER_IDS.find((id) => id !== providerId && providerSpec(id)?.modelHint.test(model) === true) ??
    null
  )
}

/**
 * 生产环境启用 ValidationPipe({ whitelist, forbidNonWhitelisted })，
 * 字段必须全部显式声明，否则请求会被 400 拒绝。
 */
export class SaveApiConfigDto {
  @IsIn(PROVIDER_IDS, {
    message: `provider 目前支持：${PROVIDER_IDS.map((id) => requireProvider(id).label).join('、')}`,
  })
  provider: string

  /** 留空表示沿用库里已存的 Key，只有首次保存该家才必须完整填写 */
  @IsString()
  @MaxLength(256)
  @Validate(ProviderApiKeyRule)
  apiKey: string

  @IsString()
  @IsNotEmpty({ message: 'baseUrl 不能为空' })
  @MaxLength(512)
  @Validate(ProviderBaseUrlRule)
  baseUrl: string

  @IsString()
  @IsNotEmpty({ message: 'model 不能为空' })
  @MaxLength(128)
  model: string

  /** 该家的档位候选（从低到高，逗号分隔）；留空表示这家不开场景化换档 */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Validate(ProviderCandidatesRule)
  routingCandidates?: string | null

  /** 保存后是否立刻把这份设为生效，缺省生效；不生效就是「先存着，回头再切」 */
  @IsOptional()
  @IsBoolean()
  apply?: boolean
}
