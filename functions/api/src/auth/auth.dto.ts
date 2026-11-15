import {
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator'

/**
 * 生产环境启用 ValidationPipe({ whitelist, forbidNonWhitelisted })，
 * 字段必须全部显式声明，否则请求会被 400 拒绝。
 */
export class RegisterDto {
  @IsString()
  @IsNotEmpty({ message: '用户名不能为空' })
  @Length(3, 32, { message: '用户名长度需在 3 到 32 个字符之间' })
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: '用户名只能包含字母、数字、点、下划线和减号',
  })
  username: string

  @IsString()
  @Length(8, 128, { message: '密码长度需在 8 到 128 个字符之间' })
  password: string
}

export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: '用户名不能为空' })
  @MaxLength(32)
  username: string

  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  password: string
}
