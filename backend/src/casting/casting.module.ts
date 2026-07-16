import { Module } from '@nestjs/common';
import { CastingController } from './casting.controller';
import { CastingService } from './casting.service';
import { MaterialIssuesModule } from '../material-issues/material-issues.module';

@Module({
  imports: [MaterialIssuesModule],
  controllers: [CastingController],
  providers: [CastingService],
})
export class CastingModule {}
