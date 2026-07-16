import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Form field wrapper: label + control + inline error message.
 *  Optional `action` renders inline next to the label — handy for "Add new"
 *  links that deep-link into a master page from a contextual form. */
export function Field({
  label,
  required,
  error,
  hint,
  children,
  className,
  action,
}: {
  label?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn('w-full', className)}>
      {(label || action) && (
        <div className="mb-1 flex items-center justify-between gap-2">
          {label ? <Label required={required}>{label}</Label> : <span />}
          {action}
        </div>
      )}
      {children}
      {hint && !error && <p className="mt-1 text-[11px] text-text-faint">{hint}</p>}
      {error && (
        <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-destructive">
          <span className="inline-block size-1 rounded-full bg-destructive" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Section title — small gold uppercase header with an accent rule below.
 * Used inside Cards to group related fields visually. Replaces the prior
 * primary-coloured title with the silvira-flavour gold accent.
 */
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 mt-1 flex items-center gap-2 border-b border-gold/20 pb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-gold">
      {children}
    </h3>
  );
}
