import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import { SilverLotsService } from '../silver-lots/silver-lots.service';
import {
  CreateInvoiceDto, CreatePaymentDto, InvoiceTypeStr, UpsertCustomerDto,
} from './dto/billing.dto';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

@Injectable()
export class BillingService {
  constructor(
    private prisma: PrismaService,
    private silverLots: SilverLotsService,
  ) {}

  // -------------------------------------------------------------------------
  // Customer master
  // -------------------------------------------------------------------------

  async listCustomers(search?: string) {
    return this.prisma.customer.findMany({
      where: search
        ? {
            OR: [
              { customerName: { contains: search, mode: 'insensitive' } },
              { customerCode: { contains: search, mode: 'insensitive' } },
              { gstin:        { contains: search, mode: 'insensitive' } },
              { phone:        { contains: search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { customerName: 'asc' },
    });
  }

  async getCustomer(id: number) {
    const c = await this.prisma.customer.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Customer not found.');
    return c;
  }

  async createCustomer(dto: UpsertCustomerDto) {
    const customerCode = await nextCode(this.prisma, 'customer', 'customerCode', 'AC', 4);
    return this.prisma.customer.create({
      data: { ...dto, customerCode, balance: 0 } as any,
    });
  }

  async updateCustomer(id: number, dto: UpsertCustomerDto) {
    await this.getCustomer(id);
    return this.prisma.customer.update({
      where: { id },
      data: { ...dto } as any,
    });
  }

  /** Statement view — invoices + payments interleaved with running balance. */
  async customerLedger(customerId: number) {
    const customer = await this.getCustomer(customerId);
    const [invoices, payments] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { customerId, status: { not: 'CANCELLED' } },
        orderBy: { invoiceDate: 'asc' },
      }),
      this.prisma.payment.findMany({
        where: { customerId },
        orderBy: { paymentDate: 'asc' },
      }),
    ]);
    type Row = {
      date: Date; ref: string; description: string;
      debit: number; credit: number; balance: number; kind: 'INVOICE' | 'PAYMENT';
      id: number;
    };
    const rows: Row[] = [
      ...invoices.map((i) => ({
        date: i.invoiceDate, ref: i.invoiceNumber,
        description: i.type === 'TAX_INVOICE' ? 'Tax Invoice' : i.type === 'ESTIMATE' ? 'Estimate' : 'Delivery Challan',
        debit: i.type === 'DELIVERY_CHALLAN' ? 0 : Number(i.totalAmount),
        credit: 0, balance: 0, kind: 'INVOICE' as const, id: i.id,
      })),
      ...payments.map((p) => ({
        date: p.paymentDate, ref: p.paymentNumber,
        description: `Receipt — ${p.mode}${p.reference ? ` · ${p.reference}` : ''}`,
        debit: 0, credit: Number(p.amount),
        balance: 0, kind: 'PAYMENT' as const, id: p.id,
      })),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());
    let running = 0;
    for (const r of rows) {
      running = r2(running + r.debit - r.credit);
      r.balance = running;
    }
    return {
      customer,
      rows,
      closingBalance: running,
      totalInvoiced: r2(invoices.reduce((s, i) => s + (i.type !== 'DELIVERY_CHALLAN' ? Number(i.totalAmount) : 0), 0)),
      totalPaid: r2(payments.reduce((s, p) => s + Number(p.amount), 0)),
    };
  }

  // -------------------------------------------------------------------------
  // Invoice — Tax Invoice / Estimate / Delivery Challan
  // -------------------------------------------------------------------------

  /** Compute per-line amounts + invoice totals + GST split. */
  private compute(dto: CreateInvoiceDto) {
    const headerSilver = Number(dto.silverRatePerG ?? 0);
    const headerMaking = Number(dto.makingRatePerG ?? 0);
    const lines = dto.lines.map((l: any) => {
      const weight = Number(l.weightG);
      const qty = Number(l.quantity);
      const totalWeight = r3(weight * qty);
      // Silver/making are RATES-PER-GRAM — meaningless on a charge-only
      // row (delivery fee, "Other Charges", labor rework). Force both to
      // zero when the row has no weight, regardless of what's in the
      // stored/typed field. That way a stale 238.11 left behind by an
      // earlier auto-inherit doesn't keep re-printing on the PDF.
      // With weight: respect the typed value; fall back to the header
      // rate only when nothing was typed.
      const hasWeight = totalWeight > 0;
      const silverRate = !hasWeight
        ? 0
        : (l.silverRatePerG != null ? Number(l.silverRatePerG) : headerSilver);
      const makingRate = !hasWeight
        ? 0
        : (l.makingRatePerG != null ? Number(l.makingRatePerG) : headerMaking);
      // Detailed-weight derivations — the operator can leave net / fine /
      // wastageFine blank and the system fills them in from purity + wastage%.
      const grossPer = Number(l.weightG);
      const lessPer  = Number(l.lessWeightG ?? 0);
      const netPer   = l.netWeightG != null
        ? Number(l.netWeightG)
        : r3(grossPer - lessPer);
      const purityPct = l.purity != null ? Number(l.purity) : null;
      const finePer = l.fineWeightG != null
        ? Number(l.fineWeightG)
        : (purityPct != null ? r3(netPer * (purityPct / 100)) : null);
      const wastagePct = l.wastagePercent != null ? Number(l.wastagePercent) : null;
      const wastageFinePer = l.wastageFineG != null
        ? Number(l.wastageFineG)
        : (wastagePct != null ? r3(netPer * (wastagePct / 100)) : null);
      // Fall back to weightG×qty when no detailed breakdown supplied (preserves
      // legacy "simple invoice" behavior).
      const silverAmount = r2(totalWeight * silverRate);
      // Labor — if laborAmount supplied, use it. Otherwise auto-compute from
      // (totalWeight or qty) × laborRate. Falls back to makingRate×totalWeight.
      let makingAmount: number;
      if (l.laborAmount != null) {
        makingAmount = r2(Number(l.laborAmount));
      } else if (l.laborRateWithoutTax != null) {
        const base = (l.laborOn ?? 'WEIGHT') === 'PIECE'
          ? qty
          : totalWeight;
        makingAmount = r2(base * Number(l.laborRateWithoutTax));
      } else {
        makingAmount = r2(totalWeight * makingRate);
      }
      const extra = Number(l.extraAmount ?? 0);
      const lineAmount = r2(silverAmount + makingAmount + extra);
      return {
        ...l,
        silverRatePerG: silverRate,
        makingRatePerG: makingRate,
        silverAmount,
        makingAmount,
        lineAmount,
        // Snap derived values back so the row record carries the full breakdown.
        netWeightG: netPer,
        fineWeightG: finePer,
        wastageFineG: wastageFinePer,
      };
    });
    // Optional labor / making-charges discount — operator-set per invoice.
    // Applied to the SUM of all lines' makingAmount before GST.
    const laborDiscountPct = Number(dto.laborDiscountPercent ?? 0);
    const totalMaking = lines.reduce((s, l) => s + l.makingAmount, 0);
    const laborDiscount = laborDiscountPct > 0 ? r2(totalMaking * (laborDiscountPct / 100)) : 0;
    // Header-level additional charges (freight, packaging, etc.) — sum to a
    // single chargesTotal that adds to subtotal pre-GST.
    const chargesTotal = r2((dto.charges ?? []).reduce((s, c) => s + Number(c.amount), 0));
    const subtotal = r2(lines.reduce((s, l) => s + l.lineAmount, 0) - laborDiscount + chargesTotal);
    const isChallan = dto.type === 'DELIVERY_CHALLAN';
    const isEstimate = dto.type === 'ESTIMATE';
    const gstPct = isChallan ? 0 : Number(dto.gstPercent ?? 3);
    const interState = !!dto.isInterState;
    const gstAmount = r2(subtotal * (gstPct / 100));
    const cgst = !interState ? r2(gstAmount / 2) : 0;
    const sgst = !interState ? r2(gstAmount - cgst) : 0;
    const igst = interState ? gstAmount : 0;
    const preRound = r2(subtotal + cgst + sgst + igst);
    const total = Math.round(preRound);
    const roundOff = r2(total - preRound);
    return {
      lines, subtotal, gstPct, interState,
      cgst, sgst, igst, roundOff, total,
      isChallan, isEstimate,
      laborDiscountPct, laborDiscount, chargesTotal,
    };
  }

