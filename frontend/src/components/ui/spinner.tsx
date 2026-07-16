import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Spinner — defaults to gold tint so loading states feel on-brand even
 * when callers don't pass a colour class. Override with `text-foreground`
 * etc. when context demands a neutral tone (e.g. inside a button).
 */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-gold', className)} />;
}
