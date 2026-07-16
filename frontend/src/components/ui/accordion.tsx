'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AccordionItemProps {
  id?: string;
  title: React.ReactNode;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function AccordionItem({ id, title, badge, defaultOpen, children }: AccordionItemProps) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  React.useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <div
      id={id}
      className={cn(
        'overflow-hidden rounded-lg border border-border transition-colors',
        open && 'border-gold/30',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold transition-colors',
          open
            ? 'bg-gold/[0.08] text-foreground'
            : 'bg-card hover:bg-secondary/40',
        )}
      >
        <span className="flex items-center gap-2">
          {open && <span className="size-1.5 rounded-full bg-gold shadow-[0_0_6px_hsl(var(--gold)/0.7)]" />}
          {title}
        </span>
        <span className="flex items-center gap-2">
          {badge}
          <ChevronDown
            className={cn('size-4 transition-transform text-gold/70', open && 'rotate-180')}
          />
        </span>
      </button>
      {open && (
        <div className="border-t border-border bg-card/60 px-4 py-4">{children}</div>
      )}
    </div>
  );
}

export function Accordion({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('space-y-2', className)}>{children}</div>;
}
