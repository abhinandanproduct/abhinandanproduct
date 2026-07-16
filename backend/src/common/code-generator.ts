import { PrismaService } from '../prisma/prisma.service';

/**
 * Two concurrent callers of `nextCode` can read the same MAX(field) before
 * either has inserted its row, so both come away with the same candidate
 * number. When the second one commits, Postgres raises a unique-constraint
 * violation (Prisma error code P2002) and the whole request fails.
 *
 * `withSequentialCode` wraps a create with an automatic retry: if the
 * insert raises P2002 on the sequential field, we regenerate the next
 * candidate and try again, up to `maxAttempts` times. This closes the race
 * without needing a Postgres sequence per prefix.
 */
export async function withSequentialCode<T>(
  prisma: PrismaService,
  model:
    | 'vendor' | 'material' | 'materialVariant' | 'castingBatch'
    | 'castingReceipt' | 'materialIssue' | 'customer' | 'invoice'
    | 'payment' | 'item',
  field: string,
  prefix: string,
  pad: number,
  create: (code: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = await nextCode(prisma, model, field, prefix, pad);
    try {
      return await create(code);
    } catch (e: any) {
      const isUniqueViolation =
        e?.code === 'P2002' &&
        (Array.isArray(e?.meta?.target)
          ? e.meta.target.includes(field)
          : String(e?.meta?.target ?? '').includes(field));
      if (!isUniqueViolation) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Generate the next sequential code for a model, e.g. "V0001", "M0001".
 * Reads the highest existing numeric tail for the given prefix.
 *
 * NOTE: Callers that use this to build a new row's primary code should
 * prefer `withSequentialCode()` above, which retries on collision. Use
 * `nextCode` directly only for display / preview / non-persisted values.
 */
export async function nextCode(
  prisma: PrismaService,
  model:
    | 'vendor'
    | 'material'
    | 'materialVariant'
    | 'castingBatch'
    | 'castingReceipt'
    | 'materialIssue'
    | 'customer'
    | 'invoice'
    | 'payment'
    | 'item',
  field: string,
  prefix: string,
  pad = 4,
): Promise<string> {
  const delegate = prisma[model] as any;
  const last = await delegate.findFirst({
    where: { [field]: { startsWith: prefix } },
    orderBy: { [field]: 'desc' },
    select: { [field]: true },
  });

  let next = 1;
  if (last && last[field]) {
    const tail = parseInt(String(last[field]).replace(/\D/g, ''), 10);
    if (!Number.isNaN(tail)) next = tail + 1;
  }
  return prefix + String(next).padStart(pad, '0');
}
