/* eslint-disable no-console */
/**
 * Wipe ALL transactional + master data from the local Postgres so the
 * SilverERP import can land into a known-empty system. Preserves:
 *   - User accounts (auth identity)
 *   - Process master (the manufacturing chain definition)
 *   - ChargeType master (Freight / Packaging / Insurance / Loading / Other)
 *   - ProcessService master (additional services offered per process)
 *   - LOSS-SILVER + RUNNERS-SILVER tracker MaterialVariants (and their parent
 *     Material) — these are the silver-loss / runners accounting buckets
 *     that the production receive flow posts into. Wiping them would break
 *     the runtime; the import preserves them via their unique variantCode.
 *
 * Order matters because of FK constraints. The script walks from the
 * deepest leaf (audit_logs, stock_movements) back up to masters.
 *
 * USAGE
 *   ts-node scripts/wipe-data.ts             # dry-run, prints counts only
 *   ts-node scripts/wipe-data.ts --apply     # actually delete
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

const PRESERVED_PROCESS_NAMES = ['Process master', 'ChargeType master', 'ProcessService master', 'User accounts', 'LOSS-SILVER + RUNNERS-SILVER tracker variants'];

async function main() {
  console.log(`\n=== wipe-data ${APPLY ? '[APPLY]' : '[DRY-RUN]'} ===\n`);
  console.log('Preserving:');
  for (const p of PRESERVED_PROCESS_NAMES) console.log('  ✓', p);
  console.log();

  // Count everything BEFORE so we can sanity-check.
  const counts = {
    audit_logs: await prisma.auditLog.count(),
    file_assets: await prisma.fileAsset.count(),
    status_history: await prisma.statusHistory.count(),
    invoice_charges: await prisma.invoiceCharge.count(),
    payment_allocations: await prisma.paymentAllocation.count(),
    invoice_items: await prisma.invoiceItem.count(),
    invoices: await prisma.invoice.count(),
    payments: await prisma.payment.count(),
    recurring_invoices: await prisma.recurringInvoice.count(),
    vendor_payment_allocations: await prisma.vendorPaymentAllocation.count(),
    bill_items: await prisma.billItem.count(),
    bills: await prisma.bill.count(),
    vendor_payments: await prisma.vendorPayment.count(),
    customers: await prisma.customer.count(),
    material_issue_lines: await prisma.materialIssueLine.count(),
    material_issues: await prisma.materialIssue.count(),
    stock_movements: await prisma.stockMovement.count(),
    casting_receipt_items: await prisma.castingReceiptItem.count(),
    casting_receipts: await prisma.castingReceipt.count(),
    production_variant_stage_stops: await prisma.productionVariantStageStop.count(),
    production_variants: await prisma.productionVariant.count(),
    missing_parts: await prisma.missingPart.count(),
    repair_orders: await prisma.repairOrder.count(),
    casting_batch_items: await prisma.castingBatchItem.count(),
    casting_batches: await prisma.castingBatch.count(),
    vendor_metal_ledger: await prisma.vendorMetalLedger.count(),
    vendor_metal_balances: await prisma.vendorMetalBalance.count(),
    item_process_services: await prisma.itemProcessService.count(),
    process_photos: await prisma.processPhoto.count(),
    item_process_vendors: await prisma.itemProcessVendor.count(),
    item_color_models: await prisma.itemColorModel.count(),
    item_materials: await prisma.itemMaterial.count(),
    item_processes: await prisma.itemProcess.count(),
    item_design_parts: await prisma.itemDesignPart.count(),
    item_images: await prisma.itemImage.count(),
    items: await prisma.item.count(),
    material_variant_processes: await prisma.materialVariantProcess.count(),
    material_variant_vendors: await prisma.materialVariantVendor.count(),
    material_variants: await prisma.materialVariant.count(),
    materials: await prisma.material.count(),
    vendor_processes: await prisma.vendorProcess.count(),
    vendors: await prisma.vendor.count(),
  };
  console.log('Current row counts:');
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) console.log(`  ${k.padEnd(35)} ${v}`);
  }
  console.log();

  // Track the LOSS-SILVER / RUNNERS-SILVER variant IDs so we don't delete them.
  const trackers = await prisma.materialVariant.findMany({
    where: { variantCode: { in: ['LOSS-SILVER', 'RUNNERS-SILVER'] } },
    select: { id: true, variantCode: true, materialId: true },
  });
  const trackerVariantIds = trackers.map((t) => t.id);
  const trackerMaterialIds = Array.from(new Set(trackers.map((t) => t.materialId)));
  console.log(`Tracker variants preserved (${trackers.length}):`);
  for (const t of trackers) console.log(`  ${t.variantCode} → variantId=${t.id}, materialId=${t.materialId}`);
  console.log();

  if (!APPLY) {
    console.log('DRY-RUN — pass --apply to actually delete.');
    return;
  }

  console.log('Deleting (FK-safe order)…\n');
  // -------- Top-level audit + history --------
  await prisma.auditLog.deleteMany();             console.log('  ✓ audit_logs');
  await prisma.fileAsset.deleteMany();            console.log('  ✓ file_assets');
  await prisma.statusHistory.deleteMany();        console.log('  ✓ status_history');

  // -------- Billing (sales) --------
  await prisma.invoiceCharge.deleteMany();        console.log('  ✓ invoice_charges');
  await prisma.paymentAllocation.deleteMany();    console.log('  ✓ payment_allocations');
  await prisma.invoiceItem.deleteMany();          console.log('  ✓ invoice_items');
  await prisma.invoice.deleteMany();              console.log('  ✓ invoices');
  await prisma.payment.deleteMany();              console.log('  ✓ payments');
  await prisma.recurringInvoice.deleteMany();     console.log('  ✓ recurring_invoices');

  // -------- Purchases --------
  await prisma.vendorPaymentAllocation.deleteMany(); console.log('  ✓ vendor_payment_allocations');
  await prisma.billItem.deleteMany();             console.log('  ✓ bill_items');
  await prisma.bill.deleteMany();                 console.log('  ✓ bills');
  await prisma.vendorPayment.deleteMany();        console.log('  ✓ vendor_payments');

  // -------- Customers --------
  await prisma.customer.deleteMany();             console.log('  ✓ customers');

  // -------- Casting / production --------
  await prisma.materialIssueLine.deleteMany();    console.log('  ✓ material_issue_lines');
  await prisma.materialIssue.deleteMany();        console.log('  ✓ material_issues');
  // Stock movements first — they reference variants.
  await prisma.stockMovement.deleteMany();        console.log('  ✓ stock_movements');
  await prisma.castingReceiptItem.deleteMany();   console.log('  ✓ casting_receipt_items');
  await prisma.castingReceipt.deleteMany();       console.log('  ✓ casting_receipts');
  await prisma.productionVariantStageStop.deleteMany(); console.log('  ✓ production_variant_stage_stops');
  await prisma.productionVariant.deleteMany();    console.log('  ✓ production_variants');
  await prisma.missingPart.deleteMany();          console.log('  ✓ missing_parts');
  await prisma.repairOrder.deleteMany();          console.log('  ✓ repair_orders');
  // CastingBatchItem has self-FKs (parentItemId / plannedNextProcessId) so delete
  // in two passes: first nullify the self-refs, then delete all rows.
  await prisma.castingBatchItem.updateMany({
    data: { parentItemId: null, plannedNextVendorId: null, plannedTargetBatchId: null },
  });
  await prisma.castingBatchItem.deleteMany();     console.log('  ✓ casting_batch_items');
  await prisma.castingBatch.deleteMany();         console.log('  ✓ casting_batches');

  // -------- Vendor metal ledger --------
  await prisma.vendorMetalLedger.deleteMany();    console.log('  ✓ vendor_metal_ledger');
  await prisma.vendorMetalBalance.deleteMany();   console.log('  ✓ vendor_metal_balances');

  // -------- Item master --------
  await prisma.itemProcessService.deleteMany();   console.log('  ✓ item_process_services');
  await prisma.processPhoto.deleteMany();         console.log('  ✓ process_photos');
  await prisma.itemProcessVendor.deleteMany();    console.log('  ✓ item_process_vendors');
  await prisma.itemColorModel.deleteMany();       console.log('  ✓ item_color_models');
  await prisma.itemMaterial.deleteMany();         console.log('  ✓ item_materials');
  await prisma.itemProcess.deleteMany();          console.log('  ✓ item_processes');
  await prisma.itemDesignPart.deleteMany();       console.log('  ✓ item_design_parts');
  await prisma.itemImage.deleteMany();            console.log('  ✓ item_images');
  await prisma.item.deleteMany();                 console.log('  ✓ items');

  // -------- Material master (preserving trackers) --------
  await prisma.materialVariantProcess.deleteMany({
    where: { variantId: { notIn: trackerVariantIds } },
  });                                              console.log('  ✓ material_variant_processes (kept trackers)');
  await prisma.materialVariantVendor.deleteMany({
    where: { variantId: { notIn: trackerVariantIds } },
  });                                              console.log('  ✓ material_variant_vendors (kept trackers)');
  await prisma.materialVariant.deleteMany({
    where: { id: { notIn: trackerVariantIds } },
  });                                              console.log('  ✓ material_variants (kept trackers)');
  await prisma.material.deleteMany({
    where: { id: { notIn: trackerMaterialIds } },
  });                                              console.log('  ✓ materials (kept tracker parents)');

  // -------- Vendors --------
  await prisma.vendorProcess.deleteMany();        console.log('  ✓ vendor_processes');
  await prisma.vendor.deleteMany();               console.log('  ✓ vendors');

  console.log('\nDone. Final counts:');
  const finalCounts = {
    vendors: await prisma.vendor.count(),
    materials: await prisma.material.count(),
    material_variants: await prisma.materialVariant.count(),
    items: await prisma.item.count(),
    casting_batches: await prisma.castingBatch.count(),
    customers: await prisma.customer.count(),
    invoices: await prisma.invoice.count(),
    bills: await prisma.bill.count(),
    processes: await prisma.process.count(),
  };
  for (const [k, v] of Object.entries(finalCounts)) console.log(`  ${k.padEnd(20)} ${v}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
