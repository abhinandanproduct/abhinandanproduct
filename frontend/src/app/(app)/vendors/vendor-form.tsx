'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, SectionTitle } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import type { ProcessMeta, Vendor } from '@/lib/types';

const schema = z.object({
  vendorName: z.string().min(1, 'Vendor name is required').max(150),
  shortName: z.string().max(60).optional().or(z.literal('')),
  isInhouse: z.boolean().optional(),
  contactPerson: z.string().max(120).optional().or(z.literal('')),
  mobile: z.string().max(20).optional().or(z.literal('')),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  address: z.string().optional().or(z.literal('')),
  gstNumber: z.string().max(20).optional().or(z.literal('')),
  panNumber: z.string().max(15).optional().or(z.literal('')),
  notes: z.string().optional().or(z.literal('')),
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
type FormValues = z.infer<typeof schema>;

export function VendorForm({
  open,
  onClose,
  vendorId,
}: {
  open: boolean;
  onClose: () => void;
  vendorId: number | null;
}) {
  const qc = useQueryClient();
  const [processIds, setProcessIds] = React.useState<number[]>([]);

  const processesQ = useQuery<ProcessMeta[]>({
    queryKey: ['processes'],
    queryFn: () => Api.processes(),
    enabled: open,
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { status: 'ACTIVE' },
  });

  // Load vendor on edit, or reset on add.
  React.useEffect(() => {
    if (!open) return;
    if (vendorId) {
      Api.vendors.get(vendorId).then((v: Vendor) => {
        reset({
          vendorName: v.vendorName ?? '',
          shortName: v.shortName ?? '',
          isInhouse: !!(v as any).isInhouse,
          contactPerson: v.contactPerson ?? '',
          mobile: v.mobile ?? '',
          email: v.email ?? '',
          address: v.address ?? '',
          gstNumber: v.gstNumber ?? '',
          panNumber: v.panNumber ?? '',
          notes: v.notes ?? '',
          status: v.status,
        });
        setProcessIds(v.processIds ?? []);
      });
    } else {
      reset({ status: 'ACTIVE', vendorName: '' });
      setProcessIds([]);
    }
  }, [open, vendorId, reset]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      const body = { ...values, processIds };
      return vendorId ? Api.vendors.update(vendorId, body) : Api.vendors.create(body);
    },
    onSuccess: () => {
      toast.success(vendorId ? 'Vendor updated.' : 'Vendor created.');
      qc.invalidateQueries({ queryKey: ['vendors'] });
      onClose();
    },
    onError: (e) => {
      const { message, errors } = getApiError(e);
      if (errors) {
        Object.entries(errors).forEach(([k, v]) => setError(k as any, { message: v }));
      }
      toast.error(message);
    },
  });

  const toggleProcess = (id: number) =>
    setProcessIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={vendorId ? 'Edit Vendor' : 'Add Vendor'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button form="vendorForm" type="submit" disabled={isSubmitting}>
            {isSubmitting && <Spinner />} Save Vendor
          </Button>
        </>
      }
    >
      <form id="vendorForm" onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-5">
        <div>
          <SectionTitle>Basic Info</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Vendor Name" required error={errors.vendorName?.message}>
              <Input {...register('vendorName')} />
            </Field>
            <Field label="Short Name" error={errors.shortName?.message}>
              <Input {...register('shortName')} />
            </Field>
            <Field label="Contact Person" error={errors.contactPerson?.message}>
              <Input {...register('contactPerson')} />
            </Field>
            <Field label="Mobile" error={errors.mobile?.message}>
              <Input {...register('mobile')} />
            </Field>
            <Field label="Email" error={errors.email?.message}>
              <Input type="email" {...register('email')} />
            </Field>
            <Field label="Status">
              <Select {...register('status')}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
            <Field label="In-house" hint="Skip rate input on forwards to this vendor — used for owned/in-house teams.">
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" {...register('isInhouse')} className="size-4 accent-gold" />
                In-house vendor (no rate billing)
              </label>
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Textarea rows={2} {...register('address')} />
            </Field>
            <Field label="GST Number" error={errors.gstNumber?.message}>
              <Input {...register('gstNumber')} />
            </Field>
            <Field label="PAN Number" error={errors.panNumber?.message}>
              <Input {...register('panNumber')} />
            </Field>
          </div>
        </div>

        <div>
          <SectionTitle>Supported Processes</SectionTitle>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(processesQ.data ?? []).map((p) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/40"
              >
                <Checkbox
                  checked={processIds.includes(p.id)}
                  onChange={() => toggleProcess(p.id)}
                />
                {p.name}
              </label>
            ))}
          </div>
        </div>

        <div>
          <SectionTitle>Other</SectionTitle>
          <Field label="Notes">
            <Textarea rows={2} {...register('notes')} />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
