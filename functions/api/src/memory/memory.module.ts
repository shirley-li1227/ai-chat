import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { UserMemory } from './memory.entity'
import { MemoryService } from './memory.service'
import { MemoryController } from './memory.controller'

@Module({
  imports: [TypeOrmModule.forFeature([UserMemory])],
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
