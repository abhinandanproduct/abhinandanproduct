import * as React from 'react';
import { cn } from '@/lib/utils';

export type CheckboxProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Checkbox — uses the gold accent via `accent-gold` so the check fill
 * matches the rest of the brand. Slightly larger hit target than the
 * browser default at the same visual size (cursor-pointer + bigger ring).
 */
const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, ...props }, ref) => (
    <input
      type="checkbox"
      ref={ref}
      className={cn(
        'size-4 cursor-pointer rounded border-input bg-secondary/40 text-gold accent-gold transition-shadow',
        'focus:outline-none focus:ring-2 focus:ring-gold/40 focus:ring-offset-2 focus:ring-offset-background',
        className,
      )}
      {...props}
    />
  ),
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
