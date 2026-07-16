'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Gem, ShieldCheck, AlertCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { getApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';

const schema = z.object({
  login: z.string().min(1, 'Username or email is required'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const { user, login } = useAuth();
  const router = useRouter();
  const [error, setError] = React.useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  React.useEffect(() => {
    if (user) router.replace('/dashboard');
  }, [user, router]);

  const onSubmit = async (values: FormValues) => {
    setError('');
    try {
      await login(values.login, values.password);
      router.replace('/dashboard');
    } catch (e) {
      setError(getApiError(e).message);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-dark-1 p-4">
      {/* Decorative — soft gold glow + subtle grain. Pure CSS, no images. */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-1/4 top-1/4 size-[42rem] rounded-full bg-gold/10 blur-[120px]" />
        <div className="absolute -right-1/4 bottom-1/4 size-[36rem] rounded-full bg-info/5 blur-[120px]" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        {/* Card */}
        <div className="relative overflow-hidden rounded-2xl border border-gold/15 bg-card/90 shadow-2xl ring-1 ring-white/5 backdrop-blur-md">
          {/* Top gold accent */}
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" />

          <div className="p-8">
            <div className="mb-7 text-center">
              <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-gold to-gold-light text-primary-foreground shadow-[0_0_30px_-8px_hsl(var(--gold)/0.6)]">
                <Gem className="size-7" />
              </div>
              <h1 className="text-xl font-bold tracking-tight">Shree Abhinandan Product</h1>
              <p className="text-xs text-text-faint">(Pratik Product)</p>
              <p className="mt-1 text-sm italic text-text-faint">Jewellery made with emotions.</p>
              <div className="mx-auto mt-3 h-px w-12 bg-gradient-to-r from-transparent via-gold/50 to-transparent" />
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <Field label="Username or Email" required error={errors.login?.message}>
                <Input autoComplete="username" {...register('login')} />
              </Field>
              <Field label="Password" required error={errors.password?.message}>
                <Input type="password" autoComplete="current-password" {...register('password')} />
              </Field>

              {error && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? <Spinner className="text-primary-foreground" /> : <ShieldCheck className="size-4" />}
                Sign In
              </Button>
            </form>
          </div>

          {/* Footer */}
          <div className="border-t border-white/5 bg-secondary/20 px-8 py-3 text-center text-[11px] text-text-faint">
            92.5 Silver Manufacturing ERP · <span className="font-mono">v1.0</span>
          </div>
        </div>

        <p className="mt-5 text-center text-[11px] text-text-faint/70">
          Need access? Ask an administrator to provision your account.
        </p>
      </div>
    </div>
  );
}
