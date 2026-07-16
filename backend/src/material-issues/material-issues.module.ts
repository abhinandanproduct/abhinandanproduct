import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MaterialIssuesService } from './material-issues.service';
import { MaterialIssuesController } from './material-issues.controller';

@Module({
  imports: [PrismaModule],
  controllers: [MaterialIssuesController],
  providers: [MaterialIssuesService],
  exports: [MaterialIssuesService],
})
export class MaterialIssuesModule {}