  private prefixFor(type: string) {
    switch (type) {
      case 'QUOTE':            return 'EST'; // renamed from QT per user
      case 'SALES_ORDER':      return 'SO';
      // Tax invoices carry the company's document code "ABN-" with 6-digit
      // sequence padding (ABN-000001). Set here per operator spec —
      // startFrom is honoured by nextCode's max-scan, so a fresh install
      // begins at ABN-000001; older INV-prefixed invoices stay put and
      // don't feed this counter.
      case 'TAX_INVOICE':      return 'ABN-';
      case 'DELIVERY_CHALLAN': return 'DC';
      case 'CREDIT_NOTE':      return 'CN';
      case 'ESTIMATE':         return 'EST'; // legacy
      // TEMP_INVOICE now uses its own INV- prefix (was ABN-). Sharing
      // the tax-invoice prefix caused interleaved sequences — a temp
      // silently consumed ABN-000003 that a real tax invoice should
      // have gotten. Distinct prefix keeps the two counters clean and
      // the printed PDF still shows "TAX INVOICE" as the heading.
      case 'TEMP_INVOICE':     return 'INV-';
      default: return 'DOC';
    }
  }

  /**
   * Zero-padding width per doc type. Tax + temp invoices use 6 digits
   * ("ABN-000001") per operator spec; everything else stays on the legacy
   * 4-digit pad ("EST0001", "DC0001", "SO0001", "CN0001").
   */
  private padFor(type: string) {
    return type === 'TAX_INVOICE' || type === 'TEMP_INVOICE' ? 6 : 4;
  }

  async createInvoice(dto: CreateInvoiceDto, userId?: number) {
    // Customer is optional now — a DRAFT QUOTE (draft estimate) can hold
    // lines before a customer is chosen. Any status > DRAFT requires the
    // customerId to be resolvable.
    const status = (dto as any).status ?? 'ISSUED';
    const customer = dto.customerId != null
      ? await this.getCustomer(dto.customerId)
      : null;
    if (!customer && status !== 'DRAFT') {
      throw new BadRequestException('customerId is required unless the invoice is being saved as DRAFT.');
    }
    // Rate-fixing rule:
    //   TAX_INVOICE → rates MUST be set (silver+making > 0). ratesFixed forced true.
    //   QUOTE       → rates may be 0 (to be confirmed). Default ratesFixed=false.
    //   Others      → default ratesFixed=true.
    const isTaxInvoice = dto.type === 'TAX_INVOICE';
    const isCreditNote = dto.type === 'CREDIT_NOTE';
    const isQuote      = dto.type === 'QUOTE' || dto.type === 'ESTIMATE';
    const ratesFixed   = isTaxInvoice
      ? true
      : (dto.ratesFixed ?? !isQuote);
    // Silver/making rate no longer mandatory per line — operator sets
    // whichever is needed (a pure "delivery charge" or "labor rework"
    // row can carry zero silver+making and only an additionalPerPc
    // charge). Backend still rejects a completely empty line (qty=0
    // AND no weight AND no charge) further down in compute().
    const c = this.compute(dto);
    // Editable invoice number — operator can force a specific value on
    // create (used for editing the estimate # from the UI). Falls back
    // to auto-generated when omitted. Uniqueness is enforced by the DB.
    const forced = (dto as any).invoiceNumber as string | undefined;
    if (forced && forced.trim()) {
      const clash = await this.prisma.invoice.findUnique({ where: { invoiceNumber: forced.trim() } });
      if (clash) throw new BadRequestException(`Invoice number "${forced.trim()}" already exists.`);
    }
    const prefix = this.prefixFor(dto.type);
    const billToAddress = customer
      ? [
          customer.addressLine1, customer.addressLine2,
          [customer.city, customer.state, customer.pincode].filter(Boolean).join(', '),
        ].filter(Boolean).join('\n')
      : '';
    // Wrap invoice-create + charges + AR debit + credit-note allocation in
    // one $transaction so a mid-flight failure never leaves an invoice
    // committed with its AR update missing. Prior behaviour was: create
    // invoice, then update Customer.balance in a separate call — if the
    // balance write failed (deadlock, connection reset), AR silently drifted.
    //
    // Auto-generated invoice numbers ride a retry loop: two concurrent
    // creates can pick the same MAX(invoiceNumber)+1 before either commits,
    // so a P2002 on `invoiceNumber` means we lost the race — regenerate
    // the next candidate and retry the whole transaction. Forced numbers
    // are checked once up-front and never re-generated.
    let invoiceNumber = forced && forced.trim() ? forced.trim() : '';
    let created: any;
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (!forced || !forced.trim()) {
        invoiceNumber = await nextCode(this.prisma, 'invoice', 'invoiceNumber', prefix, this.padFor(dto.type));
      }
      try {
        created = await this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
      data: {
        invoiceNumber,
        type: dto.type as any,
        status: status as any,
        invoiceDate: new Date(dto.invoiceDate),
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        customerId: dto.customerId ?? null,
        billToName: customer?.customerName ?? '(unassigned)',
        billToAddress,
        billToGstin: customer?.gstin ?? null,
        placeOfSupply: dto.placeOfSupply ?? customer?.state ?? null,
        silverRatePerG: Number(dto.silverRatePerG ?? 0),
        makingRatePerG: Number(dto.makingRatePerG ?? 0),
        gstPercent: c.gstPct,
        isInterState: c.interState,
        ratesFixed,
        laborDiscountPercent: c.laborDiscountPct > 0 ? c.laborDiscountPct : null,
        chargesTotal: c.chargesTotal,
        subtotal: c.subtotal,
        cgstAmount: c.cgst,
        sgstAmount: c.sgst,
        igstAmount: c.igst,
        roundOff: c.roundOff,
        totalAmount: c.total,
        paidAmount: 0,
        balanceAmount: c.isChallan ? 0 : c.total,
        notes: dto.notes ?? null,
        totalWeightG: dto.totalWeightG != null ? dto.totalWeightG : null,
        purpose: dto.purpose ?? null,
        createdById: userId ?? null,
        items: {
          create: c.lines.map((l: any) => ({
            itemId: l.itemId ?? null,
            itemNumber: l.itemNumber ?? null,
            description: l.description,
            hsnCode: l.hsnCode ?? null,
            quantity: l.quantity,
            weightG: l.weightG,
            silverRatePerG: l.silverRatePerG,
            makingRatePerG: l.makingRatePerG,
            silverAmount: l.silverAmount,
            makingAmount: l.makingAmount,
            lineAmount: l.lineAmount,
            notes: l.notes ?? null,
            // Detailed breakdown — passed through verbatim. The compute layer
            // auto-derives missing values (net, fine, wastage fine) for the
            // PDF / form. See `compute()`.
            lessWeightG:       l.lessWeightG ?? null,
            netWeightG:        l.netWeightG ?? null,
            purity:            l.purity ?? null,
            fineWeightG:       l.fineWeightG ?? null,
            wastagePercent:    l.wastagePercent ?? null,
            wastageFineG:      l.wastageFineG ?? null,
            boxWeightG:        l.boxWeightG ?? null,
            bagWeightG:        l.bagWeightG ?? null,
            tagWeightG:        l.tagWeightG ?? null,
            padWeightG:        l.padWeightG ?? null,
            totalGrossWeightG: l.totalGrossWeightG ?? null,
            totalWeightG:      (l as any).totalWeightG ?? null,
            size:              l.size ?? null,
            category:          l.category ?? null,
            plating:           l.plating ?? null,
            laborOn:           l.laborOn ?? null,
            laborRateWithTax:    l.laborRateWithTax ?? null,
            laborRateWithoutTax: l.laborRateWithoutTax ?? null,
            laborAmount:       l.laborAmount ?? null,
            extraAmount:       l.extraAmount ?? null,
            extraDescription:  (l as any).extraDescription ?? null,
            fineAmount:        l.fineAmount ?? null,
            packetNo:          l.packetNo ?? null,
            productionOrderRef: l.productionOrderRef ?? null,
            boxRef:            l.boxRef ?? null,
            barcode:           l.barcode ?? null,
          } as any)),
        },
      },
      include: { items: true, customer: true },
      });

