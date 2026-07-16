import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import { BulkCreateColorVariantsDto, UpsertVariantDto, VariantQueryDto } from './dto/material.dto';

// Round to 3 decimal places (max precision of the Decimal columns).
const r3 = (n: number) => Math.round(n * 1000) / 1000;

@Injectable()
export class MaterialsService {
  constructor(private prisma: PrismaService) {}

  categories() {
    return this.prisma.materialCategory.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Inline-create from the Material Variant form's category SearchableSelect.
   * Trim + collapse whitespace, reject empty. Case-insensitive dedupe —
   * "Stones", "stones", and "  Stones  " all map to one existing row.
   * Reactivates a previously-deactivated row instead of erroring.
   */
  async createCategory(rawName: string) {
    const name = (rawName ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new BadRequestException('Category name cannot be empty.');
    const existing = await this.prisma.materialCategory.findFirst({
      where: { name: { equals: name } },
    });
    if (existing) {
      if (existing.status !== 'ACTIVE') {
        return this.prisma.materialCategory.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE' },
        });
      }
      return existing;
    }
    return this.prisma.materialCategory.create({ data: { name } });
  }

  materials() {
    return this.prisma.material.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, materialCode: true, materialName: true },
      orderBy: { materialName: 'asc' },
    });
  }

  /**
   * Block "Pearl 4mm White" being created twice under the same Material
   * (the human-readable (Material, Variant) pair). variantCode is auto-
   * generated unique, but two variants with the same name confuse
   * everyone downstream — BOMs, inventory, vendor quotes, stock alerts.
   * Case-insensitive + trimmed. `excludeId` lets a row save its own name.
   */
  private async assertVariantUnique(materialId: number, rawName: string, excludeId?: number) {
    const variantName = (rawName ?? '').trim();
    if (!variantName) return;
    const existing = await this.prisma.materialVariant.findFirst({
      where: {
        materialId,
        variantName: { equals: variantName },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      include: { material: { select: { materialName: true } } },
    });
    if (existing) {
      throw new BadRequestException(
        `Variant "${existing.variantName}" already exists for material "${existing.material.materialName}" (${existing.variantCode}). Pick a unique variant name.`,
      );
    }
  }

  async findAll(query: VariantQueryDto) {
    const where: Prisma.MaterialVariantWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      // Case-insensitive deep search — every text column plus notes on
      // both the variant and its parent material.
      const like = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { variantName: like },
        { variantCode: like },
        { size: like },
        { color: like },
        { shape: like },
        { finish: like },
        { notes: like },
        { material: { materialName: like } },
        { material: { notes: like } },
      ];
    }
    const categoryId = query.categoryId ? Number(query.categoryId) : 0;
    if (categoryId > 0) where.material = { categoryId };

    const variants = await this.prisma.materialVariant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        material: { include: { category: true } },
        vendors: { include: { vendor: { select: { shortName: true } } } },
        processes: { select: { processId: true } },
      },
    });

    return variants.map((v) => ({
      ...v,
      materialName: v.material.materialName,
      materialCode: v.material.materialCode,
      categoryName: v.material.category?.name ?? null,
      categoryId: v.material.categoryId,
      code: this.buildMaterialCode(this.supplierShort(v.vendors), v.material.materialName, v.size, v.color),
      vendorCount: v.vendors.length,
      minPrice: v.vendors.reduce<number | null>((min, vv) => {
        const p = vv.price ? Number(vv.price) : null;
        if (p == null) return min;
        return min == null ? p : Math.min(min, p);
      }, null),
      trackByQty: v.trackByQty,
      trackByWeight: v.trackByWeight,
      stockQty: Number(v.stockQty),
      stockWeight: Number(v.stockWeight),
      processIds: v.processes.map((p) => p.processId),
      imageUrl: v.imagePath ? `/uploads/${v.imagePath}` : null,
      vendors: undefined,
      material: undefined,
      processes: undefined,
    }));
  }

  /** Supplier short code = preferred vendor's short name, else the first vendor's. */
  private supplierShort(vendors: { isPreferred: boolean; vendor: { shortName: string | null } }[]) {
    if (!vendors.length) return '';
    const chosen = vendors.find((v) => v.isPreferred) ?? vendors[0];
    return chosen.vendor.shortName ?? '';
  }

  /** Generated code: SHORT-MaterialName-Size-Colour (blank segments skipped, spaces stripped). */
  private buildMaterialCode(short: string, material: string, size?: string | null, color?: string | null) {
    return [short, material, size, color]
      .map((s) => (s ?? '').toString().trim().replace(/\s+/g, ''))
      .filter(Boolean)
      .join('-');
  }

  // ---------------- Inventory ----------------
  /** All active variants with current stock + price (for the Inventory page). */
  async stockList(search?: string) {
    const variants = await this.prisma.materialVariant.findMany({
      where: {
        status: 'ACTIVE',
        ...(search
          ? { OR: [
              { variantName: { contains: search, mode: 'insensitive' } },
              { variantCode: { contains: search, mode: 'insensitive' } },
              { material: { materialName: { contains: search, mode: 'insensitive' } } },
            ] }
          : {}),
      },
      include: { material: { include: { category: true } }, vendors: true },
      orderBy: { variantName: 'asc' },
    });
    return variants.map((v) => ({
      id: v.id,
      variantCode: v.variantCode,
      variantName: v.variantName,
      materialName: v.material.materialName,
      categoryName: v.material.category?.name ?? null,
      size: v.size,
      color: v.color,
      unit: v.unit,
      trackByQty: v.trackByQty,
      trackByWeight: v.trackByWeight,
      stockQty: Number(v.stockQty),
      stockWeight: Number(v.stockWeight),
      price: v.vendors.reduce<number | null>((min, vv) => {
        const p = vv.price ? Number(vv.price) : null;
        return p == null ? min : min == null ? p : Math.min(min, p);
      }, null),
    }));
  }

  /**
   * Apply a stock movement (IN/OUT/ADJUST) on either dimension (qty / weight)
   * or both, and update the corresponding running balances.
   *
   * Semantics:
   *   IN     → quantity + weight ADD to balance
   *   OUT    → quantity + weight SUBTRACT from balance
   *   ADJUST → quantity + weight are absolute new balances (delta computed)
   *
   * At least one of qty/weight must be non-zero. Movements involving a
   * dimension the variant doesn't track are silently zeroed (the form
   * shouldn't show those fields but the server stays robust).
   */
  async adjustStock(
    variantId: number,
    body: {
      type: 'IN' | 'OUT' | 'ADJUST';
      quantity?: number;
      weight?: number;
      note?: string;
      // Purchase metadata — populated when the user tags this IN movement
      // as a vendor delivery. Lets /raw-materials show received-slip folders
      // grouped by vendor with the supplier's invoice number + line total.
      vendorId?: number | null;
      invoiceNumber?: string | null;
      unitPrice?: number | null;
      unitRatePerGram?: number | null;
    },
    userId?: number,
  ) {
    const variant = await this.prisma.materialVariant.findUnique({ where: { id: variantId } });
    if (!variant) throw new NotFoundException('Variant not found.');

    const reqQty = Number(body.quantity ?? 0);
    const reqWt  = Number(body.weight ?? 0);
    const qty = variant.trackByQty    ? reqQty : 0;
    const wt  = variant.trackByWeight ? reqWt  : 0;
    if (qty === 0 && wt === 0) {
      throw new BadRequestException('Enter a non-zero quantity or weight.');
    }

    const curQty = Number(variant.stockQty);
    const curWt  = Number(variant.stockWeight);

    const qtyDelta = body.type === 'IN' ? qty : body.type === 'OUT' ? -qty : qty - curQty;
    const wtDelta  = body.type === 'IN' ? wt  : body.type === 'OUT' ? -wt  : wt  - curWt;

    const newQty = r3(curQty + qtyDelta);
    const newWt  = r3(curWt  + wtDelta);

    const isVendorPurchase = body.type === 'IN' && body.vendorId != null;
    const refType = isVendorPurchase ? 'purchase' : 'manual';

    await this.prisma.$transaction([
      this.prisma.materialVariant.update({
        where: { id: variantId },
        data: { stockQty: newQty, stockWeight: newWt },
      }),
      this.prisma.stockMovement.create({
        data: {
          variantId,
          type: body.type,
          quantity: r3(qtyDelta),
          balanceAfter: newQty,
          weight: r3(wtDelta),
          balanceWeightAfter: newWt,
          refType,
          note: body.note ?? null,
          vendorId: isVendorPurchase ? body.vendorId! : null,
          invoiceNumber: isVendorPurchase ? (body.invoiceNumber ?? null) : null,
          unitPrice: isVendorPurchase && body.unitPrice != null ? body.unitPrice : null,
          unitRatePerGram: isVendorPurchase && body.unitRatePerGram != null ? body.unitRatePerGram : null,
          createdById: userId ?? null,
        } as any,
      }),
    ]);
    return { id: variantId, stockQty: newQty, stockWeight: newWt };
  }

  /** Recent stock movements (optionally for one variant). */
  async movements(variantId?: number, limit = 100) {
    const rows = await this.prisma.stockMovement.findMany({
      where: variantId ? { variantId } : {},
      include: { variant: { include: { material: true } }, vendor: true } as any,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((m: any) => ({
      id: m.id,
      date: m.createdAt,
      variantId: m.variantId,
      variantCode: m.variant.variantCode,
      variantName: m.variant.variantName,
      materialName: m.variant.material?.materialName ?? null,
      type: m.type,
      quantity: Number(m.quantity),
      balanceAfter: Number(m.balanceAfter),
      weight: Number(m.weight),
      balanceWeightAfter: Number(m.balanceWeightAfter),
      refType: m.refType,
      refId: m.refId,
      note: m.note,
      vendorId: m.vendorId ?? null,
      vendorCode: m.vendor?.vendorCode ?? null,
      vendorName: m.vendor?.vendorName ?? null,
      invoiceNumber: m.invoiceNumber ?? null,
      unitPrice: m.unitPrice != null ? Number(m.unitPrice) : null,
      unitRatePerGram: m.unitRatePerGram != null ? Number(m.unitRatePerGram) : null,
      lineTotal: m.unitPrice != null
        ? Number(m.unitPrice) * Math.abs(Number(m.quantity))
        : (m.unitRatePerGram != null ? Number(m.unitRatePerGram) * Math.abs(Number(m.weight)) : null),
    }));
  }

  /** Purchase receipts grouped by vendor — feeds the "received slips" vendor
   *  folders on the /raw-materials page. Each entry is a tagged IN movement
   *  (refType=purchase). Ad-hoc adjustments without a vendor are excluded. */
  async purchaseReceipts(limit = 500) {
    const rows = await this.prisma.stockMovement.findMany({
      where: { type: 'IN', vendorId: { not: null } } as any,
      include: { variant: { include: { material: true } }, vendor: true } as any,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const byVendor = new Map<number, any>();
    for (const m of rows as any[]) {
      const vid = m.vendorId as number;
      const cur = byVendor.get(vid) ?? {
        vendorId: vid,
        vendorCode: m.vendor?.vendorCode ?? '',
        vendorName: m.vendor?.vendorName ?? '',
        slipCount: 0,
        totalQty: 0,
        totalWeight: 0,
        totalAmount: 0,
        slips: [] as any[],
      };
      const qty = Number(m.quantity);
      const wt  = Number(m.weight);
      const lineTotal = m.unitPrice != null
        ? Number(m.unitPrice) * Math.abs(qty)
        : (m.unitRatePerGram != null ? Number(m.unitRatePerGram) * Math.abs(wt) : 0);
      cur.slipCount += 1;
      cur.totalQty += Math.abs(qty);
      cur.totalWeight += Math.abs(wt);
      cur.totalAmount += lineTotal;
      cur.slips.push({
        id: m.id,
        date: m.createdAt,
        variantId: m.variantId,
        variantCode: m.variant.variantCode,
        variantName: m.variant.variantName,
        materialName: m.variant.material?.materialName ?? null,
        unit: m.variant.unit ?? '',
        qty,
        weight: wt,
        balanceAfter: Number(m.balanceAfter),
        balanceWeightAfter: Number(m.balanceWeightAfter),
        invoiceNumber: m.invoiceNumber ?? null,
        unitPrice: m.unitPrice != null ? Number(m.unitPrice) : null,
        unitRatePerGram: m.unitRatePerGram != null ? Number(m.unitRatePerGram) : null,
        lineTotal,
        note: m.note,
      });
      byVendor.set(vid, cur);
    }
    return Array.from(byVendor.values()).sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  }

  async findOne(id: number) {
    const variant = await this.prisma.materialVariant.findUnique({
      where: { id },
      include: {
        material: true,
        vendors: { include: { vendor: true }, orderBy: { id: 'asc' } },
        processes: { include: { process: true } },
      },
    });
    if (!variant) throw new NotFoundException('Variant not found.');
    return {
      ...variant,
      materialName: variant.material.materialName,
      materialCode: variant.material.materialCode,
      categoryId: variant.material.categoryId,
      code: this.buildMaterialCode(
        this.supplierShort(variant.vendors.map((vv) => ({ isPreferred: vv.isPreferred, vendor: { shortName: vv.vendor.shortName } }))),
        variant.material.materialName,
        variant.size,
        variant.color,
      ),
      trackByQty: variant.trackByQty,
      trackByWeight: variant.trackByWeight,
      stockQty: Number(variant.stockQty),
      stockWeight: Number(variant.stockWeight),
      imageUrl: variant.imagePath ? `/uploads/${variant.imagePath}` : null,
      vendors: variant.vendors.map((vv) => ({
        id: vv.id,
        vendorId: vv.vendorId,
        vendorCode: vv.vendor.vendorCode,
        vendorName: vv.vendor.vendorName,
        vendorReference: vv.vendorReference,
        price: vv.price ? Number(vv.price) : null,
        moq: vv.moq ? Number(vv.moq) : null,
        isPreferred: vv.isPreferred,
        notes: vv.notes,
      })),
      processIds: variant.processes.map((p) => p.processId),
      processes: variant.processes.map((p) => ({
        id: p.processId,
        code: p.process.code,
        name: p.process.name,
      })),
      material: undefined,
    };
  }

  async create(dto: UpsertVariantDto, userId?: number) {
    const materialId = await this.resolveMaterial(dto, userId);
    await this.assertVariantUnique(materialId, dto.variantName);
    const variantCode = await nextCode(
      this.prisma,
      'materialVariant',
      'variantCode',
      'MV',
      5,
    );

    const { trackByQty, trackByWeight } = this.resolveTracking(dto);
    const openingQty = trackByQty    ? Math.max(0, r3(Number(dto.initialStock ?? 0)))       : 0;
    const openingWt  = trackByWeight ? Math.max(0, r3(Number(dto.initialStockWeight ?? 0))) : 0;
    const processIds = Array.from(new Set(dto.processIds ?? [])).filter((id) => id > 0);

    const variant = await this.prisma.materialVariant.create({
      data: {
        materialId,
        variantCode,
        ...this.variantFields(dto, trackByQty, trackByWeight),
        stockQty: openingQty,
        stockWeight: openingWt,
        vendors: { create: this.vendorRows(dto) },
        processes: { create: processIds.map((processId) => ({ processId })) },
      },
    });
    if (openingQty > 0 || openingWt > 0) {
      await this.prisma.stockMovement.create({
        data: {
          variantId: variant.id,
          type: 'IN',
          quantity: openingQty,
          balanceAfter: openingQty,
          weight: openingWt,
          balanceWeightAfter: openingWt,
          refType: 'opening_stock',
          refId: variant.id,
          note: 'Opening stock at variant creation',
          createdById: userId ?? null,
        } as any,
      });
    }
    return { id: variant.id, variantCode: variant.variantCode };
  }

  /**
   * Bulk-create N colour variants from one shared base. All variants share
   * material / size / finish / shape / unit / notes / vendor; each colour
   * row supplies its own price + opening stock + image. One transaction
   * so partial failures (duplicate code, schema validation) roll back the
   * whole batch — never leave the user with "3 of 5 colours created".
   */
  async bulkCreateColors(dto: BulkCreateColorVariantsDto, userId?: number) {
    if (!dto.colors.length) {
      throw new BadRequestException('Add at least one colour.');
    }
    const seen = new Set<string>();
    for (const c of dto.colors) {
      const k = c.color.trim().toLowerCase();
      if (!k) throw new BadRequestException('Each colour row needs a colour name.');
      if (seen.has(k)) throw new BadRequestException(`Duplicate colour "${c.color}" — every row must be distinct.`);
      seen.add(k);
    }
    const materialId = await this.resolveMaterial(
      { materialName: dto.materialName, categoryId: dto.categoryId, unit: dto.unit } as UpsertVariantDto,
      userId,
    );
    const { trackByQty, trackByWeight } = this.resolveTracking(dto as any);

    const planned = dto.colors.map((c) => {
      const color = c.color.trim();
      const variantName = [dto.size, dto.shape, dto.materialName, color]
        .map((s) => (s ?? '').toString().trim())
        .filter(Boolean)
        .join(' ');
      return {
        color,
        variantName,
        price: c.price,
        initialStock:       trackByQty    ? Math.max(0, r3(Number(c.initialStock ?? 0)))       : 0,
        initialStockWeight: trackByWeight ? Math.max(0, r3(Number(c.initialStockWeight ?? 0))) : 0,
        imagePath: c.imagePath?.trim() || undefined,
      };
    });
    for (const p of planned) {
      await this.assertVariantUnique(materialId, p.variantName);
    }

    const codes: string[] = [];
    for (let i = 0; i < planned.length; i++) {
      codes.push(await nextCode(this.prisma, 'materialVariant', 'variantCode', 'MV', 5));
    }

    return this.prisma.$transaction(async (tx) => {
      const created: Array<{ id: number; variantCode: string; color: string }> = [];
      for (let i = 0; i < planned.length; i++) {
        const p = planned[i];
        const variant = await tx.materialVariant.create({
          data: {
            materialId,
            variantCode: codes[i],
            variantName: p.variantName,
            size: dto.size ?? null,
            color: p.color,
            finish: dto.finish ?? null,
            shape: dto.shape ?? null,
            unit: dto.unit ?? null,
            imagePath: p.imagePath ?? null,
            notes: dto.notes ?? null,
            status: dto.status ?? 'ACTIVE',
            trackByQty,
            trackByWeight,
            stockQty: p.initialStock,
            stockWeight: p.initialStockWeight,
            vendors: {
              create: [{
                vendorId: dto.vendorId,
                vendorReference: dto.vendorReference ?? null,
                price: p.price ?? null,
                moq: dto.moq ?? null,
                isPreferred: true,
                notes: dto.vendorNotes ?? null,
              }],
            },
          },
        });
        if (p.initialStock > 0 || p.initialStockWeight > 0) {
          await tx.stockMovement.create({
            data: {
              variantId: variant.id,
              type: 'IN',
              quantity: p.initialStock,
              balanceAfter: p.initialStock,
              weight: p.initialStockWeight,
              balanceWeightAfter: p.initialStockWeight,
              refType: 'opening_stock',
              refId: variant.id,
              note: 'Opening stock — bulk colour create',
              createdById: userId ?? null,
            } as any,
          });
        }
        created.push({ id: variant.id, variantCode: variant.variantCode, color: p.color });
      }
      return { created };
    });
  }

  async update(id: number, dto: UpsertVariantDto, userId?: number) {
    await this.findOne(id);
    const materialId = await this.resolveMaterial(dto, userId);
    await this.assertVariantUnique(materialId, dto.variantName, id);
    const { trackByQty, trackByWeight } = this.resolveTracking(dto);
    const processIds = Array.from(new Set(dto.processIds ?? [])).filter((pid) => pid > 0);
    await this.prisma.$transaction([
      this.prisma.materialVariant.update({
        where: { id },
        data: { materialId, ...this.variantFields(dto, trackByQty, trackByWeight) },
      }),
      this.prisma.materialVariantVendor.deleteMany({ where: { variantId: id } }),
      this.prisma.materialVariantVendor.createMany({
        data: this.vendorRows(dto).map((r) => ({ ...r, variantId: id })),
      }),
      // Replace-strategy for processes too — wipe and rewrite. Junction
      // table has no downstream FKs so this is safe.
      this.prisma.materialVariantProcess.deleteMany({ where: { variantId: id } }),
      this.prisma.materialVariantProcess.createMany({
        data: processIds.map((processId) => ({ variantId: id, processId })),
      }),
    ]);
    return { id };
  }

  async remove(id: number) {
    await this.findOne(id);
    const [issueLines, itemMaterials, stockMoves] = await Promise.all([
      this.prisma.materialIssueLine.count({ where: { variantId: id } }),
      this.prisma.itemMaterial.count({ where: { variantId: id } }),
      this.prisma.stockMovement.count({ where: { variantId: id } }),
    ]);
    if (issueLines > 0 || itemMaterials > 0) {
      const parts: string[] = [];
      if (issueLines > 0) parts.push(`${issueLines} material-issue line${issueLines === 1 ? '' : 's'}`);
      if (itemMaterials > 0) parts.push(`${itemMaterials} item BOM link${itemMaterials === 1 ? '' : 's'}`);
      if (stockMoves > 0) parts.push(`${stockMoves} stock movement${stockMoves === 1 ? '' : 's'}`);
      throw new BadRequestException(
        `Can't delete — this variant is referenced by ${parts.join(', ')}. ` +
        `Deactivate it instead (Edit → Status → Inactive) so existing history stays intact ` +
        `but it no longer shows up in new issues / BOMs.`,
      );
    }
    await this.prisma.materialVariant.delete({ where: { id } });
    return { id };
  }

  async setVariantStatus(id: number, status: 'ACTIVE' | 'INACTIVE') {
    await this.findOne(id);
    await this.prisma.materialVariant.update({ where: { id }, data: { status } });
    return { id, status };
  }

  // ---- helpers ----
  private async resolveMaterial(dto: UpsertVariantDto, userId?: number) {
    const existing = await this.prisma.material.findFirst({
      where: { materialName: dto.materialName },
    });
    if (existing) {
      if (dto.categoryId) {
        await this.prisma.material.update({
          where: { id: existing.id },
          data: { categoryId: dto.categoryId },
        });
      }
      return existing.id;
    }
    const materialCode = await nextCode(this.prisma, 'material', 'materialCode', 'M', 4);
    const created = await this.prisma.material.create({
      data: {
        materialCode,
        materialName: dto.materialName,
        categoryId: dto.categoryId ?? null,
        unit: dto.unit ?? null,
        createdById: userId ?? null,
      },
    });
    return created.id;
  }

  /**
   * Pick the variant's tracking dimensions. Weight tracking is MANDATORY for
   * every material in this ERP — silver flows through the shop floor in
   * grams end-to-end, so every variant must have a weight ledger. Qty
   * tracking is optional (bulk silver / dust isn't counted in pieces).
   */
  private resolveTracking(dto: { trackByQty?: boolean; trackByWeight?: boolean }) {
    const trackByQty    = dto.trackByQty    ?? true;
    const trackByWeight = dto.trackByWeight ?? true;
    if (!trackByWeight) {
      throw new BadRequestException(
        'Weight tracking is required for every material — operator weighs every issue and return.',
      );
    }
    return { trackByQty, trackByWeight };
  }

  private variantFields(dto: UpsertVariantDto, trackByQty: boolean, trackByWeight: boolean) {
    return {
      variantName: dto.variantName,
      size: dto.size ?? null,
      color: dto.color ?? null,
      finish: dto.finish ?? null,
      shape: dto.shape ?? null,
      unit: dto.unit ?? null,
      imagePath: dto.imagePath ?? null,
      notes: dto.notes ?? null,
      status: dto.status ?? 'ACTIVE',
      trackByQty,
      trackByWeight,
    };
  }

  private vendorRows(dto: UpsertVariantDto) {
    return (dto.vendors ?? [])
      .filter((v) => v.vendorId > 0)
      .map((v) => ({
        vendorId: v.vendorId,
        vendorReference: v.vendorReference ?? null,
        price: v.price ?? null,
        moq: v.moq ?? null,
        isPreferred: v.isPreferred ?? false,
        notes: v.notes ?? null,
      }));
  }
}
