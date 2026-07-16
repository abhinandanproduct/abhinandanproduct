'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';

export function QuickAddVendor({ onCreated }: { onCreated: (id: number) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<any>({});
  const processesQ = useQuery<any[]>({
    queryKey: ['processes'],
    queryFn: () => Api.processes(),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: () => Api.vendors.create({
      vendorName: form.vendorName,
      shortName: form.shortName || undefined,
      gstin: form.gstin || undefined,
      phone: form.phone || undefined,
      city: form.city || undefined,
      state: form.state || undefined,
      processIds: form.processIds ?? [],
    }),
    onSuccess: (v: any) => {
      toast.success(`${v.vendorName ?? form.vendorName} added.`);
      qc.invalidateQueries({ queryKey: ['vendors'] });
      qc.invalidateQueries({ queryKey: ['vendors-all'] });
      onCreated(v.id);
      setOpen(false);
      setForm({});
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  return (
    <>
      <Button type="button" size="icon" variant="outline" className="shrink-0" onClick={() => setOpen(true)}
        title="Add new vendor">
        <Plus className="size-4" />
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Quick add Vendor"
        description="Minimum fields; full master can be edited later."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.vendorName}>
              {create.isPending && <Spinner className="text-primary-foreground" />} Save & use
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor Name *" className="col-span-2">
            <Input value={form.vendorName ?? ''} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} autoFocus />
          </Field>
          <Field label="Short Name">
            <Input maxLength={6} value={form.shortName ?? ''} onChange={(e) => setForm({ ...form, shortName: e.target.value.toUpperCase() })} placeholder="e.g. RFL" />
          </Field>
          <Field label="GSTIN">
            <Input value={form.gstin ?? ''} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="City">
            <Input value={form.city ?? ''} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </Field>
          <Field label="State" className="col-span-2">
            <Input value={form.state ?? ''} onChange={(e) => setForm({ ...form, state: e.target.value })} />
          </Field>
          <Field label="Processes (which steps this vendor supports)" className="col-span-2">
            <div className="flex flex-wrap gap-1 rounded-md border border-input bg-background p-2">
              {(processesQ.data ?? []).map((p) => {
                const sel = (form.processIds ?? []).includes(p.id);
                return (
                  <button type="button" key={p.id}
                    onClick={() => {
                      const cur = form.processIds ?? [];
                      setForm({
                        ...form,
                        processIds: sel ? cur.filter((id: number) => id !== p.id) : [...cur, p.id],
                      });
                    }}
                    className={`rounded-full border px-2 py-0.5 text-xs ${sel ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                    {p.name}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      </Dialog>
    </>
  );
}
