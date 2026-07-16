'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';

/**
 * Quick-add customer button + dialog. Drop next to any SearchableSelect that
 * picks a customer. After save it calls onCreated with the new id so the
 * caller can auto-select it. Mirrors the inline material-add UX in the casting
 * material-issue forms.
 */
export function QuickAddCustomer({ onCreated }: { onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<any>({});
  const create = useMutation({
    mutationFn: () => Api.billing.createCustomer(form),
    onSuccess: (c: any) => {
      toast.success(`${c.customerName} added.`);
      qc.invalidateQueries({ queryKey: ['customers'] });
      onCreated(c.id);
      setOpen(false);
      setForm({});
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  return (
    <>
      <Button type="button" size="icon" variant="outline" className="shrink-0" onClick={() => setOpen(true)}
        title="Add new customer">
        <Plus className="size-4" />
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Quick add Customer"
        description="Just the essentials — full address/GSTIN can be filled later from Customer Master."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.customerName}>
              {create.isPending && <Spinner className="text-primary-foreground" />} Save & use
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer Name *" className="col-span-2">
            <Input value={form.customerName ?? ''} onChange={(e) => setForm({ ...form, customerName: e.target.value })} autoFocus />
          </Field>
          <Field label="GSTIN">
            <Input value={form.gstin ?? ''} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="State">
            <Input value={form.state ?? ''} onChange={(e) => setForm({ ...form, state: e.target.value })} />
          </Field>
          <Field label="State code">
            <Input maxLength={2} value={form.stateCode ?? ''} onChange={(e) => setForm({ ...form, stateCode: e.target.value })} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
