import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Text / number input. Darker resting state matching Select, with a gold
 * focus ring + hover border so interactive controls feel cohesive across
 * the form. Number inputs lose the spin buttons (accidental clicks have
 * been a real source of wrong rates / qty in the field) and ignore
 * scroll-wheel increments when focused.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, onWheel, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-secondary/40 px-3 py-1 text-sm text-foreground transition-colors',
        'placeholder:text-text-faint',
        'hover:border-gold/40 focus-visible:border-gold/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/30',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
        '[&[type=number]]:[-moz-appearance:textfield] [&[type=number]::-webkit-inner-spin-button]:appearance-none [&[type=number]::-webkit-inner-spin-button]:m-0 [&[type=number]::-webkit-outer-spin-button]:appearance-none [&[type=number]::-webkit-outer-spin-button]:m-0',
        className,
      )}
      onWheel={(e) => {
        if (type === 'number') e.currentTarget.blur();
        onWheel?.(e);
      }}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
