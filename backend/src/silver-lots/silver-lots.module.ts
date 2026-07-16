import { Module } from '@nestjs/common';
import { SilverLotsService } from './silver-lots.service';
import { SilverLotsController } from './silver-lots.controller';

@Module({
  controllers: [SilverLotsController],
  providers: [SilverLotsService],
  exports: [SilverLotsService],
})
export class SilverLotsModule {}
