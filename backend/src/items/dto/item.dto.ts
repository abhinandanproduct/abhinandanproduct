import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DesignType, SampleStatus } from '@prisma/client';

export class ItemProcessServiceDto {
  @IsInt() serviceId!: number;
  @IsOptional() @IsNumber() cost?: number;
}

// BOM line — material variant consumed by a manufacturing process. Originally
// Sticking-only; extended to Kacha Fitting / Fitting / Packing as those
// processes now also carry their own BOM (no per-colour split — shared BOM
// across colours per process). Sticking remains per-colour (color carries
// the sticking-colour; other processes leave color null).
export class ItemMaterialDto {
  // Which process this BOM line belongs to. Optional for back-compat with
  // older clients that still POST Sticking-only payloads — the service
  // defaults to the Sticking process id in that case.
  @IsOptional() @IsInt() processId?: number;
  @IsInt() variantId!: number;
  // Per-piece quantity — WHOLE number for counted materials; 0 when the
  // line is weight-only (silver chips / loose metal).
  @IsInt() quantity!: number;
  // Per-piece weight (grams) of the line's variant — captured alongside qty
  // for stones / silver / moti where both dimensions matter. 0 = qty-only.
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsNumber() wastagePercent?: number;
  @IsOptional() @IsString() unit?: string;
  // Sticking-specific: which sticking-colour this line belongs to. Ignored
  // for Filing / Kacha Fitting / Fitting+Mala (shared BOM).
  @IsOptional() @IsString() @MaxLength(80) color?: string;
  // Optional per-line rate override. When set, overrides the variant's
  // preferred-supplier price for cost calc + slip PDFs on THIS item only.
  @IsOptional() @IsNumber() rate?: number;
  @IsOptional() @IsString() notes?: string;
}

// One physical component of a design (pendant, earring, patti...). A
// design's total weight = Σ (qtyPerSet × weightPerPc) across its parts.
export class ItemDesignPartDto {
  @IsString() @MaxLength(80) partName!: string;
  @IsInt() qtyPerSet!: number;
  @IsNumber() weightPerPc!: number;
  @IsOptional() @IsString() @MaxLength(255) photoPath?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsString() notes?: string;
}

export class ItemProcessVendorDto {
  @IsInt() vendorId!: number;
  @IsOptional() @IsString() @MaxLength(80) vendorDesignReference?: string;
  @IsOptional() @IsString() @MaxLength(80) color?: string; // colour for this row
  @IsOptional() @IsString() @MaxLength(255) colorPhotoPath?: string; // photo of the colour
  // Rate: cost/kg for KG processes (casting/plating/meena), else cost/piece.
  @IsOptional() @IsNumber() costPerPiece?: number;
  @IsOptional() @IsBoolean() isPreferred?: boolean;
  // Sticking only: vendor brings their own raw materials → rate covers materials,
  // BOM cost is NOT added to the item cost and no material issue is auto-created.
  @IsOptional() @IsBoolean() bringsOwnMaterials?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class ItemProcessDto {
  @IsInt() processId!: number;
  @IsOptional() @IsString() notes?: string;

  // EAV attributes: { weight: "12.5", metal_type: "Brass", ... }
  @IsOptional() @IsObject() attributes?: Record<string, string>;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemProcessVendorDto)
  vendors?: ItemProcessVendorDto[];

  // Optional services selected on this process (e.g. Casting → Soldering/Fitting).
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemProcessServiceDto)
  services?: ItemProcessServiceDto[];

  // Process-level progress / development photos (relative paths).
  @IsOptional() @IsArray() @IsString({ each: true }) photos?: string[];
}

export class ColorModelProcessDto {
  @IsInt() processId!: number;
  @IsString() @MaxLength(60) color!: string;
}

export class ItemColorModelDto {
  @IsOptional() @IsString() @MaxLength(8) letter?: string;
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(255) photoPath?: string;
  @IsOptional() @IsNumber() costPrice?: number;
  @IsOptional() @IsNumber() sellingPrice?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ColorModelProcessDto)
  processColors?: ColorModelProcessDto[];
}

export class UpsertItemDto {
  // sampleDesignCode is auto-generated from the designer short name; not sent on create.
  // itemNumber is now alphanumeric and unique across all items (e.g. "1501", "1501a").
  @IsOptional() @IsString() @MaxLength(40) itemNumber?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsString() @MaxLength(80) subcategory?: string;
  @IsOptional() @IsString() @MaxLength(80) collection?: string;
  @IsOptional() @IsString() notes?: string;

  // Design section
  @IsOptional() @IsEnum(DesignType) designType?: DesignType;
  @IsOptional() @IsString() @MaxLength(120) designerName?: string;
  @IsOptional() @IsString() @MaxLength(20) designerShortName?: string;
  @IsOptional() @IsNumber() designCost?: number;
  @IsOptional() @IsNumber() sellingPrice?: number;
  @IsOptional() @IsString() @MaxLength(255) cadFilePath?: string;

  @IsOptional() @IsEnum(SampleStatus) sampleStatus?: SampleStatus;

  // Product images: array of already-uploaded relative paths.
  @IsOptional() @IsArray() @IsString({ each: true })
  images?: string[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemProcessDto)
  processes?: ItemProcessDto[];

  // BOM — material variants stuck onto the design (the Sticking materials).
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemMaterialDto)
  materials?: ItemMaterialDto[];

  // Colour models — sellable colour variants (a/b/c) with photo + price + per-step colours.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemColorModelDto)
  colorModels?: ItemColorModelDto[];

  // Design parts — components of the design (pendant, earring, patti, …).
  // Replaces the single planned weight at the design level — total expected
  // weight per set = Σ (qtyPerSet × weightPerPc).
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemDesignPartDto)
  designParts?: ItemDesignPartDto[];

  // Per-design opt-out of post-Plating variant bifurcation. Defaults true
  // for new items; set false for legacy items that should keep the old
  // group-only receive flow until they finish.
  @IsOptional() @IsBoolean() bifurcationEnabled?: boolean;
}

// Operator-supplied item number when allocating post-Packing. Must match
// the ABN-NNNN format AND be unused.
export class AllocateItemNumberDto {
  @IsString() @MaxLength(40) itemNumber!: string;
}

export class ItemQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(SampleStatus) sampleStatus?: SampleStatus;
  @IsOptional() @IsString() category?: string;
}
