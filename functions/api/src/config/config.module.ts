import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ConfigModule as NestConfigModule, ConfigService as NestConfigService } from '@nestjs/config'
import { ApiConfigEntity } from './api-config.entity'
import { ConfigService } from './config.service'
import { ConfigController } from './config.controller'
import { SecretCipher } from '../security/secret-cipher'

@Module({
  imports: [
    TypeOrmModule.forFeature([ApiConfigEntity]),
    NestConfigModule,
  ],
  controllers: [ConfigController],
  providers: [
    ConfigService,
    // 主密钥来自环境变量，按需提供单例，便于测试替换
    {
      provide: SecretCipher,
      inject: [NestConfigService],
      useFactory: (config: NestConfigService) =>
        new SecretCipher(config.get<string>('ENCRYPTION_KEY')),
    },
  ],
  exports: [ConfigService, SecretCipher],
})
export class ConfigModule {}
