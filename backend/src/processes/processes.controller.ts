import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProcessesService } from './processes.service';

class CreateServiceDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(40) appliesTo?: string;
}

class UpsertProcessDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(40) code?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isCosted?: boolean;
  @IsOptional() @IsBoolean() bomCapable?: boolean;
  @IsOptional() @IsBoolean() bifurcates?: boolean;
  @IsOptional() @IsBoolean() requiresShortName?: boolean;
  @IsOptional() @IsString() status?: 'ACTIVE' | 'INACTIVE';
}

@Controller('processes')
export class ProcessesController {
  constructor(private readonly processes: ProcessesService) {}

  @Get()
  findAll() {
    return this.processes.findAll();
  }

  // Add a new service to the shared services master (used by the item form).
  @Post('services')
  createService(@Body() body: CreateServiceDto) {
    return this.processes.createService(body);
  }

  // Process Master CRUD — Masters > Processes UI.
  @Post()
  create(@Body() body: UpsertProcessDto) {
    return this.processes.createProcess(body);
  }

  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpsertProcessDto) {
    return this.processes.updateProcess(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.processes.deleteProcess(id);
  }
}
