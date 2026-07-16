import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Process-specific attribute schema (EAV). Used by the Item Master form.
export const PROCESS_ATTRIBUTES: Record<
  string,
  { key: string; label: string }[]
> = {
  CASTING: [
    { key: 'weight', label: 'Weight Per Piece (g)' },
    { key: 'metal_type', label: 'Metal Type' },
  ],
};

// Processes whose entries carry a colour (each colour row = a colour + vendor + photo).
export const COLOUR_PROCESSES = ['PLATING', 'MEENA', 'FITTING_MALA', 'STICKING'];

// Colour-capable processes for COLOUR MODELS — a model records the colour used
// at each of these steps (they can differ per step). Plating has many colours too.
export const COLOR_MODEL_PROCESSES = ['PLATING', 'MEENA', 'FITTING_MALA', 'STICKING'];

// Cost basis per process. KG → cost is per kilogram (total = weight × cost/kg).
// PIECE → cost is per piece. CAM is the new first process (CAD file lives
// in Basic Info now, not as a costed step) and is per-gram priced like
// Casting and Plating.
export const KG_PROCESSES = ['CAM', 'CASTING', 'PLATING'];
export function costUnit(code: string): 'KG' | 'PIECE' {
  return KG_PROCESSES.includes(code) ? 'KG' : 'PIECE';
}

// Processes that support optional services in the item master (e.g. Casting).
export const SERVICE_PROCESSES = ['CASTING'];

// Processes used only at batch time, not in the Item Master blueprint.
// Empty by default — every process is now configurable per design (vendor,
// rate, colour, services) in the Item Master. Add a code here if a future
// process should stay off the blueprint and only appear at batch-creation.
export const BATCH_ONLY_PROCESSES: string[] = [];

// Supplier roles — NOT manufacturing steps. A vendor tagged with these
// supplies raw materials (silver / stones / moti) but never appears in
// the production/batch flow. The vendor master shows them as suppliers
// so they can be picked on Raw Materials purchases.
export const SUPPLIER_PROCESSES = ['RAW_MATERIAL_SUPPLIER'];

// Designer roles — NOT manufacturing steps. A vendor tagged with CAD is
// a DESIGNER (creates the CAD file / renders) and shows up in the Item
// Master's "Designer" picker, but never appears as a batch stage. Kept
// separate from CAM (which IS a production step — mould-making, per gram).
export const DESIGNER_PROCESSES = ['CAD'];

@Injectable()
export class ProcessesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const processes = await this.prisma.process.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
    });
    return processes.map((p) => ({
      ...p,
      attributes: PROCESS_ATTRIBUTES[p.code] ?? [],
      usesColor: COLOUR_PROCESSES.includes(p.code),
      costUnit: costUnit(p.code),
      usesServices: SERVICE_PROCESSES.includes(p.code),
      batchOnly: BATCH_ONLY_PROCESSES.includes(p.code),
      isSupplier: SUPPLIER_PROCESSES.includes(p.code),
    }));
  }

  /** Add a new service to the shared services master (e.g. a new Casting service). */
  async createService(body: { name: string; appliesTo?: string }) {
    const name = body.name.trim();
    const base =
      (name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'SVC');
    let code = base;
    let n = 1;
    while (await this.prisma.processService.findUnique({ where: { code } })) {
      code = `${base}_${++n}`;
    }
    const svc = await this.prisma.processService.create({
      data: { code, name, appliesTo: body.appliesTo ?? null, status: 'ACTIVE' },
    });
    return { id: svc.id, code: svc.code, name: svc.name, appliesTo: svc.appliesTo };
  }

  /** Process Master CRUD — operator can add bespoke processes (e.g. ENGRAVING)
   *  beyond the seeded silver chain. */
  async createProcess(body: {
    name: string;
    code?: string;
    sortOrder?: number;
    isCosted?: boolean;
    bomCapable?: boolean;
    bifurcates?: boolean;
    requiresShortName?: boolean;
  }) {
    const name = body.name.trim();
    if (!name) throw new Error('Process name is required.');
    const base = body.code?.trim().toUpperCase()
      || (name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'PROC');
    let code = base;
    let n = 1;
    while (await this.prisma.process.findUnique({ where: { code } })) {
      code = `${base}_${++n}`;
    }
    const next = await this.prisma.process.aggregate({ _max: { sortOrder: true } });
    const created = await this.prisma.process.create({
      data: {
        code,
        name,
        sortOrder: body.sortOrder ?? (Number(next._max.sortOrder ?? 0) + 1),
        isCosted: body.isCosted ?? true,
        bomCapable: body.bomCapable ?? false,
        bifurcates: body.bifurcates ?? false,
        requiresShortName: body.requiresShortName ?? false,
        status: 'ACTIVE',
      },
    });
    return created;
  }

  async updateProcess(id: number, body: {
    name?: string;
    sortOrder?: number;
    isCosted?: boolean;
    bomCapable?: boolean;
    bifurcates?: boolean;
    requiresShortName?: boolean;
    status?: 'ACTIVE' | 'INACTIVE';
  }) {
    return this.prisma.process.update({
      where: { id },
      data: {
        ...(body.name != null ? { name: body.name.trim() } : {}),
        ...(body.sortOrder != null ? { sortOrder: body.sortOrder } : {}),
        ...(body.isCosted != null ? { isCosted: body.isCosted } : {}),
        ...(body.bomCapable != null ? { bomCapable: body.bomCapable } : {}),
        ...(body.bifurcates != null ? { bifurcates: body.bifurcates } : {}),
        ...(body.requiresShortName != null ? { requiresShortName: body.requiresShortName } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });
  }

  async deleteProcess(id: number) {
    // Soft-delete: deactivate so any historical batch rows keep their FK.
    // Hard delete only if nothing references it.
    const refs = await this.prisma.castingBatchItem.count({ where: { processId: id } });
    if (refs > 0) {
      return this.prisma.process.update({ where: { id }, data: { status: 'INACTIVE' } });
    }
    return this.prisma.process.delete({ where: { id } });
  }
}
