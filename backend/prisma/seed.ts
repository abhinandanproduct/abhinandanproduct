import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

// =============================================================
//  Shree Abhinandan Product — base seed
//  - Admin user
//  - Process master (13 silver-chain stages)
//  - Material categories (Silver/Metal, Stone, Moti + others)
//  - Optional ProcessService rows
//  - Dispatch + storage warehouses
//
//  Vendor / item / batch seeding lives in seed-demo-*.ts and is NOT run
//  in production. This file is idempotent and safe to re-run anytime.
// =============================================================

const prisma = new PrismaClient();

async function main() {
  // --- Admin user ---
  const passwordHash = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@abhinandan.local',
      passwordHash,
      fullName: 'System Administrator',
      role: UserRole.ADMIN,
    },
  });

  // --- Process master (silver chain) ---
  // Order is the DEFAULT display ordering — actual route per design is
  // declared via ItemProcess rows and can skip / reorder steps.
  //   bomCapable: process consumes raw materials via the design's BOM
  //   bifurcates: receipt at this process splits group into per-piece variants
  const processes = [
    // CAD is a VENDOR CATEGORY (designer role) — not a production step.
    // Kept in the master so vendors can be tagged as CAD/designers and
    // appear in the Item Master's "Designer" picker. Filtered out of
    // production/batch flows via DESIGNER_PROCESSES in processes.service.
    { code: 'CAD',            name: 'CAD',            sortOrder: 0,  bomCapable: false, bifurcates: false },
    { code: 'CAM',            name: 'CAM',            sortOrder: 1,  bomCapable: false, bifurcates: false },
    { code: 'CASTING',        name: 'Casting',        sortOrder: 2,  bomCapable: false, bifurcates: false },
    { code: 'DIE_NUMBER',     name: 'Die Number',     sortOrder: 3,  bomCapable: false, bifurcates: false },
    // Filing & Polish use AD-HOC material issue (operator picks materials
    // at forward time, no Item Master BOM) — so bomCapable stays false to
    // skip the auto-issue / BOM-snapshot path. The Forward dialog's
    // "Issue materials with this forward" picker handles them.
    { code: 'FILING',         name: 'Filing',         sortOrder: 4,  bomCapable: false, bifurcates: false },
    { code: 'POLISH',         name: 'Polish',         sortOrder: 5,  bomCapable: false, bifurcates: false },
    { code: 'KACHA_FITTING',  name: 'Kacha Fitting',  sortOrder: 6,  bomCapable: true,  bifurcates: false },
    { code: 'MAGNET',         name: 'Magnet',         sortOrder: 7,  bomCapable: false, bifurcates: false },
    { code: 'SAND_BLAST',     name: 'Sand Blast',     sortOrder: 8,  bomCapable: false, bifurcates: false },
    { code: 'PLATING',        name: 'Plating',        sortOrder: 9,  bomCapable: false, bifurcates: true  },
    { code: 'MEENA',          name: 'Meena',          sortOrder: 10, bomCapable: false, bifurcates: false },
    { code: 'FITTING_MALA',   name: 'Fitting + Mala', sortOrder: 11, bomCapable: true,  bifurcates: false },
    { code: 'STICKING',       name: 'Sticking',       sortOrder: 12, bomCapable: true,  bifurcates: false },
    { code: 'PACKING',        name: 'Packing',        sortOrder: 13, bomCapable: false, bifurcates: false },
    // Supplier role (not a manufacturing stage) — feeds raw materials.
    // Kept in the master so vendors can be tagged with it; filtered out
    // of production flows via SUPPLIER_PROCESSES in processes.service.ts.
    { code: 'RAW_MATERIAL_SUPPLIER', name: 'Raw Material Supplier', sortOrder: 99, bomCapable: false, bifurcates: false },
  ];
  for (const p of processes) {
    await prisma.process.upsert({
      where: { code: p.code },
      update: {
        name: p.name,
        sortOrder: p.sortOrder,
        bomCapable: p.bomCapable,
        bifurcates: p.bifurcates,
        status: 'ACTIVE',
      },
      create: { ...p, status: 'ACTIVE' },
    });
  }

  // --- Retire legacy Pratik process codes that don't exist in the silver chain ---
  // Deactivate (don't delete) so historical batch/item rows remain valid.
  const retiredCodes = [
    // CAD is NOT retired — it's a designer vendor-category (see the
    // process list above). DESIGN_CAD / CAD_DESIGN were legacy aliases
    // that DO stay retired.
    'DESIGN_CAD',            // replaced by CAM / CAD split
    'CAD_DESIGN',            // replaced by CAM / CAD split
    'KACHU_FITTING',         // renamed to KACHA_FITTING
    'FITTING',               // merged into FITTING_MALA
    'MALA',                  // merged into FITTING_MALA
    'ANTIQUE',               // not in silver chain
    'FINISHING',             // legacy
  ];
  for (const code of retiredCodes) {
    const existing = await prisma.process.findUnique({ where: { code } });
    if (!existing) continue;
    await prisma.process.update({
      where: { id: existing.id },
      data: { status: 'INACTIVE' },
    });
  }

  // --- Optional process services (extensible) ---
  const services = [
    { code: 'SOLDERING',   name: 'Soldering', appliesTo: 'CASTING' },
    { code: 'FITTING_SVC', name: 'Fitting',   appliesTo: 'CASTING' },
  ];
  for (const s of services) {
    await prisma.processService.upsert({
      where: { code: s.code },
      update: { name: s.name, appliesTo: s.appliesTo, status: 'ACTIVE' },
      create: { ...s, status: 'ACTIVE' },
    });
  }

  // --- Material categories ---
  // Silver / Stone / Moti are the three core silver-ERP categories; the
  // others cover findings, chains, packaging the BOM also draws from.
  const categories = [
    'Silver / Metal',
    'Stone',
    'Moti',
    'Hooks',
    'Chains',
    'Beads',
    'Meena Colors',
    'Metal Parts',
    'Packaging',
  ];
  for (const name of categories) {
    await prisma.materialCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  // --- Metal Loss tracking variant ---
  // A dedicated weight-tracked variant whose stockWeight is the running
  // total of all loss reported on receipts. Each receive's lossWeight is
  // posted as an IN movement to this variant by the casting service.
  // Operators see "we've lost N g this month" at a glance on Inventory.
  const silverCat = await prisma.materialCategory.findFirst({ where: { name: 'Silver / Metal' } });
  const lossMaterial = await prisma.material.upsert({
    where: { materialCode: 'M-LOSS' },
    update: { materialName: 'Metal Loss', categoryId: silverCat?.id ?? null, unit: 'g' },
    create: {
      materialCode: 'M-LOSS',
      materialName: 'Metal Loss',
      categoryId: silverCat?.id ?? null,
      unit: 'g',
    },
  });
  await prisma.materialVariant.upsert({
    where: { variantCode: 'LOSS-SILVER' },
    update: {
      trackByQty: false,
      trackByWeight: true,
      status: 'ACTIVE',
    },
    create: {
      materialId: lossMaterial.id,
      variantCode: 'LOSS-SILVER',
      variantName: 'Silver Loss (Running Total)',
      unit: 'g',
      trackByQty: false,
      trackByWeight: true,
      stockQty: 0,
      stockWeight: 0,
      status: 'ACTIVE',
    },
  });

  // --- Silver Runners tracking variant ---
  // Runners = the sprue / branch silver cut off the cast tree during
  // Filing or Polish. Recoverable metal that goes back to the casting
  // pool. Tracked as weight-only; receive form posts runnersWeight
  // into this variant on save so the running pool is always current.
  const runnersMaterial = await prisma.material.upsert({
    where: { materialCode: 'M-RUN' },
    update: { materialName: 'Silver Runners', categoryId: silverCat?.id ?? null, unit: 'g' },
    create: {
      materialCode: 'M-RUN',
      materialName: 'Silver Runners',
      categoryId: silverCat?.id ?? null,
      unit: 'g',
    },
  });
  await prisma.materialVariant.upsert({
    where: { variantCode: 'RUNNERS-SILVER' },
    update: { trackByQty: false, trackByWeight: true, status: 'ACTIVE' },
    create: {
      materialId: runnersMaterial.id,
      variantCode: 'RUNNERS-SILVER',
      variantName: 'Silver Runners (Filing / Polish pool)',
      unit: 'g',
      trackByQty: false,
      trackByWeight: true,
      stockQty: 0,
      stockWeight: 0,
      status: 'ACTIVE',
    },
  });

  // --- Warehouses (Dispatch hub + storage) ---
  // DISPATCH is the singleton hub every finished-good variant lands in
  // after packing-categorization. STORAGE warehouses are long-term homes
  // (admins can add more via the Warehouse Settings page).
  const warehouses = [
    { name: 'Dispatch Center', kind: 'DISPATCH' as const },
    { name: 'Warehouse 1',     kind: 'STORAGE'  as const },
    { name: 'Warehouse 2',     kind: 'STORAGE'  as const },
  ];
  for (const w of warehouses) {
    await prisma.warehouse.upsert({
      where: { name: w.name },
      update: { kind: w.kind, isActive: true },
      create: w,
    });
  }

  console.log('Seed complete. Login with admin / admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
