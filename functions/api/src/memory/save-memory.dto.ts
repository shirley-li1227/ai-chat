import { IsNotEmpty, IsString, MaxLength } from 'class-validator'

/**
 * 生产环境启用 ValidationPipe({ whitelist, forbidNonWhitelisted })，
 * 字段必须全部显式声明，否则请求会被 400 拒绝。
 *
 * 这里只拦到硬上限 500 字，实际生效的是 MEMORY_ITEM_MAX_CHARS：
 * 校验器拿不到运行时环境变量，两层各管一件事——粗筛恶意超长，细筛产品口径。
 */
export class SaveMemoryDto {
  @IsString()
  @IsNotEmpty({ message: '记忆内容不能为空' })
  @MaxLength(500, { message: '单条记忆不能超过 500 字' })
  content: string
}
