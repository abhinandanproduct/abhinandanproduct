import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import { UpsertVendorDto, VendorQueryDto } from './dto/vendor.dto';

@Injectable()
export class VendorsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Reject vendorName collisions BEFORE save. vendorCode is auto-generated
   * unique, but two vendors with name "Krishna" (codes V0001 and V0002) is a
   * data-quality bug — slips ship to the wrong vendor and payments get
   * mis-applied. Case-insensitive + whitespace-trimmed match.
   *
   * `excludeId` is the row currently being updated (so a vendor can save
   * their own existing name without tripping the check on themselves).
   */
  private async assertVendorNameUnique(rawName: string, excludeId?: number) {
    const name = (rawName ?? '').trim();
    if (!name) return; // basic-validation handles empty separately
    const existing = await this.prisma.vendor.findFirst({
      where: {
        vendorName: { equals: name },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true, vendorCode: true, vendorName: true },
    });
    if (existing) {
      throw new BadRequestException(
        `A vendor with the name "${existing.vendorName}" already exists (${existing.vendorCode}). Use a different name or open the existing record.`,
      );
    }
  }

  async findAll(query: VendorQueryDto) {
    const where: Prisma.VendorWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      // Case-insensitive deep search — every text column the operator
      // might remember, including the free-form notes on the vendor.
      const like = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { vendorName: like },
        { vendorCode: like },
        { shortName: like },
        { mobile: like },
        { contactPerson: like },
        { email: like },
        { address: like },
        { gstNumber: like },
        { notes: like },
      ];
    }
    const processId = query.processId ? Number(query.processId) : 0;
    if (processId > 0) {
      where.processes = { some: { processId } };
    }

    const vendors = await this.prisma.vendor.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { processes: { include: { process: true } } },
    });

    return vendors.map((v) => ({
      ...v,
      processNames: v.processes
        .map((p) => p.process.name)
        .sort()
        .join(', '),
      processIds: v.processes.map((p) => p.processId),
      processes: undefined,
    }));
  }

  async findOne(id: number) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id },
      include: { processes: true },
    });
    if (!vendor) throw new NotFoundException('Vendor not found.');
    return {
      ...vendor,
      processIds: vendor.processes.map((p) => p.processId),
      processes: undefined,
    };
  }

  async create(dto: UpsertVendorDto, userId?: number) {
    await this.assertVendorNameUnique(dto.vendorName);
    await this.enforceShortName(dto);
    const vendorCode = await nextCode(this.prisma, 'vendor', 'vendorCode', 'V', 4);
    const vendor = await this.prisma.vendor.create({
      data: {
        vendorCode,
        ...this.mapFields(dto),
        createdById: userId ?? null,
        processes: {
          create: (dto.processIds ?? []).map((processId) => ({ processId })),
        },
      },
    });
    return { id: vendor.id, vendorCode: vendor.vendorCode };
  }

  async update(id: number, dto: UpsertVendorDto) {
    await this.findOne(id);
    await this.assertVendorNameUnique(dto.vendorName, id);
    await this.enforceShortName(dto);
    await this.prisma.$transaction([
      this.prisma.vendor.update({ where: { id }, data: this.mapFields(dto) }),
      this.prisma.vendorProcess.deleteMany({ where: { vendorId: id } }),
      this.prisma.vendorProcess.createMany({
        data: (dto.processIds ?? []).map((processId) => ({
          vendorId: id,
          processId,
        })),
        skipDuplicates: true,
      }),
    ]);
    return { id };
  }

  /** Designer-role guard — any vendor linked to a process marked
   *  `requiresShortName=true` (CAM by default) must have a shortName. */
  private async enforceShortName(dto: UpsertVendorDto) {
    const ids = (dto.processIds ?? []).filter((n) => n > 0);
    if (!ids.length) return;
    const needers = await this.prisma.process.findMany({
      where: { id: { in: ids }, requiresShortName: true },
      select: { name: true },
    });
    if (needers.length === 0) return;
    if (!dto.shortName || !dto.shortName.trim()) {
      throw new BadRequestException(
        `Short name is required for vendors in ${needers.map((p) => p.name).join(' / ')} — used for the auto design code.`,
      );
    }
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.vendor.delete({ where: { id } });
    return { id };
  }

  private mapFields(dto: UpsertVendorDto) {
    return {
      vendorName: dto.vendorName,
      shortName: dto.shortName ?? null,
      isInhouse: dto.isInhouse ?? false,
      contactPerson: dto.contactPerson ?? null,
      mobile: dto.mobile ?? null,
      email: dto.email ?? null,
      address: dto.address ?? null,
      gstNumber: dto.gstNumber ?? null,
      panNumber: dto.panNumber ?? null,
      notes: dto.notes ?? null,
      status: dto.status ?? 'ACTIVE',
    };
  }
}
