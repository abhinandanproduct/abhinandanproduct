import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  // Find all material issue lines with deferred qty > 0
  const lines = await p.materialIssueLine.findMany({
    where: { deferredQty: { gt: 0 } },
    include: {
      variant: { include: { material: true } },
      issue: { include: { vendor: true, batch: true, stage: { include: { item: true } } } },
    },
  });
  console.log(`Total deferred lines: ${lines.length}\n`);

  // Group by variant to see how many rows per variant
  const byVariant = new Map<number, { name: string; availableStock: number; rows: any[] }>();
  for (const ln of lines) {
    const v = byVariant.get(ln.variantId) ?? {
      name: `${ln.variant.material?.materialName ?? '?'} (${ln.variant.variantName})`,
      availableStock: Math.round(Number(ln.variant.stockQty)),
      rows: [],
    };
    v.rows.push({
      lineId: ln.id,
      voucher: ln.issue.voucherNumber,
      vendor: ln.issue.vendor.vendorCode,
      design: ln.issue.stage?.item?.itemNumber ?? ln.issue.batch?.batchNumber,
      deferredQty: ln.deferredQty,
    });
    byVariant.set(ln.variantId, v);
  }

  for (const [vid, info] of byVariant) {
    if (info.rows.length < 2) continue; // only show variants with multiple deferred rows
    console.log(`Variant #${vid} ${info.name} — stock=${info.availableStock}, ${info.rows.length} rows`);
    const totalDeferred = info.rows.reduce((s, r) => s + r.deferredQty, 0);
    console.log(`  total deferred across rows: ${totalDeferred}`);
    if (totalDeferred > info.availableStock) {
      console.log(`  ⚠ OVER-ALLOCATION: defaulting each row to its full deferred would issue ${Math.min(info.availableStock, info.rows.reduce((s, r) => s + Math.min(r.deferredQty, info.availableStock), 0))} pcs > ${info.availableStock} available`);
    }
    for (const r of info.rows.slice(0, 12)) {
      console.log(`    ${r.voucher} · ${r.vendor} · ${r.design ?? '—'} · owed ${r.deferredQty} · default would be ${Math.min(r.deferredQty, info.availableStock)}`);
    }
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
