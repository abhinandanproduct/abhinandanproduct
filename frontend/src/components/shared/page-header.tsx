'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Page header — single line on desktop, stacked on phones.
 *
 * Below the title sits a thin gold accent rule that visually anchors the
 * header against the dark page background. The `description` (alias of
 * `subtitle`) renders below the title; both are optional.
 *
 * Backwards-compatible: accepts `action` (singular) and `actions` (plural)
 * as identical aliases — pages mounted before the rename still work.
 *
 * Optional `back` prop renders a "← Back" chip left of the title.
 *   - `back="/some/href"` → renders as a Link
 *   - `back={true}`        → renders as a button calling router.back()
 */
export function PageHeader({
  title,
  subtitle,
  description,
  actions,
  action,
  back,
  className,
}: {
  title: string;
  subtitle?: string;
  description?: string;
  actions?: React.ReactNode;
  action?: React.ReactNode;
  back?: string | true;
  className?: string;
}) {
  const sub = description ?? subtitle;
  const rhs = actions ?? action;
  const router = useRouter();
  const backChip = back ? (
    <BackChip
      href={typeof back === 'string' ? back : undefined}
      onClick={typeof back === 'string' ? undefined : () => router.back()}
    />
  ) : null;
  return (
    <div className={cn('mb-5', className)}>
      {backChip && <div className="mb-2">{backChip}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">
            {title}
          </h1>
          {sub && (
            <p className="mt-0.5 text-xs text-text-faint sm:text-sm">{sub}</p>
          )}
        </div>
        {rhs && <div className="flex flex-wrap items-center gap-2">{rhs}</div>}
      </div>
      <div className="mt-3 h-[1px] w-full bg-gradient-to-r from-gold/40 via-border to-transparent" />
    </div>
  );
}

function BackChip({ href, onClick }: { href?: string; onClick?: () => void }) {
  const cls = 'inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-gold/40 hover:text-foreground';
  if (href) {
    return (
      <Link href={href} className={cls}>
        <ArrowLeft className="size-3.5" /> Back
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      <ArrowLeft className="size-3.5" /> Back
    </button>
  );
}
