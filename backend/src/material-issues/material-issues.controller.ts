import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { MaterialIssuesService } from './material-issues.service';
import { CloseIssueDto, CreateMaterialIssueDto, RecordReturnDto } from './dto/material-issue.dto';
import { CurrentUser, AuthUser, Public } from '../common/decorators';
import { streamMaterialIssuePdf } from './material-issues.pdf';

@Controller('material-issues')
export class MaterialIssuesController {
  constructor(private readonly svc: MaterialIssuesService) {}

  @Get('next-voucher-number')
  nextVoucherNumber() {
    return this.svc.nextVoucherNumber();
  }

  @Get('vendor-holdings')
  vendorHoldings(@Query('vendorId') vendorId?: string) {
    return this.svc.vendorHoldings(vendorId ? Number(vendorId) : undefined);
  }

  // Lines that still owe the vendor materials (deferred at issue time due to
  // stock shortage). Filter by variantId to "after restocking X, who needs X?".
  @Get('pending-demand')
  pendingDemand(@Query('variantId') variantId?: string) {
    return this.svc.pendingDemand(variantId ? Number(variantId) : undefined);
  }

  // Issue a previously-deferred qty when stock has arrived. The frontend
  // popup fires this on user confirmation.
  @Post('lines/:lineId/issue-deferred')
  issueDeferred(
    @Param('lineId', ParseIntPipe) lineId: number,
    @Body() body: { qty: number },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.issueDeferred(lineId, body.qty, user.id);
  }

  @Get()
  list(@Query('vendorId') vendorId?: string, @Query('status') status?: string) {
    return this.svc.list({ vendorId: vendorId ? Number(vendorId) : undefined, status });
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  // Issue voucher PDF (the original issue document).
  @Public()
  @Get(':id/pdf')
  async issuePdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const data = await this.svc.pdfData(id, 'ISSUE');
    streamMaterialIssuePdf(res, data);
  }

  // Return / status PDF (live snapshot of issued / used / returned / pending / short).
  @Public()
  @Get(':id/return-pdf')
  async returnPdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const data = await this.svc.pdfData(id, 'STATUS');
    streamMaterialIssuePdf(res, data);
  }

  @Post()
  create(@Body() dto: CreateMaterialIssueDto, @CurrentUser() user: AuthUser) {
    return this.svc.create(dto, user.id);
  }

  @Post(':id/return')
  recordReturn(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordReturnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.recordReturn(id, dto, user.id);
  }

  // Bulk vendor return — distributes returned qty across all open vouchers of
  // the same vendor (FIFO by issue date). Powers the "Return Materials" action
  // on the vendor holdings card.
  @Post('vendor-return')
  vendorReturn(
    @Body() body: { vendorId: number; items: { variantId: number; returnedQty: number }[] },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.returnFromVendor(body.vendorId, body.items, user.id);
  }

  @Post(':id/close')
  close(@Param('id', ParseIntPipe) id: number, @Body() dto: CloseIssueDto) {
    return this.svc.close(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.svc.remove(id, user.id);
  }
}
