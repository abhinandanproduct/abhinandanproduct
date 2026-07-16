import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UpsertItemDto, ItemQueryDto, ItemProcessDto } from './dto/item.dto';
import {
  PROCESS_ATTRIBUTES,
  COLOUR_PROCESSES,
  COLOR_MODEL_PROCESSES,
  KG_PROCESSES,
  SERVICE_PROCESSES,
  BATCH_ONLY_PROCESSES,
  SUPPLIER_PROCESSES,
  DESIGNER_PROCESSES,
  costUnit,
} from '../processes/processes.service';

@Injectable()
export class ItemsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {
    // Undo handler — revert an items.update by writing the BEFORE
    // snapshot's basicFields (item-level columns) back. Process /
    // material / colour-model rows are NOT restored automatically —
    // those have complex cascades (vendor design refs, BOM rows on
    // batches) that need manual review. The operator sees the diff
    // in the activity log and can re-edit relations from the master
    // page if needed. Top-level revert covers 80% of "I edited the
    // wrong field" cases.
    this.audit.registerUndo('items.update', async (log) => {
      const before: any = log.snapshotBefore ?? {};
      if (!log.targetId) throw new BadRequestException('Cannot undo — log has no item id.');
      const fields: Prisma.ItemUpdateInput = {};
      // Restore the simple scalar columns that basicFields() owns +
      // sampleDesignCode, which the update path regenerates from the
      // designer short-name and would otherwise be left stale on undo
      // (e.g. designer cleared but the design code still shows the
      // designer's prefix).
      const scalars = [
        'sampleDesignCode',
        'itemNumber', 'itemName', 'category', 'subcategory', 'collection', 'notes',
        'designType', 'designerName', 'designerShortName', 'designCost', 'sellingPrice',
        'cadFilePath', 'sampleStatus', 'status',
      ];
      for (const k of scalars) {
        if (k in before) (fields as any)[k] = before[k];
      }
      await this.prisma.item.update({ where: { id: log.targetId }, data: fields });
    });
    // Recreate an image row deleted via deleteImage. snapshotBefore is
    // the ItemImage row — we restore url + flags. id may be different
    // on restore (the original PK is gone); we don't try to preserve it.
    this.audit.registerUndo('items.image.delete', async (log) => {
      const before: any = log.snapshotBefore ?? {};
      if (!before.itemId || !before.filePath) {
        throw new BadRequestException('Cannot undo — original image data missing from snapshot.');
      }
      await this.prisma.itemImage.create({
        data: {
          itemId: before.itemId,
          filePath: before.filePath,
          isPrimary: !!before.isPrimary,
          sortOrder: before.sortOrder ?? 0,
        },
      });
    });
  }

  // Form metadata: processes (+ cost unit / services), vendors, designers, services master.
  /**
   * Distinct taxonomy values across all items. Drives the Category /
   * Subcategory / Collection dropdowns in the form so users get
   * autocomplete + a clean "+ Add" path for new values. Nulls and blanks
   * are filtered out; values are returned trimmed + sorted (case-insensitive).
   */
  async lookups() {
    const rows = await this.prisma.item.findMany({
      select: { category: true, subcategory: true, collection: true },
    });
    const collect = (key: 'category' | 'subcategory' | 'collection') => {
      const seen = new Set<string>();
      for (const r of rows) {
        const v = (r[key] ?? '').trim();
        if (v) seen.add(v);
      }
      return Array.from(seen).sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      );
    };
    return {
      categories: collect('category'),
      subcategories: collect('subcategory'),
      collections: collect('collection'),
    };
  }

  async meta() {
    // Fetch every ACTIVE process — including designer + supplier roles —
    // in ONE round-trip so the designer picker (CAD vendors) doesn't need
    // its own query. The production/batch dropdown filters these out
    // below via `notIn: [...SUPPLIER_PROCESSES, ...DESIGNER_PROCESSES]`.
    const allActive = await this.prisma.process.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
      include: {
        vendorLinks: {
          include: { vendor: { select: { id: true, vendorCode: true, vendorName: true, isInhouse: true } } },
        },
      },
    });
    // Production-flow processes exclude both supplier and designer roles.
    const processes = allActive.filter(
      (p) => !SUPPLIER_PROCESSES.includes(p.code) && !DESIGNER_PROCESSES.includes(p.code),
    );

    const allVendors = await this.prisma.vendor.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, vendorCode: true, vendorName: true, shortName: true, isInhouse: true },
      orderBy: { vendorName: 'asc' },
    });

    const services = await this.prisma.processService.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    });

    // Material variants for the Sticking BOM builder (with price + current stock).
    const variantRows = await this.prisma.materialVariant.findMany({
      where: { status: 'ACTIVE' },
      include: { material: true, vendors: true },
      orderBy: { variantName: 'asc' },
    });
    const variants = variantRows.map((v) => ({
      id: v.id,
      variantCode: v.variantCode,
      variantName: v.variantName,
      // Expose materialId + shape + finish so the Item Master Sticking-BOM
      // "Copy from another colour" feature can do a structural match
      // (materialId × size × shape × finish) to find the equivalent
      // variant in the target colour. Was previously just (materialName,
      // size, color) which couldn't disambiguate shape/finish variants.
      materialId: v.materialId,
      materialName: v.material.materialName,
      size: v.size,
      color: v.color,
      shape: v.shape,
      finish: v.finish,
      unit: v.unit,
      stockQty: Number(v.stockQty),
      price: this.variantPrice(v.vendors),
    }));

    const mapped = processes.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      attributes: PROCESS_ATTRIBUTES[p.code] ?? [],
      usesColor: COLOUR_PROCESSES.includes(p.code),
      colorModelStep: COLOR_MODEL_PROCESSES.includes(p.code),
      usesServices: SERVICE_PROCESSES.includes(p.code),
      batchOnly: BATCH_ONLY_PROCESSES.includes(p.code),
      costUnit: costUnit(p.code),
      // Surface Process master flags so the frontend forward dialogs can
      // gate the inline BOM UI on `bomCapable` instead of a hard-coded
      // STICKING check — Kacha Fitting, Fitting+Mala, etc. get the same
      // BOM capture + material-issue voucher flow.
      bomCapable: (p as any).bomCapable ?? false,
      bifurcates: (p as any).bifurcates ?? false,
      vendors: p.vendorLinks.map((l) => l.vendor),
    }));

    // Designers = vendors tagged with the CAD role. CAD is a vendor
    // category (designer / CAD modeller) — NOT a production step — so
    // it's fetched from `allActive` rather than the filtered `processes`
    // list. Falls back to CAM's vendors so pre-migration data (before
    // CAD was reactivated as a designer role) doesn't break.
    const designProc = allActive.find((p) => p.code === 'CAD')
                    ?? allActive.find((p) => p.code === 'CAM');
    const designers = (designProc?.vendorLinks ?? []).map((l) => ({
      id: l.vendor.id,
      vendorCode: l.vendor.vendorCode,
      vendorName: l.vendor.vendorName,
      shortName: allVendors.find((v) => v.id === l.vendor.id)?.shortName ?? null,
    }));

    return {
      processes: mapped,
      allVendors,
      designers,
      services: services.map((s) => ({ id: s.id, code: s.code, name: s.name, appliesTo: s.appliesTo })),
      variants,
      sampleStatuses: ['DRAFT', 'IN_DEVELOPMENT', 'SAMPLE_READY', 'PRODUCTION_READY'],
    };
  }

  /** Preferred vendor price, else the cheapest mapped price, else 0. */
  private variantPrice(vendors: { price: any; isPreferred: boolean }[]): number {
    const preferred = vendors.find((v) => v.isPreferred && v.price != null);
    if (preferred) return Number(preferred.price);
    const prices = vendors.map((v) => (v.price != null ? Number(v.price) : null)).filter((p): p is number => p != null);
    return prices.length ? Math.min(...prices) : 0;
  }

  /** Preview the next sample design code for a designer short name (e.g. TVM-003). */
  async nextDesignCode(shortName?: string) {
    return { sampleDesignCode: await this.generateDesignCode(shortName) };
  }

  async findAll(query: ItemQueryDto) {
    const where: Prisma.ItemWhereInput = {};
    if (query.sampleStatus) where.sampleStatus = query.sampleStatus;
    if (query.category) where.category = query.category;
    if (query.search) {
      // Wide search — match any item whose text fields contain the query.
      // Covers everything the user might remember about a design: codes,
      // names, designer, taxonomy, AND every "notes" field across the
      // design's structure:
      //   • Item.notes           — top-level design notes
      //   • ItemProcess.notes    — per-process notes ("casting weight
      //                            temporary" lives here)
      //   • ItemProcessVendor.notes — per-vendor instructions
      //   • ItemMaterial.notes   — BOM-line notes
      // Notes columns are TEXT (no index), but item counts are small
      // enough that full-table search is acceptable.
      const q = query.search;
      // `mode: 'insensitive'` — so "Krishna" and "krishna" both match.
      // Postgres `contains` defaults to case-sensitive without this flag.
      const like = { contains: q, mode: 'insensitive' as const };
      where.OR = [
        { sampleDesignCode: like },
        { itemNumber: like },
        { itemName: like },
        { category: like },
        { subcategory: like },
        { collection: like },
        { designerName: like },
        { designerShortName: like },
        { notes: like },
        { processes: { some: { notes: like } } },
        { processes: { some: { vendors: { some: { notes: like } } } } },
        { materials: { some: { notes: like } } },
      ];
    }

    const items = await this.prisma.item.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
        // _count drives the "no processes" / "no BOM" / "no sticking
        // colour" pending labels — cheap aggregate that avoids loading
        // the full relations just to check "is anything in there?".
        _count: { select: { processes: true, materials: true, colorModels: true } },
        // Pull JUST the Casting process + its weight attribute so we can
        // flag "no Casting weight" without re-fetching all processes.
        processes: {
          where: { process: { code: 'CASTING' } },
          include: { attributes: { where: { attrKey: 'weight' } } },
        },
      },
    });

    // Aggregate currently-open repair qty per item across every batch.
    // Open repairs live on castingBatchItem stages; the item link is on the
    // stage's `itemId`. We sum OPEN-status repair qty grouped by stage,
    // then collapse stage → itemId to get per-item totals. Lets the items
    // list show a "🔧 N at repair" badge so the user can spot designs
    // with quality issues without drilling into each batch.
    const openRepairs = await this.prisma.repairOrder.groupBy({
      by: ['stageId'],
      where: { status: 'OPEN' },
      _sum: { qty: true },
    });
    const repairByItem = new Map<number, number>();
    if (openRepairs.length) {
      const stages = await this.prisma.castingBatchItem.findMany({
        where: { id: { in: openRepairs.map((r) => r.stageId) } },
        select: { id: true, itemId: true },
      });
      const stageToItem = new Map(stages.map((s) => [s.id, s.itemId]));
      for (const r of openRepairs) {
        const itemId = stageToItem.get(r.stageId);
        if (!itemId) continue;
        repairByItem.set(itemId, (repairByItem.get(itemId) ?? 0) + (r._sum.qty ?? 0));
      }
    }

    return items.map((i) => {
      // Pending-details — short labels for master fields the operator
      // still needs to fill in. Drives the "Pending" column on the
      // Items list so operators can prioritise data completion. Order
      // matters — most-critical first so the chip strip reads sensibly
      // when it's truncated on narrow screens.
      const pending: string[] = [];
      if (!i.images[0]) pending.push('image');
      if (!i.itemNumber) pending.push('item no');
      if (!i.category) pending.push('category');
      if (!i.designerName && !i.designerShortName) pending.push('designer');
      if ((i as any)._count?.processes === 0) pending.push('processes');
      else {
        // Casting weight check — only fires when there IS a Casting
        // process row but its `weight` attribute is missing/blank.
        const casting = i.processes[0];
        const weightAttr = casting?.attributes.find((a) => a.attrKey === 'weight');
        const weightVal = weightAttr?.attrValue?.trim();
        if (casting && (!weightVal || weightVal === '0')) pending.push('casting wt');
      }
      if ((i as any)._count?.materials === 0) pending.push('BOM');
      // Sticking colour missing — surfaced separately from BOM because an
      // item can have material lines without any colour variant configured,
      // and the casting receive form blocks on this for STICKING stages.
      if ((i as any)._count?.colorModels === 0) pending.push('sticking colour');
      return {
        id: i.id,
        sampleDesignCode: i.sampleDesignCode,
        itemNumber: i.itemNumber,
        category: i.category,
        collection: i.collection,
        designType: i.designType,
        designerName: i.designerName,
        sellingPrice: i.sellingPrice ? Number(i.sellingPrice) : null,
        costPrice: i.costPrice ? Number(i.costPrice) : null,
        sampleStatus: i.sampleStatus,
        updatedAt: i.updatedAt,
        thumbUrl: i.images[0] ? `/uploads/${i.images[0].filePath}` : null,
        openRepairQty: repairByItem.get(i.id) ?? 0,
        pending,
      };
    });
  }

  /**
   * Minimal data shape for the printable Design Datasheet PDF. Returns just
   * what the layout needs — the photo path + the human identifiers shown
   * in the header — so the PDF generator doesn't have to know how to walk
   * the full Item shape.
   */
  async datasheetData(id: number) {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: {
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
      },
    });
    if (!item) throw new NotFoundException('Item not found.');
    return {
      itemNumber: item.itemNumber ?? null,
      sampleDesignCode: item.sampleDesignCode,
      designerName: item.designerName ?? null,
      category: item.category ?? null,
      subcategory: item.subcategory ?? null,
      collection: item.collection ?? null,
      imagePath: item.images[0]?.filePath ?? null,
    };
  }

  async findOne(id: number) {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: {
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        processes: {
          include: {
            process: true,
            attributes: true,
            vendors: { include: { vendor: true }, orderBy: { id: 'asc' } },
            photos: { where: { itemProcessVendorId: null } },
            services: { include: { service: true } },
          },
          orderBy: { process: { sortOrder: 'asc' } },
        },
        materials: { include: { variant: { include: { material: true, vendors: true } } } },
        colorModels: { include: { processColors: true }, orderBy: { sortOrder: 'asc' } },
        designParts: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        productionVariants: {
          orderBy: { variantIndex: 'asc' },
          select: {
            id: true, variantCode: true, variantIndex: true,
            birthWeight: true, state: true, currentStageId: true, createdAt: true,
          },
        },
      },
    });
    if (!item) throw new NotFoundException('Item not found.');

    // Colour codes reset PER PROCESS: each colour process letters its own colours
    // a/b/c → `{itemNumber}({letter})-{name}` (Plating(a) and Meena(a) are separate).
    const colourLetters = new Map<string, string>(); // `${itemProcessId}:${name}` -> letter
    for (const p of item.processes) {
      if (!COLOUR_PROCESSES.includes(p.process.code)) continue;
      let i = 0;
      for (const v of p.vendors) {
        const nm = (v.color ?? '').trim();
        if (!nm) continue;
        const key = `${p.id}:${nm.toLowerCase()}`;
        if (!colourLetters.has(key)) { colourLetters.set(key, String.fromCharCode(97 + i)); i++; }
      }
    }
    const colourCode = (itemProcessId: number, name?: string | null) => {
      const nm = (name ?? '').trim();
      const letter = nm ? colourLetters.get(`${itemProcessId}:${nm.toLowerCase()}`) : undefined;
      if (item.itemNumber == null || !letter) return null;
      return `${item.itemNumber}(${letter})-${nm}`;
    };

    return {
      ...item,
      designCost: item.designCost ? Number(item.designCost) : null,
      sellingPrice: item.sellingPrice ? Number(item.sellingPrice) : null,
      costPrice: item.costPrice ? Number(item.costPrice) : null,
      cadFileUrl: item.cadFilePath ? `/uploads/${item.cadFilePath}` : null,
      materials: item.materials.map((m) => {
        const defaultPrice = this.variantPrice(m.variant.vendors);
        // Per-line rate override (added when BOM was extended beyond Sticking).
        // When the user has not overridden, we expose the variant's preferred
        // supplier price as `price` so the UI can show "default ₹X" while
        // letting them type a custom value into the editable Rate cell.
        const rateOverride = m.rate != null ? Number(m.rate) : null;
        const effectiveRate = rateOverride ?? defaultPrice;
        const qty = Number(m.quantity);
        return {
          processId: m.processId ?? null,
          variantId: m.variantId,
          variantCode: m.variant.variantCode,
          variantName: m.variant.variantName,
          materialName: m.variant.material.materialName,
          size: m.variant.size,
          color: m.variant.color,
          stickingColor: m.color ?? null, // which sticking colour this BOM line is for
          unit: m.unit ?? m.variant.unit,
          quantity: qty,
          // `price` stays as the master price (used as fallback / default).
          // `rate` is the per-line override (null when using master price).
          // `effectiveRate` is what cost calc / slip rendering actually uses.
          price: defaultPrice,
          rate: rateOverride,
          effectiveRate,
          stockQty: Number(m.variant.stockQty),
          // Line cost now uses effective rate (the override when present).
          lineCost: Math.round(effectiveRate * qty * 100) / 100,
          notes: m.notes,
        };
      }),
      images: item.images.map((im) => ({
        id: im.id,
        filePath: im.filePath,
        url: `/uploads/${im.filePath}`,
        isPrimary: im.isPrimary,
      })),
      processes: item.processes.map((p) => ({
        itemProcessId: p.id,
        processId: p.processId,
        code: p.process.code,
        name: p.process.name,
        costUnit: costUnit(p.process.code),
        notes: p.notes,
        attributes: Object.fromEntries(p.attributes.map((a) => [a.attrKey, a.attrValue])),
        photos: p.photos.map((ph) => ({ id: ph.id, filePath: ph.filePath, url: `/uploads/${ph.filePath}` })),
        services: p.services.map((s) => ({
          serviceId: s.serviceId,
          name: s.service.name,
          cost: s.cost ? Number(s.cost) : null,
        })),
        vendors: p.vendors.map((v) => ({
          id: v.id,
          vendorId: v.vendorId,
          vendorCode: v.vendor.vendorCode,
          vendorName: v.vendor.vendorName,
          isInhouse: (v.vendor as any).isInhouse ?? false,
          vendorDesignReference: v.vendorDesignReference,
          color: v.color,
          colorPhotoPath: v.colorPhotoPath,
          colorPhotoUrl: v.colorPhotoPath ? `/uploads/${v.colorPhotoPath}` : null,
          colorCode: colourCode(p.id, v.color),
          costPerPiece: v.costPerPiece ? Number(v.costPerPiece) : null,
          isPreferred: v.isPreferred,
          bringsOwnMaterials: v.bringsOwnMaterials,
          notes: v.notes,
        })),
      })),
      colorModels: item.colorModels.map((cm) => ({
        id: cm.id,
        letter: cm.letter,
        name: cm.name,
        photoPath: cm.photoPath,
        photoUrl: cm.photoPath ? `/uploads/${cm.photoPath}` : null,
        costPrice: cm.costPrice != null ? Number(cm.costPrice) : null,
        sellingPrice: cm.sellingPrice != null ? Number(cm.sellingPrice) : null,
        processColors: cm.processColors.map((pc) => ({ processId: pc.processId, color: pc.color })),
      })),
      costBreakup: this.buildCostBreakup(item),
    };
  }

  /**
   * Itemised cost breakup: design + each process (labor + materials) where
   * applicable.
   *
   * Cost model per process:
   *   • CASTING / PLATING (KG processes): rate × stage weight (kg).
   *   • STICKING: vendor's per-pc rate is actually a per-STONE rate — total
   *     sticking labor = rate × Σ(BOM qty across sticking lines for the
   *     preferred colour). PLUS materials cost from the per-line rate
   *     override (or master price when not overridden).
   *   • FILING / KACHA_FITTING / FITTING_MALA (BOM-capable): labor (per-pc
   *     vendor rate) PLUS materials cost from the BOM lines for that process.
   *   • Other piece processes (CAM, DIE_NUMBER, POLISH, MAGNET, SAND_BLAST,
   *     MEENA, PACKING): per-pc labor only.
   *
   * Per-line rate override semantics:
   *   m.rate != null → use m.rate × qty for this BOM line.
   *   m.rate == null → fall back to the variant's preferred-supplier price.
   */
  private buildCostBreakup(item: any) {
    const lines: { label: string; amount: number; excludeFromTotal?: boolean }[] = [];
    const weightG = Number(
      item.processes.find((p: any) => p.process.code === 'CASTING')?.attributes
        ?.find?.((a: any) => a.attrKey === 'weight')?.attrValue ?? 0,
    ) || 0;
    const design = item.designCost ? Number(item.designCost) : 0;
    // Design cost is shown for reference only — it's a one-time amortised cost,
    // NOT added to the per-piece cost price.
    if (design) lines.push({ label: 'Design cost (informational — not in total)', amount: design, excludeFromTotal: true });

    // Materials cost helper: per BOM line, use override rate when set,
    // otherwise the variant's preferred-supplier price. Returns the rupee
    // sub-cost for the per-piece cost of the item.
    const lineCost = (m: any) => {
      const qty = Number(m.quantity);
      const override = m.rate != null ? Number(m.rate) : null;
      const price = override ?? this.variantPrice(m.variant.vendors);
      return price * qty;
    };

    // Resolve the Sticking process up-front — needed both for labor and to
    // pick the preferred-colour BOM lines.
    const stick = item.processes.find((p: any) => p.process.code === 'STICKING');
    const stickVendors = stick?.vendors ?? [];
    const prefStickVendor = stickVendors.find((v: any) => v.isPreferred) ?? stickVendors[0];
    const prefStickColour = (prefStickVendor?.color ?? '').trim().toLowerCase();
    const stickBringsOwn = !!prefStickVendor?.bringsOwnMaterials;
    const stickRatePerStone = prefStickVendor?.costPerPiece != null ? Number(prefStickVendor.costPerPiece) : 0;

    for (const p of item.processes) {
      const code = p.process.code;
      const svc = p.services.reduce((s: number, x: any) => s + (x.cost ? Number(x.cost) : 0), 0);
      const entries = p.vendors;
      const chosen = entries.find((e: any) => e.isPreferred) ?? entries.find((e: any) => e.costPerPiece != null) ?? entries[0];
      const rate = chosen?.costPerPiece != null ? Number(chosen.costPerPiece) : 0;

      // STICKING is special: the rate's semantic changes with the
      // brings-own-materials toggle:
      //   • toggle OFF → rate is per STONE stuck (labor only). Labor =
      //     rate × Σ(BOM qty across this colour). Materials block adds
      //     to the total separately.
      //   • toggle ON  → rate is per PIECE (flat-rate karigar contract).
      //     Labor = rate × 1. BOM materials are excluded entirely (the
      //     vendor's rate is presumed inclusive). Common for simple
      //     items where the vendor wants predictability.
      if (code === 'STICKING') {
        if (stickBringsOwn) {
          // Flat per-piece — no stone-count math.
          if (stickRatePerStone)
            lines.push({
              label: `Sticking labor (₹${stickRatePerStone}/pc · incl. materials${prefStickColour ? ` · ${prefStickColour}` : ''})`,
              amount: Math.round(stickRatePerStone * 100) / 100,
            });
        } else {
          // Per-stone — labor scales with the BOM qty for this colour.
          const lines4colour = (item.materials ?? []).filter(
            (m: any) =>
              (m.processId == null || m.processId === p.processId) &&
              (m.color ?? '').trim().toLowerCase() === prefStickColour,
          );
          const totalStones = lines4colour.reduce((s: number, m: any) => s + Number(m.quantity), 0);
          const stickLabor = stickRatePerStone * totalStones;
          if (stickLabor)
            lines.push({
              label: `Sticking labor (${stickRatePerStone}/stone × ${totalStones} stones${prefStickColour ? ` · ${prefStickColour}` : ''})`,
              amount: Math.round(stickLabor * 100) / 100,
            });
        }
      } else {
        const procCost = KG_PROCESSES.includes(code) ? weightG * rate : rate;
        if (procCost) lines.push({ label: `${p.process.name}${KG_PROCESSES.includes(code) ? ' (per kg)' : ''}`, amount: Math.round(procCost * 100) / 100 });
      }
      if (svc) lines.push({ label: `${p.process.name} — services`, amount: svc });
    }

    // Sticking materials — preferred-colour BOM lines, unless vendor brings own.
    if (!stickBringsOwn && stick) {
      let stickBom = 0;
      for (const m of (item.materials ?? []).filter(
        (m: any) =>
          (m.processId == null || m.processId === stick.processId) &&
          (m.color ?? '').trim().toLowerCase() === prefStickColour,
      )) {
        stickBom += lineCost(m);
      }
      if (stickBom) lines.push({ label: `Sticking materials${prefStickColour ? ` (${prefStickColour})` : ''}`, amount: Math.round(stickBom * 100) / 100 });
    }

    // Materials for Kacha Fitting / Fitting+Mala — shared BOM (no colour
    // filter). Each appears as its own line so the user can see where the
    // cost is going. Labor for these processes was already added above.
    // Filing / Polish use AD-HOC material issue (not BOM-driven), so
    // they don't appear in the design's cost breakup as materials.
    const EXTRA_BOM_CODES = ['KACHA_FITTING', 'FITTING_MALA'] as const;
    for (const code of EXTRA_BOM_CODES) {
      const proc = item.processes.find((p: any) => p.process.code === code);
      if (!proc) continue;
      let bom = 0;
      for (const m of (item.materials ?? []).filter(
        (m: any) => m.processId === proc.processId,
      )) {
        bom += lineCost(m);
      }
      if (bom) lines.push({ label: `${proc.process.name} materials`, amount: Math.round(bom * 100) / 100 });
    }

    const total = Math.round(lines.reduce((s, l) => s + (l.excludeFromTotal ? 0 : l.amount), 0) * 100) / 100;
    return { lines, total };
  }

  /**
   * Central cost recompute — the single source of truth for an item's cost price.
   * Reads the PERSISTED processes/vendors/attributes/materials and recomputes
   * costPrice from buildCostBreakup, so any path that mutates derived inputs
   * (item save, direct edits, batch colour changes, maintenance) can keep cost
   * correct by calling this instead of relying on a full-form save.
   */

  /**
   * Surgical "set just the rate" — used by the Undo button on the auto-rate-
   * sync toasts in the batch/forward flow. When vendorId is omitted, targets
   * the preferred vendor (or first if none preferred). Passing rate=null
   * clears the rate (sets it back to "no rate set" so the next batch will
   * prompt for it). Recomputes item.costPrice after the update so the
   * Item Master cost field reflects the change immediately.
   */
  async setProcessVendorRate(itemId: number, processId: number, vendorId: number | undefined, rate: number | null): Promise<{ updated: boolean; costPrice: number }> {
    const ip = await this.prisma.itemProcess.findUnique({
      where: { itemId_processId: { itemId, processId } },
      include: { vendors: true },
    });
    if (!ip) throw new NotFoundException('Process is not configured on this item.');
    const target =
      (vendorId ? ip.vendors.find((v) => v.vendorId === vendorId) : null) ??
      ip.vendors.find((v) => v.isPreferred) ??
      ip.vendors[0];
    if (!target) throw new NotFoundException('No vendor configured for this process.');
    await this.prisma.itemProcessVendor.update({
      where: { id: target.id },
      data: { costPerPiece: rate == null ? null : rate },
    });
    const costPrice = await this.recomputeItemCost(itemId);
    return { updated: true, costPrice };
  }

  async recomputeItemCost(id: number): Promise<number> {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: {
        processes: {
          include: { process: true, attributes: true, vendors: { include: { vendor: true } }, services: { include: { service: true } } },
          orderBy: { process: { sortOrder: 'asc' } },
        },
        // Materials now carry processId + per-line rate override (read by
        // buildCostBreakup to route Sticking vs Kacha/Fitting/Packing BOM
        // and to honour the per-line rate when present).
        materials: { include: { variant: { include: { vendors: true } } } },
      },
    });
    if (!item) throw new NotFoundException('Item not found.');
    const total = this.buildCostBreakup(item).total;
    await this.prisma.item.update({ where: { id }, data: { costPrice: total } });
    return total;
  }

  /** Recompute cost price for every item (maintenance / after bulk data changes). */
  async recomputeAllCosts(): Promise<{ updated: number }> {
    const ids = await this.prisma.item.findMany({ select: { id: true } });
    for (const { id } of ids) await this.recomputeItemCost(id);
    return { updated: ids.length };
  }

  async create(dto: UpsertItemDto, userId?: number) {
    // Friendly duplicate check (before hitting the DB constraint).
    if (dto.itemNumber) {
      const dup = await this.prisma.item.findUnique({ where: { itemNumber: dto.itemNumber } });
      if (dup) throw new BadRequestException(`Item number "${dto.itemNumber}" is already used by ${dup.sampleDesignCode}. Choose a unique number.`);
    }
    const sampleDesignCode = await this.generateDesignCode(dto.designerShortName);
    const item = await this.prisma.item.create({
      data: {
        sampleDesignCode,
        ...this.basicFields(dto),
        costPrice: 0, // set centrally below from persisted entities
        createdById: userId ?? null,
      },
    });
    await this.syncImages(item.id, dto.images);
    await this.syncProcesses(item.id, dto.processes ?? []);
    await this.syncMaterials(item.id, dto.materials ?? []);
    await this.syncColorModels(item.id, dto.colorModels ?? []);
    await this.syncDesignParts(item.id, dto.designParts ?? []);
    await this.recomputeItemCost(item.id); // single source of truth
    await this.logStatus(item.id, null, item.sampleStatus, userId);
    // Audit — full snapshot AFTER, no BEFORE (create). Not auto-undoable
    // for now: deleting an item we just created is doable, but its FKs
    // (batches that may already reference it, etc.) make it risky.
    const after = await this.findOne(item.id);
    await this.audit.log(userId, {
      action: 'items.create',
      targetType: 'Item',
      targetId: item.id,
      description: `Created item ${item.sampleDesignCode}${item.itemName ? ' · ' + item.itemName : ''}`,
      snapshotAfter: after,
    });
    return { id: item.id, sampleDesignCode };
  }

  async update(id: number, dto: UpsertItemDto, userId?: number) {
    const current = await this.prisma.item.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Item not found.');
    // Capture FULL before-state for the audit log. Same shape as findOne()
    // returns so the diff renders cleanly in the activity feed.
    const beforeSnapshot = await this.findOne(id);
    if (dto.itemNumber && dto.itemNumber !== current.itemNumber) {
      const dup = await this.prisma.item.findUnique({ where: { itemNumber: dto.itemNumber } });
      if (dup && dup.id !== id) throw new BadRequestException(`Item number "${dto.itemNumber}" is already used by ${dup.sampleDesignCode}. Choose a unique number.`);
    }

    // If the designer's short name changed, regenerate the sampleDesignCode
    // against the NEW prefix. The old code's prefix would silently mislead
    // (TVM-027 lingering on an ABC-designer item). Done before basicFields
    // is written so the update writes the new code in the same query.
    // Safe to rename — slips/PDFs never reference sampleDesignCode (they use
    // itemNumber + vendorDesignReference), and every internal join is by
    // numeric itemId (FK), not by code string.
    const normShort = (s: string | null | undefined) =>
      (s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const oldShort = normShort(current.designerShortName);
    const newShort = normShort(dto.designerShortName);
    let nextSampleDesignCode = current.sampleDesignCode;
    if (newShort && newShort !== oldShort) {
      nextSampleDesignCode = await this.generateDesignCode(dto.designerShortName);
    }

    await this.prisma.item.update({
      where: { id },
      data: { ...this.basicFields(dto), sampleDesignCode: nextSampleDesignCode },
    });
    await this.syncImages(id, dto.images);
    await this.syncProcesses(id, dto.processes ?? []);
    await this.syncMaterials(id, dto.materials ?? []);
    await this.syncColorModels(id, dto.colorModels ?? []);
    await this.syncDesignParts(id, dto.designParts ?? []);
    await this.recomputeItemCost(id); // recompute from persisted entities
    // Propagate the new vendor design refs from the item master down to
    // every CastingBatchItem snapshot that points at the same
    // (item, process, vendor, color) combo. Without this the slip PDFs and
    // batch detail UI keep showing the old ref until each batch is
    // manually edited. We deliberately overwrite — there's no per-stage
    // "custom" design ref concept in this app.
    await this.cascadeVendorDesignRefs(id);
    if (dto.sampleStatus && dto.sampleStatus !== current.sampleStatus) {
      await this.logStatus(id, current.sampleStatus, dto.sampleStatus, userId);
    }
    // Audit — full BEFORE and AFTER for clean diff rendering. Undoable
    // via the items.update strategy (reverts the item's basic fields).
    const afterSnapshot = await this.findOne(id);
    await this.audit.log(userId, {
      action: 'items.update',
      targetType: 'Item',
      targetId: id,
      description: `Updated item ${nextSampleDesignCode}${current.itemNumber ? ' #' + current.itemNumber : ''}`,
      snapshotBefore: beforeSnapshot,
      snapshotAfter: afterSnapshot,
      undoStrategy: 'items.update',
    });
    return { id, sampleDesignCode: nextSampleDesignCode };
  }

  /**
   * Push the current ItemProcessVendor.vendorDesignReference values down to
   * every CastingBatchItem snapshot for this item, so slip PDFs and the
   * batch detail UI always show the latest ref. Matched on
   * (itemId, processId, vendorId, color). Empty IPV refs are SKIPPED — we
   * don't want to wipe out a previously-set ref by accident when the user
   * leaves the field blank in the master.
   */
  private async cascadeVendorDesignRefs(itemId: number) {
    const ipvs = await this.prisma.itemProcessVendor.findMany({
      where: { itemProcess: { itemId } },
      include: { itemProcess: true },
    });
    for (const ipv of ipvs) {
      if (!ipv.vendorDesignReference) continue;
      await this.prisma.castingBatchItem.updateMany({
        where: {
          itemId,
          processId: ipv.itemProcess.processId,
          vendorId: ipv.vendorId,
          color: ipv.color,
        },
        data: { vendorDesignReference: ipv.vendorDesignReference },
      });
    }
  }

  /**
   * Material cost for the item's cost price. BOM is per sticking-colour, so we use
   * the PREFERRED sticking colour's BOM (the ★ colour) as the representative cost.
   */
  private async syncMaterials(itemId: number, materials: NonNullable<UpsertItemDto['materials']>) {
    const filtered = materials.filter((m) => m.variantId > 0);

    // Default unspecified processId to STICKING for back-compat with older
    // clients that still POST Sticking-only payloads. New clients always send
    // an explicit processId (Sticking / Kacha Fitting / Fitting / Packing).
    const sticking = await this.prisma.process.findUnique({ where: { code: 'STICKING' } });
    const stickingId = sticking?.id ?? null;

    // BOM dedupe now keys on (processId, variantId, color). Same variant on
    // BOTH Sticking AND Fitting is fine (different processes). Same variant
    // on same process+colour is always a mistake — material issues would
    // double-debit stock. For non-Sticking processes color is null so the
    // dedupe collapses to (processId, variantId).
    const seenMC = new Map<string, number>();
    for (const m of filtered) {
      const procId = m.processId ?? stickingId;
      const key = `${procId ?? 'null'}|${m.variantId}|${(m.color ?? '').trim().toLowerCase()}`;
      if (seenMC.has(key)) {
        const variant = await this.prisma.materialVariant.findUnique({
          where: { id: m.variantId },
          include: { material: { select: { materialName: true } } },
        });
        const procName = procId
          ? (await this.prisma.process.findUnique({ where: { id: procId }, select: { name: true } }))?.name ?? 'BOM'
          : 'BOM';
        throw new BadRequestException(
          `Material "${variant?.material.materialName ?? ''} — ${variant?.variantName ?? m.variantId}" appears twice in the ${procName} BOM${m.color ? ` for colour "${m.color}"` : ''}. Remove the duplicate row.`,
        );
      }
      seenMC.set(key, 1);
    }

    await this.prisma.itemMaterial.deleteMany({ where: { itemId } });
    const rows = filtered.map((m) => ({
      itemId,
      processId: m.processId ?? stickingId,
      variantId: m.variantId,
      color: m.color ?? null,
      quantity: m.quantity ?? 0,
      wastagePercent: m.wastagePercent ?? 0,
      unit: m.unit ?? null,
      rate: m.rate != null ? new Prisma.Decimal(m.rate) : null,
      notes: m.notes ?? null,
    }));
    if (rows.length) await this.prisma.itemMaterial.createMany({ data: rows });
  }

  /** Replace an item's colour models (+ per-process colours). */
  private async syncColorModels(itemId: number, models: NonNullable<UpsertItemDto['colorModels']>) {
    await this.prisma.itemColorModel.deleteMany({ where: { itemId } });
    let order = 0;
    for (const m of models) {
      if (!m.name || !m.name.trim()) continue;
      const letter = (m.letter && m.letter.trim()) || String.fromCharCode(97 + order); // a, b, c…
      await this.prisma.itemColorModel.create({
        data: {
          itemId,
          letter,
          name: m.name.trim(),
          photoPath: m.photoPath ?? null,
          costPrice: m.costPrice ?? null,
          sellingPrice: m.sellingPrice ?? null,
          sortOrder: order,
          processColors: {
            create: (m.processColors ?? [])
              .filter((pc) => pc.processId > 0 && pc.color && pc.color.trim())
              .map((pc) => ({ processId: pc.processId, color: pc.color.trim() })),
          },
        },
      });
      order++;
    }
  }

  async remove(id: number, userId?: number) {
    const before = await this.findOne(id).catch(() => {
      throw new NotFoundException('Item not found.');
    });
    await this.prisma.item.delete({ where: { id } });
    // Audit — record the deletion with the full snapshot so an operator
    // can SEE what was lost. Not auto-undoable for now: restoring an
    // item with the same id is fragile when FKs (batches etc.) cascaded
    // away on delete. Listed in the timeline for traceability.
    await this.audit.log(userId, {
      action: 'items.delete',
      targetType: 'Item',
      targetId: id,
      description: `Deleted item ${before.sampleDesignCode}${before.itemName ? ' · ' + before.itemName : ''}`,
      snapshotBefore: before,
    });
    return { id };
  }

  async deleteImage(itemId: number, imageId: number, userId?: number) {
    // Grab the image row BEFORE delete so the undo handler can recreate it.
    const before = await this.prisma.itemImage.findFirst({ where: { id: imageId, itemId } });
    await this.prisma.itemImage.deleteMany({ where: { id: imageId, itemId } });
    if (before) {
      await this.audit.log(userId, {
        action: 'items.image.delete',
        targetType: 'ItemImage',
        targetId: imageId,
        description: `Removed image from item #${itemId}`,
        snapshotBefore: before,
        undoStrategy: 'items.image.delete',
      });
    }
    return { id: imageId };
  }

  // ---- helpers ----
  private async generateDesignCode(shortName?: string): Promise<string> {
    const prefix = (shortName?.trim() || 'GEN').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'GEN';
    const last = await this.prisma.item.findFirst({
      where: { sampleDesignCode: { startsWith: `${prefix}-` } },
      orderBy: { sampleDesignCode: 'desc' },
      select: { sampleDesignCode: true },
    });
    let n = 1;
    if (last) {
      const tail = parseInt(last.sampleDesignCode.split('-')[1] ?? '0', 10);
      if (!Number.isNaN(tail)) n = tail + 1;
    }
    return `${prefix}-${String(n).padStart(3, '0')}`;
  }

  /**
   * Auto cost price = design cost
   *   + Σ services cost
   *   + Σ (per process: preferred entry rate; KG processes → weight(kg) × cost/kg,
   *        piece processes → cost/piece). Weight comes from Casting's weight attribute (grams).
   */
  private basicFields(dto: UpsertItemDto) {
    return {
      itemNumber: dto.itemNumber ?? null,
      category: dto.category ?? null,
      subcategory: dto.subcategory ?? null,
      collection: dto.collection ?? null,
      notes: dto.notes ?? null,
      designType: dto.designType ?? null,
      designerName: dto.designerName ?? null,
      designerShortName: dto.designerShortName ?? null,
      designCost: dto.designCost ?? null,
      sellingPrice: dto.sellingPrice ?? null,
      cadFilePath: dto.cadFilePath ?? undefined,
      sampleStatus: dto.sampleStatus ?? 'DRAFT',
      bifurcationEnabled: dto.bifurcationEnabled ?? undefined,
    };
  }

  /**
   * Reconcile design parts (pendant + earring + patti, etc.) for an item.
   * Replace strategy — wipe and rewrite. Existing rows have no downstream
   * FKs so this is safe.
   */
  private async syncDesignParts(
    itemId: number,
    parts: { partName: string; qtyPerSet: number; weightPerPc: number; photoPath?: string; sortOrder?: number; notes?: string }[],
  ) {
    await this.prisma.itemDesignPart.deleteMany({ where: { itemId } });
    if (!parts.length) return;
    await this.prisma.itemDesignPart.createMany({
      data: parts.map((p, i) => ({
        itemId,
        partName: p.partName.trim(),
        qtyPerSet: Math.max(1, Math.trunc(p.qtyPerSet)),
        weightPerPc: p.weightPerPc,
        photoPath: p.photoPath ?? null,
        sortOrder: p.sortOrder ?? i,
        notes: p.notes ?? null,
      })),
    });
  }

  /**
   * Suggest the next unused ABN-NNNN. Pads to 4 digits; if more than 9999
   * have been allocated, jumps to 5+ digits naturally.
   */
  async nextItemNumber() {
    const rows = await this.prisma.item.findMany({
      where: { itemNumber: { startsWith: 'ABN-' } },
      select: { itemNumber: true },
    });
    let max = 0;
    for (const r of rows) {
      const m = (r.itemNumber ?? '').match(/^ABN-(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const next = `ABN-${String(max + 1).padStart(4, '0')}`;
    return { itemNumber: next };
  }

  /**
   * Allocate the sales item number for a design. Gated:
   *   1. Item must exist and not already have an itemNumber.
   *   2. At least one Packing receipt must exist for the design (the
   *      operator is finalising "first packed lot ready for sale").
   *   3. The submitted number must not already be in use.
   * Operator can override the suggestion with any free alphanumeric.
   */
  async allocateItemNumber(itemId: number, itemNumber: string, userId?: number) {
    const item = await this.prisma.item.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found.');
    if (item.itemNumber) {
      throw new BadRequestException(`This design already has item number ${item.itemNumber}.`);
    }
    const trimmed = itemNumber.trim();
    if (!trimmed) throw new BadRequestException('Item number cannot be empty.');

    const dup = await this.prisma.item.findUnique({ where: { itemNumber: trimmed } });
    if (dup) throw new BadRequestException(`Item number "${trimmed}" is already used by ${dup.sampleDesignCode}.`);

    // Packing-receipt gate — there must be at least one accepted receipt on
    // a PACKING stage for this item.
    const packingReceipts = await this.prisma.castingReceiptItem.count({
      where: {
        batchItem: { itemId, stageProcess: { code: 'PACKING' } },
        acceptedQty: { gt: 0 },
      },
    });
    if (packingReceipts === 0) {
      throw new BadRequestException(
        'Allocate is only available after the first Packing receipt is recorded for this design.',
      );
    }

    const beforeSnapshot = await this.findOne(itemId);
    await this.prisma.item.update({
      where: { id: itemId },
      data: {
        itemNumber: trimmed,
        itemNumberAllocatedAt: new Date(),
        itemNumberAllocatedById: userId ?? null,
      },
    });
    const afterSnapshot = await this.findOne(itemId);
    await this.audit.log(userId, {
      action: 'items.allocate-item-number',
      targetType: 'Item',
      targetId: itemId,
      description: `Allocated item number ${trimmed} to ${item.sampleDesignCode}`,
      snapshotBefore: beforeSnapshot,
      snapshotAfter: afterSnapshot,
    });
    return { id: itemId, itemNumber: trimmed };
  }

  /**
   * Missing parts for a design — both open (recast not started) and
   * already-recast (links to the new batch row). The detail page banners
   * the open count; the history list shows all of them for traceability.
   */
  async listMissingParts(itemId: number) {
    const rows = await this.prisma.missingPart.findMany({
      where: { itemId },
      orderBy: [{ recastAt: 'asc' }, { reportedAt: 'desc' }],
      include: {
        stage: {
          select: {
            id: true,
            batchId: true,
            batch: { select: { batchNumber: true } },
            stageProcess: { select: { code: true, name: true } },
          },
        },
        recastBatchItem: {
          select: {
            id: true,
            batchId: true,
            batch: { select: { batchNumber: true } },
          },
        },
        reportedBy: { select: { username: true, fullName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      partName: r.partName,
      qtyMissing: r.qtyMissing,
      weightMissing: r.weightMissing != null ? Number(r.weightMissing) : null,
      reportedAt: r.reportedAt,
      reportedBy: r.reportedBy?.fullName ?? r.reportedBy?.username ?? null,
      notes: r.notes,
      sourceStageId: r.stageId,
      sourceBatchNumber: r.stage?.batch?.batchNumber ?? null,
      sourceProcessName: r.stage?.stageProcess?.name ?? null,
      recastBatchItemId: r.recastBatchItemId,
      recastBatchNumber: r.recastBatchItem?.batch?.batchNumber ?? null,
      recastAt: r.recastAt,
      isOpen: !r.recastBatchItemId,
    }));
  }

  /**
   * Bundle the picked open MissingPart rows into a fresh Casting batch.
   * One row per part — qty = sum of qtyMissing for that part across
   * picked records. Each consumed MissingPart's recastBatchItemId is
   * backfilled to the matching new stage so traceability lights up.
   *
   * Guards:
   *   - Vendor must support CASTING.
   *   - Picked ids must all belong to this item AND be open (no
   *     recastBatchItemId).
   */
  async recastMissingParts(
    itemId: number,
    body: { vendorId: number; missingPartIds: number[]; castingDate?: string; notes?: string },
    userId?: number,
  ) {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      include: { designParts: true },
    });
    if (!item) throw new NotFoundException('Item not found.');
    if (!body.missingPartIds?.length) {
      throw new BadRequestException('Pick at least one missing-part record to recast.');
    }
    const missing = await this.prisma.missingPart.findMany({
      where: { id: { in: body.missingPartIds }, itemId, recastBatchItemId: null },
    });
    if (missing.length !== body.missingPartIds.length) {
      throw new BadRequestException(
        'Some picked records are not open (already recast) or do not belong to this design.',
      );
    }

    const casting = await this.prisma.process.findFirst({ where: { code: 'CASTING' } });
    if (!casting) throw new NotFoundException('Casting process is not configured.');
    const vendor = await this.prisma.vendor.findUnique({ where: { id: body.vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found.');

    // Roll missing-part records up by partName so the new batch carries
    // one row per part (qty = sum across picked records for that part).
    const byPart = new Map<string, { qty: number; weight: number; partMeta?: any; missingIds: number[] }>();
    for (const m of missing) {
      const key = m.partName.trim();
      const cur = byPart.get(key) ?? { qty: 0, weight: 0, missingIds: [] };
      cur.qty += m.qtyMissing;
      cur.weight += Number(m.weightMissing ?? 0);
      cur.partMeta = item.designParts.find(
        (d) => d.partName.trim().toLowerCase() === key.toLowerCase(),
      );
      cur.missingIds.push(m.id);
      byPart.set(key, cur);
    }

    const batchNumber = await this.nextBatchNumber();
    const castingDate = body.castingDate ? new Date(body.castingDate) : new Date();
    const itemNumber = item.itemNumber ?? item.sampleDesignCode;

    // One transaction: create the batch + one row per part + backfill
    // each MissingPart's recastBatchItemId. Fails atomically so a half-
    // created batch never leaves dangling records.
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.castingBatch.create({
        data: {
          batchNumber,
          batchDate: castingDate,
          processId: casting.id,
          notes: body.notes ?? `Recast for missing parts of ${item.sampleDesignCode}`,
          createdById: userId ?? null,
        },
      });
      const createdRows: { id: number; partName: string }[] = [];
      let sortOrder = 0;
      for (const [partName, info] of byPart) {
        const perPc = info.partMeta?.weightPerPc != null ? Number(info.partMeta.weightPerPc) : 0;
        const totalWt = Math.round(perPc * info.qty * 1000) / 1000;
        const row = await tx.castingBatchItem.create({
          data: {
            batchId: batch.id,
            itemId,
            itemNumber,
            itemName: item.itemName ? `${item.itemName} — ${partName}` : partName,
            vendorId: body.vendorId,
            weight: perPc,
            quantity: info.qty,
            totalWeight: totalWt,
            processId: casting.id,
            sortOrder: sortOrder++,
            remarks: `Recast — missing ${partName} from earlier batch`,
          },
        });
        for (const mid of info.missingIds) {
          await tx.missingPart.update({
            where: { id: mid },
            data: { recastBatchItemId: row.id, recastAt: new Date() },
          });
        }
        createdRows.push({ id: row.id, partName });
      }
      await this.audit.log(userId, {
        action: 'items.recast-missing-parts',
        targetType: 'Item',
        targetId: itemId,
        description: `Recast batch ${batchNumber} for ${createdRows.length} missing part${createdRows.length === 1 ? '' : 's'} of ${item.sampleDesignCode}`,
        snapshotAfter: { batchNumber, rows: createdRows },
      });
      return { batchId: batch.id, batchNumber, rows: createdRows };
    });
  }

  /** Helper: peek the next Casting batch number without creating. */
  private async nextBatchNumber(): Promise<string> {
    const last = await this.prisma.castingBatch.findFirst({
      orderBy: { batchNumber: 'desc' },
      where: { batchNumber: { startsWith: 'B' } },
      select: { batchNumber: true },
    });
    const seq = last ? parseInt(last.batchNumber.replace(/\D/g, ''), 10) || 0 : 0;
    return `B${String(seq + 1).padStart(4, '0')}`;
  }

  private async syncImages(itemId: number, images?: string[]) {
    if (!images) return;
    const existing = await this.prisma.itemImage.findMany({ where: { itemId } });
    const existingPaths = new Set(existing.map((e) => e.filePath));
    let hasPrimary = existing.some((e) => e.isPrimary);
    let order = existing.length;
    for (const path of images) {
      if (existingPaths.has(path)) continue;
      await this.prisma.itemImage.create({
        data: { itemId, filePath: path, isPrimary: !hasPrimary, sortOrder: order++ },
      });
      hasPrimary = true;
    }
  }

  private async syncProcesses(itemId: number, processes: ItemProcessDto[]) {
    for (const proc of processes) {
      if (!proc.processId) continue;

      const attrs = Object.entries(proc.attributes ?? {}).filter(
        ([, v]) => v != null && String(v).trim() !== '',
      );
      const vendors = (proc.vendors ?? []).filter((v) => v.vendorId > 0);
      const services = (proc.services ?? []).filter((s) => s.serviceId > 0);
      const processPhotos = (proc.photos ?? []).filter(Boolean);

      // The schema allows the same vendor multiple times per process (so the
      // same karigar can do red + green + blue meena under different rows),
      // but it does NOT allow two rows with the SAME vendor AND SAME colour.
      // Without this guard, the form's "+ Add Vendor" could silently double-
      // book the same vendor/colour pair, which then ships two slips to the
      // same vendor for the same colour. Block at submit time with a clear
      // message naming the offending vendor.
      const seenVK = new Map<string, number>();
      for (const v of vendors) {
        const key = `${v.vendorId}|${(v.color ?? '').trim().toLowerCase()}`;
        const prev = seenVK.get(key);
        if (prev != null) {
          const vendor = await this.prisma.vendor.findUnique({
            where: { id: v.vendorId },
            select: { vendorCode: true, vendorName: true },
          });
          const processName = (await this.prisma.process.findUnique({
            where: { id: proc.processId },
            select: { name: true },
          }))?.name ?? `process ${proc.processId}`;
          throw new BadRequestException(
            `${processName}: vendor "${vendor?.vendorName ?? v.vendorId}" is added twice${v.color ? ` for colour "${v.color}"` : ''}. Remove the duplicate row.`,
          );
        }
        seenVK.set(key, 1);
      }
      // Historical behaviour deleted the row when every sub-field was
      // empty, which silently erased operator intent (adding CAM to a
      // design's process list did nothing unless the operator also
      // filled in a vendor / weight / etc.). Presence in the payload IS
      // the intent — upsert unconditionally, let the sub-blocks below
      // replace vendors / attributes / services / photos to whatever
      // the DTO carries (possibly nothing, which is fine).
      const ip = await this.prisma.itemProcess.upsert({
        where: { itemId_processId: { itemId, processId: proc.processId } },
        update: { notes: proc.notes ?? null },
        create: { itemId, processId: proc.processId, notes: proc.notes ?? null },
      });

      // Attributes (replace)
      await this.prisma.itemProcessAttribute.deleteMany({ where: { itemProcessId: ip.id } });
      if (attrs.length) {
        await this.prisma.itemProcessAttribute.createMany({
          data: attrs.map(([k, v]) => ({
            itemProcessId: ip.id,
            attrKey: k.toLowerCase().replace(/[^a-z0-9_]/g, ''),
            attrValue: String(v),
          })),
        });
      }

      // Vendor / colour entries (replace). Photos live only at process level now.
      await this.prisma.itemProcessVendor.deleteMany({ where: { itemProcessId: ip.id } });
      if (vendors.length) {
        await this.prisma.itemProcessVendor.createMany({
          data: vendors.map((v) => ({
            itemProcessId: ip.id,
            vendorId: v.vendorId,
            vendorDesignReference: v.vendorDesignReference ?? null,
            color: v.color ?? null,
            colorPhotoPath: v.colorPhotoPath ?? null,
            costPerPiece: v.costPerPiece ?? null,
            isPreferred: v.isPreferred ?? false,
            bringsOwnMaterials: v.bringsOwnMaterials ?? false,
            notes: v.notes ?? null,
          })),
        });
      }

      // Services (replace)
      await this.prisma.itemProcessService.deleteMany({ where: { itemProcessId: ip.id } });
      if (services.length) {
        await this.prisma.itemProcessService.createMany({
          data: services.map((s) => ({
            itemProcessId: ip.id,
            serviceId: s.serviceId,
            cost: s.cost ?? null,
          })),
        });
      }

      // Process-level photos (replace)
      await this.prisma.processPhoto.deleteMany({
        where: { itemProcessId: ip.id, itemProcessVendorId: null },
      });
      if (processPhotos.length) {
        await this.prisma.processPhoto.createMany({
          data: processPhotos.map((filePath) => ({ itemProcessId: ip.id, filePath })),
        });
      }
    }
  }

  private async logStatus(recordId: number, oldStatus: string | null, newStatus: string, userId?: number) {
    await this.prisma.statusHistory.create({
      data: { module: 'items', recordId, oldStatus, newStatus, changedById: userId ?? null },
    });
  }
}