      // Header-level charges (freight / packaging / etc.) — written as
      // separate InvoiceCharge rows so the print can list them out.
      if (Array.isArray(dto.charges) && dto.charges.length > 0) {
        await tx.invoiceCharge.createMany({
          data: dto.charges
            .filter((c) => Number(c.amount) > 0 && c.chargeTypeId)
            .map((c) => ({
              invoiceId: inv.id,
              chargeTypeId: c.chargeTypeId,
              label: c.label ?? null,
              amount: Number(c.amount),
            })),
        });
      }

      // -------------------------------------------------------------------
      // FIFO metal draw — every non-DRAFT invoice that carries silver
      // weight consumes lots in receipt-order:
      //   1. Sum total invoice weight (grams).
      //   2. Ask SilverLotsService for a preview: which lots, how much
      //      each, at what rate.
      //   3. If lots don't cover the full weight, log a warning row
      //      (invoice still commits — operator can add a lot post-hoc).
      //   4. Persist each draw against the lot, decrementing its
      //      remainingWeightG. Alert if the invoice spanned >1 lot so
      //      the operator knows to check the rate mix.
      //
      // Skipped for DRAFT (rates aren't final) and DELIVERY_CHALLAN
      // (no money changes hands). Only fires when a customer is set.
      // Weight is derived from InvoiceItem rows (already persisted above).
      const drawsAffectsInvoice = status !== 'DRAFT'
        && dto.type !== 'DELIVERY_CHALLAN'
        && customer != null;
      if (drawsAffectsInvoice) {
        const totalWeightG = c.lines.reduce((s: number, l: any) =>
          s + Number(l.weightG ?? 0) * Number(l.quantity ?? 0), 0);
        if (totalWeightG > 0) {
          // Outward variant for jewellery = Silver 93.5. We LOOK UP by
          // variantCode so the seeder-created SILV-935 wins deterministically.
          const outward = await tx.materialVariant.findFirst({
            where: { variantCode: 'SILV-935' },
          }) ?? await tx.materialVariant.findFirst({
            // Legacy fallback for installs without the seeder run.
            where: {
              trackByWeight: true,
              variantName: { contains: 'silver', mode: 'insensitive' },
            },
            orderBy: { id: 'asc' },
          });
          if (outward) {
            const { draws, remainingUnfilled } = await this.silverLots.computeFifoDraw({
              customerId: dto.customerId!,
              variantId: outward.id,
              weightG: totalWeightG,
            });
            for (const d of draws) {
              // NOTE: `d.weightG` = invoice-facing outward grams (for the
              // ledger note / display), `d.lotWeightG` = the ACTUAL grams
              // deducted from the lot's own remaining balance. When purity
              // differs, these are different numbers.
              await this.silverLots.applyDraw(tx, {
                lotId: d.lotId,
                invoiceId: inv.id,
                weightG: (d as any).lotWeightG ?? d.weightG,
                ratePerG: d.ratePerG,
                note: (d as any).lotWeightG != null && (d as any).lotWeightG !== d.weightG
                  ? `Invoice ${inv.invoiceNumber} · ${d.weightG.toFixed(3)} g of ${outward.variantCode} = ${(d as any).lotWeightG.toFixed(3)} g of ${(d as any).lotVariantCode}`
                  : `Invoice ${inv.invoiceNumber}`,
              });
            }
            if (remainingUnfilled > 0) {
              // Silent — operator sees the invoice with the shortfall.
              // Future refinement: throw so a lot must exist first.
            }
          }
        }
      }
      // Customer running balance —
      //   TAX_INVOICE / SALES_ORDER (legacy ESTIMATE) → debit customer.
      //   CREDIT_NOTE → credit customer (negative AR — they owe us less).
      //   QUOTE / DELIVERY_CHALLAN → no AR impact (no commitment / no money).
      const affectsAR =
        customer != null &&
        status !== 'DRAFT' &&
        (dto.type === 'TAX_INVOICE' ||
          dto.type === 'SALES_ORDER' ||
          dto.type === 'CREDIT_NOTE' ||
          dto.type === 'ESTIMATE');
      if (affectsAR) {
        const delta = dto.type === 'CREDIT_NOTE' ? -c.total : c.total;
        await tx.customer.update({
          where: { id: dto.customerId! },
          data: { balance: { increment: delta } },
        });
      }
      // CREDIT_NOTE against an invoice — decrement that invoice's balance and
      // flip to PAID if fully reversed (auto-allocation).
      if (isCreditNote && dto.againstInvoiceId) {
        const src = await tx.invoice.findUnique({ where: { id: dto.againstInvoiceId } });
        if (src && src.customerId === dto.customerId) {
          const newBal = Math.max(0, Math.round((Number(src.balanceAmount) - c.total) * 100) / 100);
          await tx.invoice.update({
            where: { id: src.id },
            data: {
              balanceAmount: newBal,
              paidAmount: Math.round((Number(src.totalAmount) - newBal) * 100) / 100,
              status: newBal <= 0.005 ? 'PAID' : src.status,
            },
          });
        }
      }
      return inv;
        });
        break;
      } catch (e: any) {
        const target = Array.isArray(e?.meta?.target) ? e.meta.target : [e?.meta?.target];
        const isNumberClash =
          e?.code === 'P2002' && target.some((t: string) => t?.includes('invoiceNumber'));
        // Manual override collides → user-facing error, no retry.
        if (isNumberClash && forced && forced.trim()) {
          throw new BadRequestException(`Invoice number "${forced.trim()}" already exists.`);
        }
        // Auto-generated race → retry with a fresh candidate.
        if (isNumberClash && attempt < MAX_ATTEMPTS - 1) continue;
        throw e;
      }
    }
    return created;
  }

  /**
   * Collapse an estimate's per-design lines into ONE consolidated silver
   * line — the same "925 SterlingSilver Mixed Jewellery" row used by both
   * the temp-invoice generator and the estimate→tax-invoice converter.
   *
   * Rules (per operator spec):
   *   - Entity is always "925 SterlingSilver Mixed Jewellery". No per-piece
   *     description (customer sees a single grand-total line).
   *   - qty = 1 (NOT totalPieces). Setting qty=1 keeps `weightG × quantity`
   *     equal to the summed weight, so downstream silverAmount stays
   *     exact — no 3-decimal drift from average-weight-per-piece math.
   *   - Weight, making and additional charges are simple sums of the
   *     source lines. compute() honours laborAmount when present so the
   *     summed making sticks (auto-derive from makingRatePerG × weight
   *     is skipped in this case).
   */
  private buildConsolidatedLine(src: Awaited<ReturnType<BillingService['getInvoice']>>) {
    let totalWeight = 0;
    let totalSilver = 0;
    let totalMaking = 0;
    let totalExtras = 0;
    for (const l of src.items) {
      // Prefer the operator-typed total when snapshotted (avoids the
      // 33.333 × 60 = 1999.98 drift). Falls back to weightG × qty.
      const lineWt = (l as any).totalWeightG != null
        ? Number((l as any).totalWeightG)
        : Number(l.weightG) * Number(l.quantity);
      totalWeight += lineWt;
      totalSilver += Number(l.silverAmount ?? 0);
      totalMaking += Number(l.makingAmount ?? 0);
      totalExtras += Number(l.extraAmount ?? 0);
    }
    totalWeight = Math.round(totalWeight * 1000) / 1000;
    // Derive EFFECTIVE per-gram rates from the source estimate's actual
    // silver + making amounts. Previously we hardcoded
    //   silverRatePerG = header rate
    //   makingRatePerG = 0 (bypassed via laborAmount override)
    // — which printed "Making /g = 0.00" on the temp PDF even when the
    // estimate carried a real making rate. Deriving from totals × weight
    // gives a rate the customer can sanity-check against the estimate.
    const effectiveSilverRate =
      totalWeight > 0 ? Math.round((totalSilver / totalWeight) * 100) / 100 : 0;
    const effectiveMakingRate =
      totalWeight > 0 ? Math.round((totalMaking / totalWeight) * 100) / 100 : 0;
    const label = '925 Sterling Silver Mixed Jewellery';
    return {
      itemNumber: label,
      description: label,
      hsnCode: src.items[0]?.hsnCode ?? '71113',
      quantity: 1,
      weightG: totalWeight,
      // Snapshot so downstream PDF logic uses the exact total instead of
      // recomputing weightG × qty (which is fine at qty=1 but explicit is
      // clearer).
      totalWeightG: totalWeight,
      silverRatePerG: effectiveSilverRate,
      makingRatePerG: effectiveMakingRate,
      // laborAmount override guarantees the printed line making matches
      // the estimate's summed making exactly — rate × weight might drift
      // by a paisa due to per-line rounding otherwise.
      laborAmount: totalMaking,
      extraAmount: totalExtras,
      notes: `Consolidated from ${src.invoiceNumber} · ${src.items.length} line(s), ${totalWeight.toFixed(3)} g`,
    };
  }

  /** Convert a Quote to a Sales Order, then SO to a Tax Invoice. */
  async convertInvoice(id: number, toType: 'SALES_ORDER' | 'TAX_INVOICE', userId?: number) {
    const src = await this.getInvoice(id);
    const fromAllowed: Record<string, string[]> = {
      QUOTE:       ['SALES_ORDER', 'TAX_INVOICE'],
      SALES_ORDER: ['TAX_INVOICE'],
      ESTIMATE:    ['SALES_ORDER', 'TAX_INVOICE'],
    };
    if (!fromAllowed[src.type]?.includes(toType)) {
      throw new BadRequestException(`Cannot convert ${src.type} to ${toType}.`);
    }
    if (src.convertedFromId && toType === 'TAX_INVOICE') {
      throw new BadRequestException('Already converted.');
    }
    const conv = await this.createInvoice({
      type: toType,
      invoiceDate: new Date().toISOString().slice(0, 10),
      customerId: src.customerId ?? undefined,
      placeOfSupply: src.placeOfSupply ?? undefined,
      silverRatePerG: Number(src.silverRatePerG),
      makingRatePerG: Number(src.makingRatePerG),
      gstPercent: Number(src.gstPercent),
      isInterState: src.isInterState,
      ratesFixed: toType === 'TAX_INVOICE' ? true : undefined,
      // For Estimate/Quote → TAX_INVOICE, print ONE consolidated silver
      // line ("925 SterlingSilver Mixed Jewellery" with the summed totals)
      // — matches the temp-invoice shape and the operator's requirement.
      // Any other conversion (SO → Tax, Estimate → SO) keeps the per-line
      // breakdown because SOs still need the per-design detail.
      lines:
        toType === 'TAX_INVOICE' && (src.type === 'QUOTE' || src.type === 'ESTIMATE')
          ? [this.buildConsolidatedLine(src) as any]
          : src.items.map((i) => ({
              itemId: i.itemId ?? undefined,
              itemNumber: i.itemNumber ?? undefined,
              description: i.description,
              hsnCode: i.hsnCode ?? undefined,
              quantity: i.quantity,
              weightG: Number(i.weightG),
              silverRatePerG: Number(i.silverRatePerG),
              makingRatePerG: Number(i.makingRatePerG),
              notes: i.notes ?? undefined,
            })),
      notes: `Converted from ${src.invoiceNumber}`,
    }, userId);
    const updates: Prisma.InvoiceUpdateInput = { convertedFromId: src.id } as any;
    await this.prisma.invoice.update({ where: { id: conv.id }, data: updates });
    // SO → INVOICED status when it became a tax invoice.
    if (src.type === 'SALES_ORDER' && toType === 'TAX_INVOICE') {
      await this.prisma.invoice.update({ where: { id: src.id }, data: { status: 'INVOICED' } });
    }
    return this.getInvoice(conv.id);
  }

  /**
   * Generate a TEMP_INVOICE from an Estimate — collapses every estimate
   * line into ONE consolidated silver row so the printed bill shows a
   * single grand-total line. PDF-side renders exactly like TAX_INVOICE;
   * the "temp" marker only exists in the database via the InvoiceType
   * and the sourceEstimateId back-link.
   *
   * Business rule:
   *   - Sum every line's weight (weightG × quantity) and its making
   *     (laborAmount + extras). Also sum the pieces for description.
   *   - Output one row with quantity = 1 and weightG = totalWeight.
   *     Setting quantity = 1 (not totalPieces) guarantees compute's
   *     silverAmount = totalWeight × silverRate stays exact — no
   *     rounding drift from dividing the average weight by pieces at
   *     3-decimal precision and multiplying it back.
   *   - Description carries the piece count so the customer still sees
   *     it on the printed bill.
   *
   * The temp does NOT touch AR balance (same as QUOTE / DELIVERY_CHALLAN).
   * If a real TAX_INVOICE gets issued later, it's a fresh record — the
   * temp stays around for history and can be manually deleted.
   */
  async generateTempFromEstimate(estimateId: number, userId?: number) {
    const src = await this.getInvoice(estimateId);
    if (src.type !== 'QUOTE' && src.type !== 'ESTIMATE') {
      throw new BadRequestException(`Temp invoice can only be generated from an Estimate (got ${src.type}).`);
    }
    if (src.items.length === 0) {
      throw new BadRequestException('Estimate has no line items — nothing to consolidate.');
    }
    // Idempotent: pressing "Generate Temp" more than once on the same estimate
    // must NOT increment the invoice-number sequence. Look up any existing
    // temp for this estimate; if one exists and no payments have landed on it,
    // delete it so the fresh regeneration reuses the same invoice number.
    // A paid / allocated temp is preserved as-is and returned unchanged.
    const existingTemp = await this.prisma.invoice.findFirst({
      where: { sourceEstimateId: src.id, type: 'TEMP_INVOICE' as any },
      orderBy: { createdAt: 'desc' },
    });
    let mirrorNumber: string | null = null;
    if (existingTemp) {
      if (Number(existingTemp.paidAmount) > 0) {
        // A payment already landed — leave it alone.
        return this.getInvoice(existingTemp.id);
      }
      mirrorNumber = existingTemp.invoiceNumber;
      // Hand-delete cascade rows then the temp itself so the mirrored number
      // frees up for reuse.
      await this.prisma.paymentAllocation.deleteMany({ where: { invoiceId: existingTemp.id } });
      await this.prisma.invoiceCharge.deleteMany({ where: { invoiceId: existingTemp.id } });
      await this.prisma.invoiceItem.deleteMany({ where: { invoiceId: existingTemp.id } });
      await this.prisma.invoice.delete({ where: { id: existingTemp.id } });
    }
    // First-time generation: mirror the estimate's numeric suffix so the temp
    // shares its identity with the source. EST0007 → INV-000007 (temp uses
    // its own INV- prefix now; 6-digit pad). If the derived number is
    // already taken by another temp, fall back to auto.
    if (!mirrorNumber) {
      const suffix = String(src.invoiceNumber ?? '').match(/(\d+)$/);
      if (suffix) {
        const pad = this.padFor('TEMP_INVOICE');
        const candidate = this.prefixFor('TEMP_INVOICE') + suffix[1].padStart(pad, '0');
        const clash = await this.prisma.invoice.findUnique({ where: { invoiceNumber: candidate } });
        if (!clash) mirrorNumber = candidate;
      }
    }

    const line = this.buildConsolidatedLine(src);
    const silverRate = Number(src.silverRatePerG);

    // Temp invoice date MUST match the parent estimate's date, not
    // "today". Because a temp is regenerated in place every time the
    // operator opens the estimate and hits "Generate Temp" (see
    // existingTemp deletion above), using `new Date()` would silently
    // walk the date forward on every open — the customer's temp bill
    // would show today, not the day the estimate was issued.
    const estimateDate = new Date(src.invoiceDate).toISOString().slice(0, 10);
    const dto: CreateInvoiceDto = {
      type: 'TEMP_INVOICE' as any,
      invoiceNumber: mirrorNumber ?? undefined,
      invoiceDate: estimateDate,
      customerId: src.customerId ?? undefined,
      placeOfSupply: src.placeOfSupply ?? undefined,
      silverRatePerG: silverRate,
      makingRatePerG: Number(src.makingRatePerG),
      gstPercent: Number(src.gstPercent),
      isInterState: src.isInterState,
      ratesFixed: true,
      lines: [line as any],
      // Notes never say "temp" — the printed PDF is presented as a
       // normal invoice; the temp status lives only in the software.
      notes: `Generated from Estimate ${src.invoiceNumber}. Final invoice to follow.`,
    };

    const created = await this.createInvoice(dto, userId);
    // Set the back-link so future lookups can trace the temp to its estimate.
    await this.prisma.invoice.update({
      where: { id: created.id },
      data: { sourceEstimateId: src.id },
    });
    return this.getInvoice(created.id);
  }

  /**
   * Raise an ABN-series tax invoice for silver received from a customer,
   * spread across one or more of that customer's OPEN/PARTIAL estimates.
   *
   * Invoice shape (matches Temp Invoice's consolidated form): a single
   * "Silver — X grams" line whose weight equals Σ(coverages.silverAllocatedG).
   * The printed invoice reads like a normal tax invoice; the
   * per-estimate breakdown lives in the InvoiceEstimateCoverage rows and
   * surfaces on the estimate list as "Alloc.g" + status.
   *
   * Guards:
   *  - Every covered estimate must belong to `customerId`, be a
   *    QUOTE/ESTIMATE, and not CANCELLED.
   *  - No coverage may push an estimate's Σ(alloc) past its required
   *    silver grams — over-allocation is rejected at save.
   *  - At least one coverage row and at least one gram in total.
   */
  async raiseMetalInvoice(
    dto: {
      customerId: number;
      invoiceDate: string;
      silverRatePerG: number;
      coverages: { estimateId: number; silverAllocatedG: number }[];
      notes?: string;
      dueDate?: string;
      gstPercent?: number;
      isInterState?: boolean;
    },
    userId?: number,
  ) {
    if (!dto.coverages?.length) {
      throw new BadRequestException('At least one estimate coverage is required.');
    }
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const totalGrams = r3(dto.coverages.reduce((s, c) => s + Number(c.silverAllocatedG ?? 0), 0));
    if (totalGrams <= 0) {
      throw new BadRequestException('Total covered grams must be positive.');
    }
    if (!(Number(dto.silverRatePerG) > 0)) {
      throw new BadRequestException('silverRatePerG must be positive.');
    }

    const customer = await this.getCustomer(dto.customerId);

    // Load every covered estimate + its existing coverages + line items
    // in ONE query so validation runs in memory without N round trips.
    const estimateIds = dto.coverages.map((c) => c.estimateId);
    const estimates = await this.prisma.invoice.findMany({
      where: { id: { in: estimateIds } },
      include: {
        items: { select: { quantity: true, weightG: true } },
        coveredBy: { select: { silverAllocatedG: true } },
      },
    });
    const byId = new Map(estimates.map((e) => [e.id, e]));

    for (const cov of dto.coverages) {
      const est = byId.get(cov.estimateId);
      if (!est) throw new BadRequestException(`Estimate ${cov.estimateId} not found.`);
      if (est.type !== 'QUOTE' && est.type !== 'ESTIMATE') {
        throw new BadRequestException(`${est.invoiceNumber} is not an estimate (type=${est.type}).`);
      }
      if (est.status === 'CANCELLED') {
        throw new BadRequestException(`${est.invoiceNumber} is CANCELLED — cannot cover it.`);
      }
      if (est.customerId !== dto.customerId) {
        throw new BadRequestException(`${est.invoiceNumber} belongs to a different customer.`);
      }
      const g = Number(cov.silverAllocatedG ?? 0);
      if (!(g > 0)) {
        throw new BadRequestException(`${est.invoiceNumber}: coverage grams must be positive.`);
      }
      // Silver required = Σ(qty × weightG) or the header override.
      const derivedWt = est.items.reduce(
        (s, it) => s + Number(it.quantity ?? 0) * Number(it.weightG ?? 0),
        0,
      );
      const required = r3(
        est.totalWeightG != null && Number(est.totalWeightG) > 0
          ? Number(est.totalWeightG)
          : derivedWt,
      );
      const already = r3(est.coveredBy.reduce((s, c) => s + Number(c.silverAllocatedG), 0));
      if (already + g > required + 0.0005) {
        throw new BadRequestException(
          `${est.invoiceNumber}: coverage over the requirement — needs ${required.toFixed(3)} g, already ${already.toFixed(3)} g, this ${g.toFixed(3)} g would exceed.`,
        );
      }
    }

    // Build the consolidated silver line — same shape as a Temp Invoice's
    // single-line summary. The description names the estimates it covers so
    // the printed invoice reads like a real tax invoice.
    const covered = dto.coverages
      .map((c) => byId.get(c.estimateId)!.invoiceNumber)
      .join(', ');
    const rate = Number(dto.silverRatePerG);
    const silverAmount = Math.round(totalGrams * rate * 100) / 100;

    const line: any = {
      description: `Silver — covers ${covered}`,
      quantity: 1,
      weightG: totalGrams,
      totalWeightG: totalGrams,
      silverRatePerG: rate,
      makingRatePerG: 0,
    };

    // Delegate to createInvoice for tax/GST math + numbering + AR debit,
    // then attach coverage rows in the same transaction as the returned
    // invoice's back-link update.
    const invoiceDto: any = {
      type: 'TAX_INVOICE',
      customerId: dto.customerId,
      invoiceDate: dto.invoiceDate,
      dueDate: dto.dueDate,
      silverRatePerG: rate,
      makingRatePerG: 0,
      gstPercent: dto.gstPercent ?? 0,
      isInterState: dto.isInterState ?? false,
      ratesFixed: true,
      lines: [line],
      notes: dto.notes ?? `Metal received — covers ${covered}.`,
      status: 'ISSUED',
    };
    const created = await this.createInvoice(invoiceDto, userId);

    // Insert coverage rows now that the invoice id exists. Any failure here
    // leaves an orphaned invoice — acceptable for MVP; the operator can
    // cancel it. A pure $transaction across createInvoice + coverages would
    // need to inline createInvoice, which is 200 lines of ratesFixed / GST /
    // AR-debit logic; deferring that refactor.
    await this.prisma.invoiceEstimateCoverage.createMany({
      data: dto.coverages.map((c) => ({
        invoiceId: created.id,
        estimateId: c.estimateId,
        silverAllocatedG: r3(Number(c.silverAllocatedG)),
      })),
    });
    // Silver-amount total should equal grams × rate — sanity check
    // (createInvoice's compute already ran, so this is documentation).
    void silverAmount;

    return this.getInvoice(created.id);
  }

  async listInvoices(q: { type?: InvoiceTypeStr; customerId?: number; status?: string; search?: string; fromDate?: string; toDate?: string }) {
    const where: Prisma.InvoiceWhereInput = {};
    if (q.type) where.type = q.type as any;
    if (q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = q.status as any;
    if (q.fromDate || q.toDate) {
      where.invoiceDate = {
        ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
        ...(q.toDate ? { lte: new Date(q.toDate + 'T23:59:59.999Z') } : {}),
      };
    }
    if (q.search) {
      where.OR = [
        { invoiceNumber: { contains: q.search, mode: 'insensitive' } },
        { billToName:    { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.invoice.findMany({
      where,
      include: {
        customer: true,
        items: { select: { quantity: true, weightG: true } },
      },
      // Ascending by date so the oldest bill sits at the top and the
      // sequence (ABN-000001, ABN-000002, …) reads top-to-bottom, matching
      // how operators think about invoice history.
      orderBy: { invoiceDate: 'asc' },
      take: 200,
    });

    // Estimates carry silver-requirement + allocated-so-far tallies so the
    // list page can render status without a second call. Allocated grams are
    // aggregated from InvoiceEstimateCoverage in ONE groupBy keyed by the
    // estimate id — flat cost regardless of how many estimates are showing.
    const isEstimateList = q.type === 'QUOTE' || q.type === 'ESTIMATE';
    const invoiceIds = rows.map((r) => r.id);
    const allocByEstimate = new Map<number, number>();
    if (isEstimateList && invoiceIds.length) {
      const groups = await this.prisma.invoiceEstimateCoverage.groupBy({
        by: ['estimateId'],
        where: { estimateId: { in: invoiceIds } },
        _sum: { silverAllocatedG: true },
      });
      for (const g of groups) {
        allocByEstimate.set(g.estimateId, Number(g._sum.silverAllocatedG ?? 0));
      }
    }

    // Attach summary totals so the list page can render them without loading
    // full item arrays into the UI. totalWeightG (header override) wins over
    // the derived sum when it's set; otherwise fall back to Σ(qty × wt/pc).
    return rows.map((inv) => {
      const derivedWt = inv.items.reduce(
        (s, it) => s + Number(it.quantity ?? 0) * Number(it.weightG ?? 0),
        0,
      );
      const totalPieces = inv.items.reduce((s, it) => s + Number(it.quantity ?? 0), 0);
      const totalWeight = inv.totalWeightG != null && Number(inv.totalWeightG) > 0
        ? Number(inv.totalWeightG)
        : derivedWt;
      const { items, ...rest } = inv;
      const summary: any = {
        totalPieces,
        totalWeightG: Math.round(totalWeight * 1000) / 1000,
        lineCount: items.length,
      };
      if (isEstimateList) {
        const required  = Math.round(totalWeight * 1000) / 1000;
        const allocated = Math.round((allocByEstimate.get(inv.id) ?? 0) * 1000) / 1000;
        const status =
          allocated <= 0                    ? 'OPEN'
          : allocated + 0.0005 >= required  ? 'CLOSED'
          : 'PARTIAL';
        summary.silverRequiredG  = required;
        summary.silverAllocatedG = allocated;
        summary.silverStatus     = status;
      }
      return { ...rest, summary };
    });
  }

  async getInvoice(id: number) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: true, customer: true, allocations: { include: { payment: true } } },
    });
    if (!inv) throw new NotFoundException('Invoice not found.');
    return inv;
  }

  async cancelInvoice(id: number) {
    const inv = await this.getInvoice(id);
    if (inv.status === 'CANCELLED') return inv;
    if (Number(inv.paidAmount) > 0) {
      throw new BadRequestException('Cannot cancel — payments already allocated. Reverse the payments first.');
    }
    await this.prisma.$transaction([
      this.prisma.invoice.update({
        where: { id },
        data: { status: 'CANCELLED', balanceAmount: 0 },
      }),
      ...(inv.type !== 'DELIVERY_CHALLAN' && inv.customerId != null && inv.status !== 'DRAFT'
        ? [this.prisma.customer.update({
            where: { id: inv.customerId },
            data: { balance: { decrement: Number(inv.totalAmount) } },
          })]
        : []),
    ]);
    return this.getInvoice(id);
  }

  /** Hard delete — for operator testing only. Removes the invoice row +
   *  all dependent items / charges / allocations and unwinds AR impact.
   *  Cancel is the production-safe path; delete should ship behind a flag
   *  once testing is done. */
  async deleteInvoice(id: number) {
    const inv = await this.getInvoice(id);
    if (Number(inv.paidAmount) > 0) {
      throw new BadRequestException('Cannot delete — payments allocated. Reverse the payments first.');
    }
    const affectsAR =
      inv.status !== 'CANCELLED' &&
      inv.status !== 'DRAFT' &&
      inv.customerId != null &&
      (inv.type === 'TAX_INVOICE' || inv.type === 'SALES_ORDER' || inv.type === 'CREDIT_NOTE' || inv.type === 'ESTIMATE');
    await this.prisma.$transaction(async (tx) => {
      // Reverse the customer-balance debit that createInvoice applied. Credit
      // notes reversed in the opposite direction.
      if (affectsAR) {
        const delta = inv.type === 'CREDIT_NOTE' ? Number(inv.totalAmount) : -Number(inv.totalAmount);
        await tx.customer.update({
          where: { id: inv.customerId! },
          data: { balance: { increment: delta } },
        });
      }
      // Cascade deletes via FKs (PaymentAllocation/InvoiceCharge/InvoiceItem
      // are all onDelete: Cascade on Invoice).
      await tx.invoice.delete({ where: { id } });
    });
    return { id };
  }

  /**
   * Edit an existing invoice — replaces items + charges + header rates
   * and recomputes totals. Unwinds the OLD AR impact then applies the
   * NEW impact so the customer balance stays consistent.
   *
   * Guards (stop the operator from silently breaking the ledger):
   *   - Cannot edit if any payment has been allocated (paidAmount > 0).
   *     Fix path: reverse the payments first, then edit.
   *   - Cannot edit CANCELLED invoices (would resurrect them).
   *   - Cannot change the invoice TYPE (that path is 'convert', which
   *     mints a new number). Type stays whatever it was.
   *   - Convertfrom link + sourceEstimateId link are preserved.
   */
  async updateInvoice(id: number, dto: CreateInvoiceDto, userId?: number) {
    const src = await this.getInvoice(id);
    if (Number(src.paidAmount) > 0) {
      throw new BadRequestException(
        `Cannot edit — ₹${src.paidAmount} already paid & allocated. Reverse the payment first.`,
      );
    }
    if (src.status === 'CANCELLED') {
      throw new BadRequestException('Cancelled invoices cannot be edited.');
    }
    // Recompute against the incoming DTO. Silver/making rate no longer
    // mandatory per line — see create() for rationale (charge-only rows
    // like "delivery fee" or "rework labor" carry only additionalPerPc).
    const c = this.compute(dto);
    // New status (may promote DRAFT → READY → ISSUED) — falls back to the
    // existing status if not provided.
    const newStatus = ((dto as any).status ?? src.status) as string;
    const effectiveCustomerId = dto.customerId ?? src.customerId ?? null;
    if (newStatus !== 'DRAFT' && effectiveCustomerId == null) {
      throw new BadRequestException(
        'A customer is required for READY / ISSUED status. Pick one on the invoice form or keep the status as DRAFT.',
      );
    }
    const newCustomer = effectiveCustomerId != null
      ? await this.getCustomer(effectiveCustomerId)
      : null;
    // Optional manual invoice-number override — only accept if it actually
    // changes and doesn't collide with another row.
    const forced = ((dto as any).invoiceNumber as string | undefined)?.trim();
    let newInvoiceNumber: string | undefined = undefined;
    if (forced && forced !== src.invoiceNumber) {
      const clash = await this.prisma.invoice.findUnique({ where: { invoiceNumber: forced } });
      if (clash && clash.id !== id) {
        throw new BadRequestException(`Invoice number "${forced}" already exists.`);
      }
      newInvoiceNumber = forced;
    }
    // AR affects only when the invoice is issued (not DRAFT) AND has a customer.
    const typeAffectsAR =
      src.type === 'TAX_INVOICE' || src.type === 'SALES_ORDER' ||
      src.type === 'CREDIT_NOTE' || src.type === 'ESTIMATE';
    const wasAffectingAR = typeAffectsAR && src.status !== 'DRAFT' && src.customerId != null;
    const nowAffectsAR = typeAffectsAR && newStatus !== 'DRAFT' && effectiveCustomerId != null;
    const oldDelta = wasAffectingAR
      ? (src.type === 'CREDIT_NOTE' ? -Number(src.totalAmount) : Number(src.totalAmount))
      : 0;
    const newDelta = nowAffectsAR
      ? (src.type === 'CREDIT_NOTE' ? -c.total : c.total)
      : 0;
    const customerSwitched = wasAffectingAR
      && nowAffectsAR
      && src.customerId !== effectiveCustomerId;

    // Auto-draft bounce — if this edit strips a line off a DRAFT invoice
    // that came from the packing auto-sync, the removed line hops to the
    // next unassigned draft (or spawns one). Snapshot the pre-edit rows
    // now so we can diff after the transaction commits.
    const isDraftBounceCandidate = src.status === 'DRAFT' && src.type === 'QUOTE';
    const preRemoveLines = isDraftBounceCandidate
      ? src.items
          .filter((l: any) => l.itemId != null)
          .map((l: any) => ({
            itemId: l.itemId as number,
            itemNumber: l.itemNumber ?? null,
            description: l.description,
            weightG: Number(l.weightG ?? 0),
            extraAmount: l.extraAmount != null ? Number(l.extraAmount) : null,
          }))
      : [];

    await this.prisma.$transaction(async (tx) => {
      // Wipe the old rows — items + charges cascade OFF; we hand-delete
      // so the replaced set doesn't collide with the new create-many.
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceCharge.deleteMany({ where: { invoiceId: id } });
      // Header patch. Type NEVER changes — src.type wins. Rates + totals
      // + line snapshots all re-hydrate from `compute`.
      const billToAddress = newCustomer
        ? [
            newCustomer.addressLine1, newCustomer.addressLine2,
            [newCustomer.city, newCustomer.state, newCustomer.pincode].filter(Boolean).join(', '),
          ].filter(Boolean).join('\n')
        : '';
      await tx.invoice.update({
        where: { id },
        data: {
          ...(newInvoiceNumber ? { invoiceNumber: newInvoiceNumber } : {}),
          status: newStatus as any,
          customerId: effectiveCustomerId,
          billToName: newCustomer?.customerName ?? '(unassigned)',
          billToAddress,
          billToGstin: newCustomer?.gstin ?? null,
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          placeOfSupply: dto.placeOfSupply ?? newCustomer?.state ?? null,
          silverRatePerG: Number(dto.silverRatePerG ?? 0),
          makingRatePerG: Number(dto.makingRatePerG ?? 0),
          gstPercent: c.gstPct,
          isInterState: c.interState,
          laborDiscountPercent: c.laborDiscountPct > 0 ? c.laborDiscountPct : null,
          chargesTotal: c.chargesTotal,
          subtotal: c.subtotal,
          cgstAmount: c.cgst,
          sgstAmount: c.sgst,
          igstAmount: c.igst,
          roundOff: c.roundOff,
          totalAmount: c.total,
          balanceAmount: c.isChallan ? 0 : c.total, // paidAmount is 0 (guard above)
          notes: dto.notes ?? null,
        totalWeightG: dto.totalWeightG != null ? dto.totalWeightG : null,
        purpose: dto.purpose ?? null,
          items: {
            create: c.lines.map((l: any) => ({
              itemId: l.itemId ?? null,
              itemNumber: l.itemNumber ?? null,
              description: l.description,
              hsnCode: l.hsnCode ?? null,
              quantity: l.quantity,
              weightG: l.weightG,
              silverRatePerG: l.silverRatePerG,
              makingRatePerG: l.makingRatePerG,
              silverAmount: l.silverAmount,
              makingAmount: l.makingAmount,
              lineAmount: l.lineAmount,
              notes: l.notes ?? null,
              lessWeightG:       l.lessWeightG ?? null,
              netWeightG:        l.netWeightG ?? null,
              purity:            l.purity ?? null,
              fineWeightG:       l.fineWeightG ?? null,
              wastagePercent:    l.wastagePercent ?? null,
              wastageFineG:      l.wastageFineG ?? null,
              boxWeightG:        l.boxWeightG ?? null,
              bagWeightG:        l.bagWeightG ?? null,
              tagWeightG:        l.tagWeightG ?? null,
              padWeightG:        l.padWeightG ?? null,
              totalGrossWeightG: l.totalGrossWeightG ?? null,
              totalWeightG:      (l as any).totalWeightG ?? null,
              size:              l.size ?? null,
              category:          l.category ?? null,
              plating:           l.plating ?? null,
              laborOn:           l.laborOn ?? null,
              laborRateWithTax:    l.laborRateWithTax ?? null,
              laborRateWithoutTax: l.laborRateWithoutTax ?? null,
              laborAmount:       l.laborAmount ?? null,
              extraAmount:       l.extraAmount ?? null,
              extraDescription:  (l as any).extraDescription ?? null,
              fineAmount:        l.fineAmount ?? null,
              packetNo:          l.packetNo ?? null,
              productionOrderRef: l.productionOrderRef ?? null,
              boxRef:            l.boxRef ?? null,
              barcode:           l.barcode ?? null,
            } as any)),
          },
        },
      });
      // Header-level charges reinserted.
      if (Array.isArray(dto.charges) && dto.charges.length > 0) {
        await tx.invoiceCharge.createMany({
          data: dto.charges
            .filter((cc) => Number(cc.amount) > 0 && cc.chargeTypeId)
            .map((cc) => ({
              invoiceId: id,
              chargeTypeId: cc.chargeTypeId,
              label: cc.label ?? null,
              amount: Number(cc.amount),
            })),
        });
      }
      // AR balance rebase — when the customer is unchanged, one net delta
      // suffices. When the customer *switched*, credit the old and debit the
      // new so each ledger stays honest.
      if (customerSwitched) {
        if (oldDelta !== 0 && src.customerId != null) {
          await tx.customer.update({
            where: { id: src.customerId },
            data: { balance: { increment: -oldDelta } },
          });
        }
        if (newDelta !== 0 && effectiveCustomerId != null) {
          await tx.customer.update({
            where: { id: effectiveCustomerId },
            data: { balance: { increment: newDelta } },
          });
        }
      } else {
        const netDelta = newDelta - oldDelta;
        const targetId = effectiveCustomerId ?? src.customerId;
        if (netDelta !== 0 && targetId != null) {
          await tx.customer.update({
            where: { id: targetId },
            data: { balance: { increment: netDelta } },
          });
        }
      }
    });

    // Bounce phase — compute which auto-sync lines the operator removed
    // from this DRAFT and route them into the next unassigned draft.
    // "New keys" is what's in the DTO now; anything in pre-set but not
    // in new-set is a removal. Only ItemIds carry over (the auto-sync
    // lines from packing always have itemId set).
    if (preRemoveLines.length > 0) {
      const newKeys = new Set(
        (dto.lines ?? [])
          .filter((l: any) => l.itemId != null)
          .map((l: any) => `${l.itemId}:${l.itemNumber ?? ''}`),
      );
      const removed = preRemoveLines.filter(
        (l) => !newKeys.has(`${l.itemId}:${l.itemNumber ?? ''}`),
      );
      if (removed.length > 0) {
        // Non-blocking: bounce failures never revert the successful edit.
        try {
          await this.bounceLinesToNextDraft(removed, id, userId);
        } catch {
          /* swallow — the primary edit already committed cleanly */
        }
      }
    }

    return this.getInvoice(id);
  }

  /**
   * Route "orphan" lines (removed from a DRAFT unassigned QUOTE) into
   * the next open unassigned draft. Finds a different DRAFT than the
   * source, or creates a fresh one if none exists. Idempotent on
   * (itemId, itemNumber) so the same variant never lands twice.
   */
  private async bounceLinesToNextDraft(
    lines: Array<{ itemId: number; itemNumber: string | null; description: string; weightG: number; extraAmount: number | null }>,
    excludeInvoiceId: number,
    userId?: number,
  ) {
    if (lines.length === 0) return;
    // Find or create the destination draft — must NOT be the invoice we
    // just removed from.
    let dest = await this.prisma.invoice.findFirst({
      where: {
        customerId: null,
        status: 'DRAFT' as any,
        type: 'QUOTE' as any,
        id: { not: excludeInvoiceId },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!dest) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const invoiceNumber = await nextCode(this.prisma, 'invoice', 'invoiceNumber', 'EST', 4);
        try {
          dest = await this.prisma.invoice.create({
            data: {
              invoiceNumber,
              type: 'QUOTE' as any,
              status: 'DRAFT' as any,
              invoiceDate: new Date(),
              customerId: null,
              billToName: '(unassigned)',
              billToAddress: '',
              billToGstin: null,
              placeOfSupply: null,
              silverRatePerG: 0,
              makingRatePerG: 0,
              gstPercent: 3,
              isInterState: false,
              chargesTotal: 0,
              subtotal: 0,
              cgstAmount: 0,
              sgstAmount: 0,
              igstAmount: 0,
              roundOff: 0,
              totalAmount: 0,
              paidAmount: 0,
              balanceAmount: 0,
              notes: 'Auto-generated draft from bounced lines. Tag a customer + set status to READY to convert.',
              createdById: userId ?? null,
            },
          });
          break;
        } catch (e: any) {
          const target = Array.isArray(e?.meta?.target) ? e.meta.target : [e?.meta?.target];
          const isNumberClash = e?.code === 'P2002'
            && target.some((t: string) => t?.includes('invoiceNumber'));
          if (!isNumberClash) throw e;
          /* retry with fresh nextCode */
        }
      }
      if (!dest) return; // Retries exhausted.
    }
    // Idempotent dedup on the destination.
    const already = await this.prisma.invoiceItem.findMany({
      where: {
        invoiceId: dest.id,
        itemId: { in: lines.map((l) => l.itemId) },
      },
      select: { itemId: true, itemNumber: true },
    });
    const existingKeys = new Set(already.map((l) => `${l.itemId}:${l.itemNumber ?? ''}`));
    const toAdd = lines
      .filter((l) => !existingKeys.has(`${l.itemId}:${l.itemNumber ?? ''}`))
      .map((l) => ({
        invoiceId: dest!.id,
        itemId: l.itemId,
        itemNumber: l.itemNumber,
        description: l.description,
        hsnCode: '71131110',
        quantity: 1,
        weightG: l.weightG,
        silverRatePerG: 0,
        makingRatePerG: 0,
        silverAmount: 0,
        makingAmount: 0,
        lineAmount: 0,
        extraAmount: l.extraAmount,
        notes: `Bounced from draft #${excludeInvoiceId}.`,
      }));
    if (toAdd.length > 0) {
      await this.prisma.invoiceItem.createMany({ data: toAdd });
    }
  }

  /** Back-compat shim — older route /invoices/:id/convert maps to TAX_INVOICE. */
  async convertEstimate(id: number, userId?: number) {
    return this.convertInvoice(id, 'TAX_INVOICE', userId);
  }

  // -------------------------------------------------------------------------
  // Payment — receipt + allocation against invoices
  // -------------------------------------------------------------------------

  async createPayment(dto: CreatePaymentDto, userId?: number) {
    const customer = await this.getCustomer(dto.customerId);
    const amount = r2(dto.amount);
    if (amount <= 0) throw new BadRequestException('Amount must be > 0.');
    // Validate allocations sum.
    const allocs = (dto.allocations ?? []).map((a) => ({
      invoiceId: a.invoiceId,
      amount: r2(a.amount),
    }));
    const allocSum = r2(allocs.reduce((s, a) => s + a.amount, 0));
    if (allocs.length && Math.abs(allocSum - amount) > 0.005) {
      throw new BadRequestException(
        `Allocations total ${allocSum} but payment is ${amount}. Either match or leave allocations empty for on-account.`,
      );
    }
    // Validate each allocation against the invoice's open balance.
    if (allocs.length) {
      const ids = allocs.map((a) => a.invoiceId);
      const invs = await this.prisma.invoice.findMany({ where: { id: { in: ids } } });
      const byId = new Map(invs.map((i) => [i.id, i]));
      for (const a of allocs) {
        const inv = byId.get(a.invoiceId);
        if (!inv) throw new BadRequestException(`Invoice ${a.invoiceId} not found.`);
        if (inv.customerId !== dto.customerId) {
          throw new BadRequestException(`Invoice ${inv.invoiceNumber} belongs to another customer.`);
        }
        if (inv.type === 'DELIVERY_CHALLAN') {
          throw new BadRequestException(`${inv.invoiceNumber} is a delivery challan — no money to allocate.`);
        }
        if (a.amount > Number(inv.balanceAmount) + 0.005) {
          throw new BadRequestException(
            `Allocation of ${a.amount} exceeds ${inv.invoiceNumber} balance of ${inv.balanceAmount}.`,
          );
        }
      }
    }
    const paymentNumber = await nextCode(this.prisma, 'payment', 'paymentNumber', 'RCT', 4);
    const created = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          paymentNumber,
          paymentDate: new Date(dto.paymentDate),
          customerId: dto.customerId,
          amount,
          mode: dto.mode as any,
          reference: dto.reference ?? null,
          notes: dto.notes ?? null,
          createdById: userId ?? null,
          allocations: {
            create: allocs.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
          },
        },
        include: { allocations: true },
      });
      for (const a of allocs) {
        const inv = await tx.invoice.findUnique({ where: { id: a.invoiceId } });
        if (!inv) continue;
        // Re-check status inside the transaction — a concurrent cancel
        // between our pre-validation and here would otherwise land the
        // allocation on a CANCELLED invoice.
        if (inv.status === 'CANCELLED') {
          throw new BadRequestException(
            `${inv.invoiceNumber} was cancelled while this payment was being posted. Reload and re-allocate.`,
          );
        }
        // Re-check available balance inside the transaction too — a
        // concurrent payment allocation elsewhere could have consumed some
        // of what our pre-check saw.
        if (a.amount > Number(inv.balanceAmount) + 0.005) {
          throw new BadRequestException(
            `${inv.invoiceNumber} balance is now ${inv.balanceAmount}; requested ${a.amount}. Reload and re-allocate.`,
          );
        }
        const newPaid = r2(Number(inv.paidAmount) + a.amount);
        const newBal = r2(Number(inv.totalAmount) - newPaid);
        await tx.invoice.update({
          where: { id: inv.id },
          data: {
            paidAmount: newPaid,
            balanceAmount: newBal,
            status: newBal <= 0.005 ? 'PAID' : inv.status,
          },
        });
      }
      await tx.customer.update({
        where: { id: dto.customerId },
        data: { balance: { decrement: amount } },
      });
      return p;
    });
    return created;
  }

  listPayments(q: { customerId?: number; search?: string }) {
    const where: Prisma.PaymentWhereInput = {};
    if (q.customerId) where.customerId = q.customerId;
    if (q.search) {
      where.OR = [
        { paymentNumber: { contains: q.search, mode: 'insensitive' } },
        { reference:     { contains: q.search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.payment.findMany({
      where,
      include: { customer: true, allocations: { include: { invoice: true } } },
      orderBy: { paymentDate: 'desc' },
      take: 200,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers for the create-invoice picker — list packed sales SKUs (ABN-XXXX)
  // available to invoice. Defaults to packed pieces (post-Packing). Falls
  // back to ALL items with an itemNumber if no FinishedGoodVariant exists.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Charge Type master — editable list for the "Add charge" picker on the
  // invoice form. Operator can grow it from the form when a new charge
  // (e.g. "Hamali", "Octroi") shows up.
  // -------------------------------------------------------------------------
  listChargeTypes() {
    return this.prisma.chargeType.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    });
  }

  async createChargeType(name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('Charge name cannot be empty.');
    const base = trimmed.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'CHARGE';
    let code = base;
    let n = 1;
    while (await this.prisma.chargeType.findUnique({ where: { code } })) {
      code = `${base}_${++n}`;
    }
    return this.prisma.chargeType.create({
      data: { code, name: trimmed, status: 'ACTIVE' },
    });
  }

  async invoiceablePieces() {
    const items = await this.prisma.item.findMany({
      where: { itemNumber: { not: null } },
      select: {
        id: true, itemNumber: true, itemName: true, sampleDesignCode: true,
        category: true,
        designParts: { select: { weightPerPc: true, qtyPerSet: true } },
        finishedVariants: { select: { totalPcs: true } },
      },
      orderBy: { itemNumber: 'asc' },
    });
    return items.map((it) => {
      const perPc = it.designParts.reduce(
        (s, p) => s + Number(p.weightPerPc ?? 0) * (p.qtyPerSet ?? 1),
        0,
      );
      const stockPcs = it.finishedVariants.reduce((s, v) => s + (v.totalPcs ?? 0), 0);
      return {
        itemId: it.id,
        itemNumber: it.itemNumber,
        sampleDesignCode: it.sampleDesignCode,
        description: it.itemName,
        category: it.category ?? null,
        perPieceWeightG: r3(perPc),
        stockPcs,
      };
    });
  }
}
