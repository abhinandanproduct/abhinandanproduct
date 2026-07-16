import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { VendorsService } from './vendors.service';
import { UpsertVendorDto, VendorQueryDto } from './dto/vendor.dto';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  findAll(@Query() query: VendorQueryDto) {
    return this.vendors.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.vendors.findOne(id);
  }

  @Post()
  create(@Body() dto: UpsertVendorDto, @CurrentUser() user: AuthUser) {
    return this.vendors.create(dto, user.id);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertVendorDto,
  ) {
    return this.vendors.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.vendors.remove(id);
  }
}
