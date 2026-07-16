import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import {
  BillTypeStr, CreateBillDto, CreateVendorPaymentDto,
} from './dto/purchase.dto';

const r2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class PurchasesService {
  constructor(private prisma: PrismaService) {}

  private prefixFor(type: BillTypeStr) {
    switch (type) {
      case 'PURCHASE_ORDER': return 'PO';
      case 'BILL':           return 'BILL';
      case 'VENDOR_CREDIT':  return 'VC';
      case 'EXPENSE':        return 'EXP';
    }
  }

  private compute(dto: CreateBillDto) {
    const lines = dto.lines.map((l) => {
      const lineAmount = r2(Number(l.quantity) * Number(l.rate));
      return { ...l, lineAmount };
    });
    const subtotal = r2(lines.reduce((s, l) => s + l.lineAmount, 0));
    const gstPct = Number(dto.gstPercent ?? 3);
    const interState = !!dto.isInterState;
    const gstAmount = r2(subtotal * (gstPct / 100));
    const cgst = !interState ? r2(gstAmount / 2) : 0;
    const sgst = !interState ? r2(gstAmount - cgst) : 0;
    const igst = interState ? gstAmount : 0;
    const pre = r2(subtotal + cgst + sgst + igst);
    const total = Math.round(pre);
    const roundOff = r2(total - pre);
    return { lines, subtotal, gstPct, interState, cgst, sgst, igst, roundOff, total };
  }

  async createBill(dto: CreateBillDto, userId?: number) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: dto.vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found.');
    const c = this.compute(dto);
    const prefix = this.prefixFor(dto.type);
    const billNumber = await nextCode(this.prisma, 'invoice', 'invoiceNumber', prefix, 4)
      // billNumber is independent; just reuse the helper with the Invoice
      // delegate would clash. Use a dedicated query instead:
      .catch(() => '');
    const realBillNumber = await this.nextBillNumber(prefix);
    const vendorAddress = [
      (vendor as any).addressLine1, (vendor as any).addressLine2,
      [(vendor as any).city, (vendor as any).state, (vendor as any).pincode]
        .filter(Boolean).join(', '),
    ].filter(Boolean).join('\n');

    const created = await this.prisma.bill.create({
      data: {
        billNumber: realBillNumber,
        type: dto.type as any,
        status: 'ISSUED',
        billDate: new Date(dto.billDate),
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        vendorId: dto.vendorId,
        vendorName: vendor.vendorName,
        vendorAddress,
        vendorGstin: (vendor as any).gstin ?? null,
        vendorRefNumber: dto.vendorRefNumber ?? null,
        placeOfSupply: dto.placeOfSupply ?? null,
        gstPercent: c.gstPct,
        isInterState: c.interState,
        subtotal: c.subtotal,
        cgstAmount: c.cgst,
        sgstAmount: c.sgst,
        igstAmount: c.igst,
        roundOff: c.roundOff,
        totalAmount: c.total,
        paidAmount: 0,
        balanceAmount: dto.type === 'PURCHASE_ORDER' ? 0 : c.total,
        category: dto.category ?? null,
        notes: dto.notes ?? null,
        createdById: userId ?? null,
        items: {
          create: c.lines.map((l) => ({
            itemId: l.itemId ?? null,
            variantId: l.variantId ?? null,
            description: l.description,
            hsnCode: l.hsnCode ?? null,
            quantity: l.quantity,
            weightG: l.weightG ?? null,
            rate: l.rate,
            lineAmount: l.lineAmount,
            notes: l.notes ?? null,
          })),
        },
      },
      include: { items: true, vendor: true },
    });
    return created;
  }

  private async nextBillNumber(prefix: string) {
    const last = await this.prisma.bill.findFirst({
      where: { billNumber: { startsWith: prefix } },
      orderBy: { billNumber: 'desc' },
      select: { billNumber: true },
    });
    let next = 1;
    if (last?.billNumber) {
      const m = last.billNumber.match(/(\d+)$/);
      if (m) next = parseInt(m[1], 10) + 1;
    }
    return prefix + String(next).padStart(4, '0');
  }

  listBills(q: { type?: BillTypeStr; vendorId?: number; status?: string; search?: string; fromDate?: string; toDate?: string }) {
    const where: Prisma.BillWhereInput = {};
    if (q.type) where.type = q.type as any;
    if (q.vendorId) where.vendorId = q.vendorId;
    if (q.status) where.status = q.status as any;
    if (q.fromDate || q.toDate) {
      where.billDate = {
        ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
        ...(q.toDate ? { lte: new Date(q.toDate + 'T23:59:59.999Z') } : {}),
      };
    }
    if (q.search) {
      where.OR = [
        { billNumber:      { contains: q.search, mode: 'insensitive' } },
        { vendorName:      { contains: q.search, mode: 'insensitive' } },
        { vendorRefNumber: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.bill.findMany({
      where,
      include: { vendor: true },
      orderBy: { billDate: 'desc' },
      take: 200,
    });
  }

  async getBill(id: number) {
    const b = await this.prisma.bill.findUnique({
      where: { id },
      include: { items: true, vendor: true, allocations: { include: { payment: true } } },
    });
    if (!b) throw new NotFoundException('Bill not found.');
    return b;
  }

  async cancelBill(id: number) {
    const b = await this.getBill(id);
    if (b.status === 'CANCELLED') return b;
    if (Number(b.paidAmount) > 0) {
      throw new BadRequestException('Cannot cancel — payments already allocated. Reverse them first.');
    }
    await this.prisma.bill.update({
      where: { id },
      data: { status: 'CANCELLED', balanceAmount: 0 },
    });
    return this.getBill(id);
  }

  async convertPo(id: number, userId?: number) {
    const po = await this.getBill(id);
    if (po.type !== 'PURCHASE_ORDER') throw new BadRequestException('Only POs can be billed.');
    if (po.convertedFromId) throw new BadRequestException('Already converted.');
    const conv = await this.createBill({
      type: 'BILL',
      billDate: new Date().toISOString().slice(0, 10),
      vendorId: po.vendorId,
      vendorRefNumber: po.vendorRefNumber ?? undefined,
      placeOfSupply: po.placeOfSupply ?? undefined,
      gstPercent: Number(po.gstPercent),
      isInterState: po.isInterState,
      lines: po.items.map((i) => ({
        itemId: i.itemId ?? undefined,
        variantId: i.variantId ?? undefined,
        description: i.description,
        hsnCode: i.hsnCode ?? undefined,
        quantity: Number(i.quantity),
        weightG: i.weightG != null ? Number(i.weightG) : undefined,
        rate: Number(i.rate),
        notes: i.notes ?? undefined,
      })),
      notes: `Bill against ${po.billNumber}`,
    }, userId);
    await this.prisma.bill.update({ where: { id: conv.id }, data: { convertedFromId: po.id } });
    await this.prisma.bill.update({ where: { id: po.id }, data: { status: 'BILLED' } });
    return this.getBill(conv.id);
  }

  // ---- Vendor Payments ----
  async createVendorPayment(dto: CreateVendorPaymentDto, userId?: number) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: dto.vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found.');
    const amount = r2(dto.amount);
    if (amount <= 0) throw new BadRequestException('Amount must be > 0.');
    const allocs = (dto.allocations ?? []).map((a) => ({ billId: a.billId, amount: r2(a.amount) }));
    const allocSum = r2(allocs.reduce((s, a) => s + a.amount, 0));
    if (allocs.length && Math.abs(allocSum - amount) > 0.005) {
      throw new BadRequestException(`Allocations total ${allocSum} but payment is ${amount}.`);
    }
    if (allocs.length) {
      const bills = await this.prisma.bill.findMany({
        where: { id: { in: allocs.map((a) => a.billId) } },
      });
      const byId = new Map(bills.map((b) => [b.id, b]));
      for (const a of allocs) {
        const b = byId.get(a.billId);
        if (!b) throw new BadRequestException(`Bill ${a.billId} not found.`);
        if (b.vendorId !== dto.vendorId) {
          throw new BadRequestException(`Bill ${b.billNumber} belongs to another vendor.`);
        }
        if (b.type === 'PURCHASE_ORDER') {
          throw new BadRequestException(`${b.billNumber} is a PO — no money to allocate.`);
        }
        if (a.amount > Number(b.balanceAmount) + 0.005) {
          throw new BadRequestException(`Allocation ${a.amount} > ${b.billNumber} balance ${b.balanceAmount}.`);
        }
      }
    }
    const paymentNumber = await this.nextVendorPaymentNumber();
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.vendorPayment.create({
        data: {
          paymentNumber,
          paymentDate: new Date(dto.paymentDate),
          vendorId: dto.vendorId,
          amount,
          mode: dto.mode as any,
          reference: dto.reference ?? null,
          notes: dto.notes ?? null,
          createdById: userId ?? null,
          allocations: { create: allocs.map((a) => ({ billId: a.billId, amount: a.amount })) },
        },
      });
      for (const a of allocs) {
        const b = await tx.bill.findUnique({ where: { id: a.billId } });
        if (!b) continue;
        const newPaid = r2(Number(b.paidAmount) + a.amount);
        const newBal = r2(Number(b.totalAmount) - newPaid);
        await tx.bill.update({
          where: { id: b.id },
          data: {
            paidAmount: newPaid,
            balanceAmount: newBal,
            status: newBal <= 0.005 ? 'PAID' : b.status,
          },
        });
      }
      return p;
    });
  }

  private async nextVendorPaymentNumber() {
    const last = await this.prisma.vendorPayment.findFirst({
      where: { paymentNumber: { startsWith: 'VPAY' } },
      orderBy: { paymentNumber: 'desc' },
      select: { paymentNumber: true },
    });
    let next = 1;
    if (last?.paymentNumber) {
      const m = last.paymentNumber.match(/(\d+)$/);
      if (m) next = parseInt(m[1], 10) + 1;
    }
    return 'VPAY' + String(next).padStart(4, '0');
  }

  listVendorPayments(q: { vendorId?: number; search?: string }) {
    const where: Prisma.VendorPaymentWhereInput = {};
    if (q.vendorId) where.vendorId = q.vendorId;
    if (q.search) {
      where.OR = [
        { paymentNumber: { contains: q.search, mode: 'insensitive' } },
        { reference:     { contains: q.search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.vendorPayment.findMany({
      where,
      include: { vendor: true, allocations: { include: { bill: true } } },
      orderBy: { paymentDate: 'desc' },
      take: 200,
    });
  }
}
