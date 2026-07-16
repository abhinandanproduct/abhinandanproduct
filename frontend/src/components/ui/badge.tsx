import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Dark-theme badges: every variant uses an HSL-tinted background derived
// from the semantic accent token. Borders are a slightly stronger tint of
// the same hue so chips stay legible on the dark card surface.
const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors',
  {
    variants: {
      variant: {
        default:     'border-[hsl(var(--gold)/0.35)] bg-[hsl(var(--gold)/0.12)] text-gold-light',
        success:     'border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.12)] text-success',
        warning:     'border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.12)] text-warning',
        info:        'border-[hsl(var(--info)/0.35)] bg-[hsl(var(--info)/0.12)] text-info',
        secondary:   'border-border bg-secondary text-text-muted',
        destructive: 'border-[hsl(var(--destructive)/0.35)] bg-[hsl(var(--destructive)/0.12)] text-destructive',
        outline:     'border-border bg-transparent text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
