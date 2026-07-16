import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Card — silvira flavour. Slightly elevated surface with a faint inner
 * gold tint at the top edge so cards "catch the light" the same way the
 * reference dashboard's dark-2 panels do.
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // `min-w-0` on the Card itself so grid/flex parents don't force
        // it wider than their available column — the primary knock-on
        // fix for wide tables squishing narrow siblings.
        'relative min-w-0 rounded-xl border border-border bg-card text-card-foreground',
        // Subtle top-edge highlight — 1px of gold at 6% to mimic the
        // silvera reference. Disable on prefers-reduced-transparency.
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-xl before:bg-gradient-to-r before:from-transparent before:via-gold/20 before:to-transparent',
        'shadow-[0_1px_0_0_rgba(255,255,255,0.02)_inset]',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    // Padding shrinks on phones (p-4) then grows for desktop (p-5) — the
    // old flat p-5 wasted ~15% of a 380px viewport on padding alone.
    <div ref={ref} className={cn('flex flex-col space-y-1 p-4 sm:p-5', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('font-semibold leading-none tracking-tight', className)} {...props} />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    // Full padding on all sides — same responsive step as CardHeader.
    // Previously top-padding was 0 (assuming a CardHeader sat above),
    // but most cards in this app render CardContent standalone (filter
    // bars, action rows, standalone tables) and were losing their top
    // edge to the card border. Add top padding when explicitly not
    // paired with a CardHeader by defaulting to full p-4 / sm:p-5;
    // callers that DO pair with CardHeader can pass `pt-0` to remove.
    <div ref={ref} className={cn('p-4 sm:p-5', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export { Card, CardHeader, CardTitle, CardContent };
