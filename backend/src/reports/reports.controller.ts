import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('loss-gain')
  lossGain(
    @Query('from')      from?: string,
    @Query('to')        to?: string,
    @Query('processId') processId?: string,
    @Query('vendorId')  vendorId?: string,
  ) {
    return this.reports.lossGain({
      from, to,
      processId: processId ? Number(processId) : undefined,
      vendorId:  vendorId  ? Number(vendorId)  : undefined,
    });
  }

  @Get('stones')
  stones(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.stones({ from, to });
  }

  @Get('vendor-metal')
  vendorMetal() {
    return this.reports.vendorMetal();
  }

  @Get('per-design')
  perDesign(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.perDesign({ from, to });
  }
}
