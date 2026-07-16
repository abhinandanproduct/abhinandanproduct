import { Module } from '@nestjs/common';
import { AlloyingService } from './alloying.service';
import { AlloyingController } from './alloying.controller';

@Module({
  controllers: [AlloyingController],
  providers: [AlloyingService],
  exports: [AlloyingService],
})
export class AlloyingModule {}
