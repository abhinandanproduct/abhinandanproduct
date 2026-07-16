import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ActiveStatus } from '@prisma/client';

export class VariantVendorDto {
  @IsInt()
  vendorId!: number;

  @IsOptional() @IsString() @MaxLength(80)
  vendorReference?: string;

  @IsOptional() @IsNumber()
  price?: number;

  @IsOptional() @IsNumber()
  moq?: number;

  @IsOptional() @IsBoolean()
  isPreferred?: boolean;

  @IsOptional() @IsString()
  notes?: string;
}

export class UpsertVariantDto {
  // Parent material resolved/created by name.
  @IsString() @MaxLength(150)
  materialName!: string;

  @IsOptional() @IsInt()
  categoryId?: number;

  @IsString() @MaxLength(150)
  variantName!: string;

  @IsOptional() @IsString() @MaxLength(60) size?: string;
  @IsOptional() @IsString() @MaxLength(60) color?: string;
  @IsOptional() @IsString() @MaxLength(60) finish?: string;
  @IsOptional() @IsString() @MaxLength(60) shape?: string;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;

  @IsOptional() @IsString() @MaxLength(255)
  imagePath?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsEnum(ActiveStatus)
  status?: ActiveStatus;

  // Dual-tracking flags. At least one must be true (server enforces).
  @IsOptional() @IsBoolean() trackByQty?: boolean;
  @IsOptional() @IsBoolean() trackByWeight?: boolean;

  // Opening stock — already with us at variant-creation time. Either or
  // both fields, depending on what the variant tracks. Applied only on
  // CREATE; later changes go through Inventory adjust / receipt flows.
  @IsOptional() @IsNumber()
  initialStock?: number;

  @IsOptional() @IsNumber()
  initialStockWeight?: number;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VariantVendorDto)
  vendors?: VariantVendorDto[];

  // Processes this variant is eligible for — drives the Forward dialog's
  // material picker. Empty / omitted = no restriction (all processes).
  @IsOptional() @IsArray() @IsInt({ each: true })
  processIds?: number[];
}

export class VariantQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() categoryId?: string;
  @IsOptional() @IsEnum(ActiveStatus) status?: ActiveStatus;
}

// One colour row inside the bulk-create payload. Color name is the only
// real per-row identity; price + opening stock + image differ per colour,
// everything else (material / size / finish / shape / vendor / etc.) is
// shared in the parent DTO.
export class BulkColorVariantDto {
  @IsString() @MaxLength(60) color!: string;
  @IsOptional() @IsNumber() price?: number;
  @IsOptional() @IsNumber() initialStock?: number;
  @IsOptional() @IsNumber() initialStockWeight?: number;
  @IsOptional() @IsString() @MaxLength(255) imagePath?: string;
}

// Bulk-create N colour variants of the same base material at once. All
// the shared fields are entered ONCE; the colours[] array drives how many
// variants get created. Each color → 1 MaterialVariant + 1
// MaterialVariantVendor row + (if stock > 0) 1 opening-stock movement.
// Wrapped in a single Prisma transaction so partial failure rolls back.
export class BulkCreateColorVariantsDto {
  @IsString() @MaxLength(150) materialName!: string;
  @IsOptional() @IsInt() categoryId?: number;

  // Shared variant fields
  @IsOptional() @IsString() @MaxLength(60) size?: string;
  @IsOptional() @IsString() @MaxLength(60) finish?: string;
  @IsOptional() @IsString() @MaxLength(60) shape?: string;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(ActiveStatus) status?: ActiveStatus;

  // Shared dual-tracking flags for the entire batch.
  @IsOptional() @IsBoolean() trackByQty?: boolean;
  @IsOptional() @IsBoolean() trackByWeight?: boolean;

  // Shared vendor (single, by spec) — bulk mode restricts to one supplier
  // per colour batch. Secondary vendors can be added per-variant via the
  // single-variant edit form after creation.
  @IsInt() vendorId!: number;
  @IsOptional() @IsString() @MaxLength(80) vendorReference?: string;
  @IsOptional() @IsNumber() moq?: number;
  @IsOptional() @IsString() vendorNotes?: string;

  // The colour list itself — minimum one row, server-side dedupe on (color).
  @IsArray() @ValidateNested({ each: true }) @Type(() => BulkColorVariantDto)
  colors!: BulkColorVariantDto[];
}
