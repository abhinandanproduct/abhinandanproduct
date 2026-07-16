import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { AlloyingService } from './alloying.service';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('alloying')
export class AlloyingController {
  constructor(private readonly svc: AlloyingService) {}

  @Get()
  list() { return this.svc.list(); }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }

  @Post()
  create(
    @Body() dto: { batchDate: string; notes?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.createDraft(dto, user.id);
  }

  @Put(':id/lines')
  saveLines(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: {
      inputs: Array<{ variantId: number; weightG: number; notes?: string }>;
      outputs: Array<{ kind: 'ALLOY' | 'RUNNERS' | 'LOSS'; variantId?: number; weightG: number; notes?: string }>;
    },
  ) {
    return this.svc.saveLines(id, dto);
  }

  @Post(':id/melt')
  melt(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.svc.melt(id, user.id);
  }

  @Delete(':id')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.svc.cancel(id);
  }

  // Hard-delete the batch (Draft or Cancelled only). Removes the row +
  // every line — no stock impact because those statuses haven't posted
  // any movements yet. Melted batches remain final.
  @Delete(':id/hard')
  hardDelete(@Param('id', ParseIntPipe) id: number) {
    return this.svc.hardDelete(id);
  }
}
