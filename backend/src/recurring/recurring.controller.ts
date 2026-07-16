import { Body, Controller, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { RecurringService } from './recurring.service';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('recurring-invoices')
export class RecurringController {
  constructor(private readonly svc: RecurringService) {}

  @Get()
  list() { return this.svc.list(); }

  @Post()
  create(@Body() dto: any, @CurrentUser() u: AuthUser) {
    return this.svc.create(dto, u?.id);
  }

  @Put(':id/toggle')
  toggle(@Param('id', ParseIntPipe) id: number, @Body() body: { enabled: boolean }) {
    return this.svc.toggle(id, body.enabled);
  }

  @Post('run-due')
  runDue(@CurrentUser() u: AuthUser) {
    return this.svc.runDue(u?.id);
  }
}
