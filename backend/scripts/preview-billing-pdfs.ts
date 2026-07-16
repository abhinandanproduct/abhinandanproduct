/**
 * Preview all billing PDF formats against a heavy multi-line synthetic
 * invoice — used to eyeball page overflow / column overspill. No DB writes.
 *
 * Run:
 *   npx tsx scripts/preview-billing-pdfs.ts
 *
 * Outputs to backend/scripts/preview/:
 *   estimate.pdf, tax-invoice.pdf, delivery-challan.pdf, temp-invoice.pdf
 */
import { createWriteStream, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { streamInvoicePdf } from '../src/billing/billing.pdf';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'preview');
mkdirSync(OUT_DIR, { recursive: true });

const CUSTOMER = {
  customerName: 'TANVI SILVER INDIA PRIVATE LIMITED',
  phone: '+91 98765 43210',
  gstin: '24AAKCT1234F1Z5',
  addressLine1: '208-209, Silver Point, Nr Old High Court',
  addressLine2: 'Off Ashram Road, Navrangpura',
  city: 'Ahmedabad',
  state: 'Gujarat',
  stateCode: '24',
  pincode: '380009',
};

const ITEMS = Array.from({ length: 22 }, (_, i) => {
  const wt = 12.345 + i * 3.256;
  const qty = 1 + (i % 5);
  const silverRate = 82.5;
  const makingRate = 15;
  const silverAmount = +(wt * qty * silverRate).toFixed(2);
  const makingAmount = +(wt * qty * makingRate).toFixed(2);
  const extra = +((i % 4) * 25).toFixed(2);
  return {
    itemId: i + 1,
    itemNumber: `ABN${String(1000 + i).padStart(4, '0')}`,
    description: [
      'Ball no. 2 (Plain)',
      'Ganesha Idol Small — Antique Finish Meena',
      'Pooja Thali Set Round — 6 pcs',
      'Ganpati Locket Pendant with Chain',
      'Kalash Coin — 999 Fineness',
    ][i % 5],
    hsnCode: '71131110',
    quantity: qty,
    weightG: +wt.toFixed(3),
    silverRatePerG: silverRate,
    makingRatePerG: makingRate,
    silverAmount,
    makingAmount,
    lineAmount: silverAmount + makingAmount + extra,
    lessWeightG: +(wt * 0.02).toFixed(3),
    netWeightG:  +(wt * 0.98).toFixed(3),
    purity: 92.5,
    fineWeightG: +(wt * 0.98 * 0.925).toFixed(3),
    wastagePercent: 3,
    wastageFineG: +(wt * 0.98 * 0.925 * 0.03).toFixed(3),
    laborOn: 'WEIGHT' as const,
    laborRateWithTax: makingRate,
    laborRateWithoutTax: makingRate,
    laborAmount: makingAmount,
    extraAmount: extra,
  };
});

const totals = ITEMS.reduce(
  (a, l) => ({
    silver: a.silver + +l.silverAmount,
    making: a.making + +l.makingAmount,
    extra: a.extra + +(l.extraAmount ?? 0),
    weight: a.weight + l.weightG * l.quantity,
  }),
  { silver: 0, making: 0, extra: 0, weight: 0 },
);
const subtotal = +(totals.silver + totals.making + totals.extra).toFixed(2);
const gst = +(subtotal * 0.03).toFixed(2);
const grand = Math.round(subtotal + gst);

const BASE = {
  id: 999,
  invoiceDate: new Date('2026-07-03'),
  dueDate: null,
  billToName: CUSTOMER.customerName,
  billToAddress: [CUSTOMER.addressLine1, CUSTOMER.addressLine2, `${CUSTOMER.city}, ${CUSTOMER.state}, ${CUSTOMER.pincode}`].join('\n'),
  billToGstin: CUSTOMER.gstin,
  placeOfSupply: `${CUSTOMER.state} (${CUSTOMER.stateCode})`,
  silverRatePerG: 82.5,
  makingRatePerG: 15,
  gstPercent: 3,
  isInterState: false,
  subtotal,
  cgstAmount: +(gst / 2).toFixed(2),
  sgstAmount: +(gst / 2).toFixed(2),
  igstAmount: 0,
  roundOff: +(grand - subtotal - gst).toFixed(2),
  totalAmount: grand,
  paidAmount: 0,
  balanceAmount: grand,
  totalWeightG: +totals.weight.toFixed(3),
  purpose: 'Plating',
  notes: 'Test render — heavy synthetic data set.',
  customer: CUSTOMER,
  items: ITEMS,
};

const FORMATS: Array<{ name: string; type: any; status: string; invoiceNumber: string }> = [
  { name: 'estimate.pdf',         type: 'QUOTE',            status: 'ISSUED', invoiceNumber: 'EST0042' },
  { name: 'tax-invoice.pdf',      type: 'TAX_INVOICE',      status: 'ISSUED', invoiceNumber: 'INV0042' },
  { name: 'delivery-challan.pdf', type: 'DELIVERY_CHALLAN', status: 'ISSUED', invoiceNumber: 'DC0042' },
  { name: 'temp-invoice.pdf',     type: 'TEMP_INVOICE',     status: 'ISSUED', invoiceNumber: 'INV0042' },
];

async function main() {
  for (const f of FORMATS) {
    const path = join(OUT_DIR, f.name);
    const stream = createWriteStream(path);
    // Cast to `any` — streamInvoicePdf's Response type wants only end/pipe;
    // WriteStream provides both.
    streamInvoicePdf(stream as any, { ...BASE, ...f } as any);
    await new Promise<void>((res) => stream.on('finish', () => res()));
    console.log(`✓  ${f.name} → ${path}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
