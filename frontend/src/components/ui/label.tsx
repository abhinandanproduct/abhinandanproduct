import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Form label — small uppercase tracking for the silvira look. Required
 * fields get a gold asterisk (not red — keeps the visual hierarchy
 * gentle; required is "expected", not "wrong").
 */
const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }
>(({ className, children, required, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      'inline-block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted',
      className,
    )}
    {...props}
  >
    {children}
    {required && <span className="ml-0.5 text-gold">*</span>}
  </label>
));
Label.displayName = 'Label';

export { Label };
