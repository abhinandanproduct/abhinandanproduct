import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

@Injectable()
export class RecurringService {
  constructor(
    private prisma: PrismaService,
    private billing: BillingService,
  ) {}

  list() {
    return this.prisma.recurringInvoice.findMany({
      include: { customer: true },
      orderBy: { nextRunDate: 'asc' },
    });
  }

  async create(dto: {
    profileName: string;
    customerId: number;
    silverRatePerG?: number;
    makingRatePerG?: number;
    gstPercent?: number;
    isInterState?: boolean;
    frequency: Freq;
    startDate: string;
    lines: Array<{
      description: string;
      itemId?: number; itemNumber?: string; hsnCode?: string;
      quantity: number; weightG: number;
      silverRatePerG?: number; makingRatePerG?: number;
    }>;
    notes?: string;
  }, userId?: number) {
    return this.prisma.recurringInvoice.create({
      data: {
        profileName: dto.profileName,
        customerId: dto.customerId,
        silverRatePerG: dto.silverRatePerG ?? 0,
        makingRatePerG: dto.makingRatePerG ?? 0,
        gstPercent: dto.gstPercent ?? 3,
        isInterState: !!dto.isInterState,
        frequency: dto.frequency as any,
        nextRunDate: new Date(dto.startDate),
        linesJson: dto.lines as any,
        notes: dto.notes ?? null,
        createdById: userId ?? null,
      },
    });
  }

  async toggle(id: number, enabled: boolean) {
    return this.prisma.recurringInvoice.update({ where: { id }, data: { enabled } });
  }

  async runDue(userId?: number) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = await this.prisma.recurringInvoice.findMany({
      where: { enabled: true, nextRunDate: { lte: today } },
    });
    const out: Array<{ id: number; invoiceNumber: string }> = [];
    for (const r of due) {
      const lines = Array.isArray(r.linesJson) ? (r.linesJson as any[]) : [];
      if (!lines.length) continue;
      const inv = await this.billing.createInvoice({
        type: 'TAX_INVOICE',
        invoiceDate: today.toISOString().slice(0, 10),
        customerId: r.customerId,
        silverRatePerG: Number(r.silverRatePerG),
        makingRatePerG: Number(r.makingRatePerG),
        gstPercent: Number(r.gstPercent),
        isInterState: r.isInterState,
        lines: lines.map((l: any) => ({
          description: l.description,
          itemId: l.itemId,
          itemNumber: l.itemNumber,
          hsnCode: l.hsnCode,
          quantity: Number(l.quantity),
          weightG: Number(l.weightG),
          silverRatePerG: l.silverRatePerG != null ? Number(l.silverRatePerG) : undefined,
          makingRatePerG: l.makingRatePerG != null ? Number(l.makingRatePerG) : undefined,
        })),
        notes: `From recurring profile #${r.id} (${r.profileName})`,
      }, userId);
      const next = this.nextDate(today, r.frequency as Freq);
      await this.prisma.recurringInvoice.update({
        where: { id: r.id },
        data: { nextRunDate: next },
      });
      out.push({ id: r.id, invoiceNumber: inv.invoiceNumber });
    }
    return out;
  }

  private nextDate(from: Date, f: Freq): Date {
    const d = new Date(from);
    if (f === 'DAILY')   d.setDate(d.getDate() + 1);
    if (f === 'WEEKLY')  d.setDate(d.getDate() + 7);
    if (f === 'MONTHLY') d.setMonth(d.getMonth() + 1);
    if (f === 'QUARTERLY') d.setMonth(d.getMonth() + 3);
    if (f === 'YEARLY')  d.setFullYear(d.getFullYear() + 1);
    return d;
  }
}
