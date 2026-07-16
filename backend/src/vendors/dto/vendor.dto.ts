import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ActiveStatus } from '@prisma/client';

export class UpsertVendorDto {
  @IsString()
  @MaxLength(150, { message: 'vendor_name must be at most 150 characters' })
  vendorName!: string;

  @IsOptional() @IsString() @MaxLength(60)
  shortName?: string;

  @IsOptional() @IsBoolean()
  isInhouse?: boolean;

  @IsOptional() @IsString() @MaxLength(120)
  contactPerson?: string;

  @IsOptional() @IsString() @MaxLength(20)
  mobile?: string;

  // Plain string — no email-format validation. Operators paste raw text
  // here (WhatsApp handle, informal label, blank), and shape checking
  // just gets in the way.
  @IsOptional() @IsString() @MaxLength(150)
  email?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString() @MaxLength(20)
  gstNumber?: string;

  @IsOptional() @IsString() @MaxLength(15)
  panNumber?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsEnum(ActiveStatus)
  status?: ActiveStatus;

  @IsOptional() @IsArray() @IsInt({ each: true })
  processIds?: number[];
}

export class VendorQueryDto {
  @IsOptional() @IsString()
  search?: string;

  @IsOptional()
  processId?: string;

  @IsOptional() @IsEnum(ActiveStatus)
  status?: ActiveStatus;
}
