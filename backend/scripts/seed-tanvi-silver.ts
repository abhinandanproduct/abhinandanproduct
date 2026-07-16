// One-shot seed for Tanvi Silver India Pvt Ltd — the primary buyer we're
// billing today. Safe to re-run: upserts by GSTIN so we don't create a
// duplicate row. Run with:
//   npx tsx scripts/seed-tanvi-silver.ts
import { PrismaClient } from '@prisma/client';
import { nextCode } from '../src/common/code-generator';

const prisma = new PrismaClient();

async function main() {
  const gstin = '24AAKCT7257P1ZJ';
  const existing = await prisma.customer.findFirst({ where: { gstin } });
  const data = {
    customerName: 'TANVI SILVER INDIA PRIVATE LIMITED',
    gstin,
    addressLine1: 'Parmeshwari Hub',
    addressLine2: 'Bhimjibhai Street, Soni Bazar',
    city: 'Rajkot',
    state: 'Gujarat',
    stateCode: '24',
    pincode: '360001',
    phone: null,
    email: null,
    status: 'ACTIVE',
    notes: null,
  };

  if (existing) {
    const updated = await prisma.customer.update({
      where: { id: existing.id },
      data,
    });
    console.log(`Updated existing customer ${updated.customerCode} · ${updated.customerName}`);
  } else {
    // Match BillingService.createCustomer's coding scheme so the record
    // sits in the same sequence as UI-created customers.
    const customerCode = await nextCode(prisma as any, 'customer', 'customerCode', 'AC', 4);
    const created = await prisma.customer.create({
      data: { ...data, customerCode, balance: 0 } as any,
    });
    console.log(`Created ${created.customerCode} · ${created.customerName}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
