'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Pause, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Spinner } from '@/components/ui/spinner';

export default function RecurringInvoicesPage() {
  const qc = useQueryClient();
  const q = useQuery<any[]>({ queryKey: ['recurring'], queryFn: () => Api.recurring.list() });
  const customersQ = useQuery<any[]>({ queryKey: ['customers'], queryFn: () => Api.billing.customers() });
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<any>({
    profileName: '',
    frequency: 'MONTHLY',
    startDate: new Date().toISOString().slice(0, 10),
    silverRatePerG: '',
    makingRatePerG: '',
    gstPercent: '3',
    lines: [{ description: '', quantity: 1, weightG: '', silverRatePerG: '', makingRatePerG: '' }],
  });

  const create = useMutation({
    mutationFn: () => Api.recurring.create({
      profileName: form.profileName,
      customerId: Number(form.customerId),
      silverRatePerG: form.silverRatePerG ? Number(form.silverRatePerG) : 0,
      makingRatePerG: form.makingRatePerG ? Number(form.makingRatePerG) : 0,
      gstPercent: form.gstPercent ? Number(form.gstPercent) : 3,
      frequency: form.frequency,
      startDate: form.startDate,
      lines: form.lines.filter((l: any) => Number(l.quantity) > 0 && Number(l.weightG) > 0),
    }),
    onSuccess: () => {
      toast.success('Recurring profile created.');
      qc.invalidateQueries({ queryKey: ['recurring'] });
      setOpen(false);
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const toggle = useMutation({
    mutationFn: (p: { id: number; enabled: boolean }) => Api.recurring.toggle(p.id, p.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
    onError: (e) => toast.error(getApiError(e).message),
  });

  const runDue = useMutation({
    mutationFn: () => Api.recurring.runDue(),
    onSuccess: (res: any[]) => {
      toast.success(`Generated ${res.length} invoice${res.length === 1 ? '' : 's'}.`);
      qc.invalidateQueries({ queryKey: ['recurring'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recurring Invoices"
        description="Templates that auto-generate Tax Invoices on a cadence (monthly retainers, AMC, etc.)."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => runDue.mutate()} disabled={runDue.isPending}>
              <RotateCcw className="size-4" /> Run due now
            </Button>
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" /> New Profile
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground"><Spinner /> Loading...</div>
          ) : (
            <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Profile</th>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">Frequency</th>
                  <th className="px-4 py-2">Next Run</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {(q.data ?? []).map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-2 font-semibold">{r.profileName}</td>
                    <td className="px-4 py-2">{r.customer?.customerName}</td>
                    <td className="px-4 py-2 text-xs">{r.frequency}</td>
                    <td className="px-4 py-2 text-xs">{new Date(r.nextRunDate).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.enabled ? 'bg-success/15 text-success' : 'bg-secondary text-muted-foreground'}`}>
                        {r.enabled ? 'ACTIVE' : 'PAUSED'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}>
                        {r.enabled ? <><Pause className="size-3" /> Pause</> : <><Play className="size-3" /> Resume</>}
                      </Button>
                    </td>
                  </tr>
                ))}
                {(q.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No recurring profiles.</td></tr>
                )}
              </tbody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="New Recurring Profile"
        description="Define the customer, frequency, and lines — invoices spawn automatically on each cycle."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.customerId || !form.profileName}>
              {create.isPending && <Spinner className="text-primary-foreground" />} Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Profile Name *" className="col-span-2">
            <Input value={form.profileName} onChange={(e) => setForm({ ...form, profileName: e.target.value })} placeholder="e.g. ABC Jewellers monthly stock" />
          </Field>
          <Field label="Customer *">
            <SearchableSelect
              value={form.customerId ?? ''}
              onChange={(v) => setForm({ ...form, customerId: v })}
              placeholder="— pick —"
              options={(customersQ.data ?? []).map((c) => ({ value: c.id, label: c.customerName, subtitle: c.customerCode }))}
            />
          </Field>
          <Field label="Frequency">
            <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="QUARTERLY">Quarterly</option>
              <option value="YEARLY">Yearly</option>
            </select>
          </Field>
          <Field label="Start Date">
            <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="GST %">
            <Input type="number" step="0.01" value={form.gstPercent} onChange={(e) => setForm({ ...form, gstPercent: e.target.value })} />
          </Field>
          <Field label="Silver Rate /g">
            <Input type="number" step="0.01" value={form.silverRatePerG} onChange={(e) => setForm({ ...form, silverRatePerG: e.target.value })} />
          </Field>
          <Field label="Making /g">
            <Input type="number" step="0.01" value={form.makingRatePerG} onChange={(e) => setForm({ ...form, makingRatePerG: e.target.value })} />
          </Field>
          <div className="col-span-2 rounded-md border border-border p-2">
            <div className="mb-2 text-xs font-semibold text-muted-foreground">Lines</div>
            {form.lines.map((l: any, i: number) => (
              <div key={i} className="mb-1 grid grid-cols-12 gap-1 text-xs">
                <Input className="col-span-5" placeholder="Description" value={l.description}
                  onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, idx: number) => idx === i ? { ...x, description: e.target.value } : x) })} />
                <Input className="col-span-2 text-right" type="number" step="1" placeholder="Qty" value={l.quantity}
                  onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, idx: number) => idx === i ? { ...x, quantity: e.target.value } : x) })} />
                <Input className="col-span-2 text-right" type="number" step="0.001" placeholder="Wt/pc g" value={l.weightG}
                  onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, idx: number) => idx === i ? { ...x, weightG: e.target.value } : x) })} />
                <Button className="col-span-1" size="sm" variant="outline"
                  onClick={() => setForm({ ...form, lines: form.lines.filter((_: any, idx: number) => idx !== i) })}>×</Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setForm({ ...form, lines: [...form.lines, { description: '', quantity: 1, weightG: '' }] })}>
              <Plus className="size-3" /> Add line
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
