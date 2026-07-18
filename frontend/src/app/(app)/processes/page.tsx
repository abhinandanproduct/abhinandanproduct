'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { SortableTh, useTableSort } from '@/components/shared/sortable-table';

export default function ProcessMasterPage() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [edit, setEdit] = React.useState<any | null>(null);
  const [form, setForm] = React.useState<any>({});

  const q = useQuery<any[]>({ queryKey: ['processes'], queryFn: () => Api.processes() });

  const { sorted, sortKey, sortDir, toggle } = useTableSort<any>(
    q.data,
    'sortOrder',
    'asc',
    {
      sortOrder: (r) => Number(r.sortOrder),
    },
  );

  const reset = () => { setForm({}); setEdit(null); };

  const save = useMutation({
    mutationFn: () => edit
      ? Api.updateProcess(edit.id, form)
      : Api.createProcess(form),
    onSuccess: () => {
      toast.success(edit ? 'Process updated.' : 'Process added.');
      qc.invalidateQueries({ queryKey: ['processes'] });
      setOpen(false);
      reset();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => Api.deleteProcess(id),
    onSuccess: () => {
      toast.success('Process removed.');
      qc.invalidateQueries({ queryKey: ['processes'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Process Master"
        description="Manufacturing steps — Plating, Filing, Sticking, etc. Order, costing model, and BOM/bifurcate behaviour are set here."
        actions={
          <Button onClick={() => { reset(); setOpen(true); }}>
            <Plus className="size-4" /> Add Process
          </Button>
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
                  <SortableTh label="Order" sortKey="sortOrder" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Code" sortKey="code" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Name" sortKey="name" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Costed" sortKey="isCosted" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="center" />
                  <SortableTh label="BOM Capable" sortKey="bomCapable" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="center" />
                  <SortableTh label="Bifurcates" sortKey="bifurcates" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="center" />
                  <SortableTh label="Needs Short Name" sortKey="requiresShortName" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="center" />
                  <SortableTh label="Status" sortKey="status" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="center" />
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-2 text-xs text-muted-foreground">{p.sortOrder}</td>
                    <td className="px-4 py-2 text-xs font-semibold">{p.code}</td>
                    <td className="px-4 py-2">{p.name}</td>
                    <td className="px-4 py-2 text-center">{p.isCosted ? '✓' : '—'}</td>
                    <td className="px-4 py-2 text-center">{p.bomCapable ? '✓' : '—'}</td>
                    <td className="px-4 py-2 text-center">{p.bifurcates ? '✓' : '—'}</td>
                    <td className="px-4 py-2 text-center">{p.requiresShortName ? '✓' : '—'}</td>
                    <td className="px-4 py-2 text-center text-xs">{p.status}</td>
                    <td className="px-4 py-2 text-right space-x-1">
                      <Button size="icon" variant="outline" onClick={() => {
                        setEdit(p);
                        setForm({
                          name: p.name,
                          sortOrder: p.sortOrder,
                          isCosted: p.isCosted,
                          bomCapable: p.bomCapable,
                          bifurcates: p.bifurcates,
                          requiresShortName: p.requiresShortName,
                          status: p.status,
                        });
                        setOpen(true);
                      }}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button size="icon" variant="outline" className="text-destructive"
                        onClick={() => { if (confirm(`Remove ${p.name}?`)) remove.mutate(p.id); }}>
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onClose={() => { setOpen(false); reset(); }}
        title={edit ? `Edit ${edit.name}` : 'New Process'}
        description="Manufacturing step in the production chain."
        footer={
          <>
            <Button variant="outline" onClick={() => { setOpen(false); reset(); }} disabled={save.isPending}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !form.name}>
              {save.isPending && <Spinner className="text-primary-foreground" />} Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name *" className="col-span-2">
            <Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Engraving" />
          </Field>
          {!edit && (
            <Field label="Code (auto if blank)" className="col-span-2">
              <Input value={form.code ?? ''} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} placeholder="ENGRAVING" />
            </Field>
          )}
          <Field label="Sort Order">
            <Input type="number" value={form.sortOrder ?? ''} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} />
          </Field>
          {edit && (
            <Field label="Status">
              <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.status ?? 'ACTIVE'} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </Field>
          )}
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.isCosted}
              onChange={(e) => setForm({ ...form, isCosted: e.target.checked })} />
            Costed (vendor charges per kg or per piece on this stage)
          </label>
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.bomCapable}
              onChange={(e) => setForm({ ...form, bomCapable: e.target.checked })} />
            BOM-capable (this stage consumes raw materials from the design's BOM)
          </label>
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.bifurcates}
              onChange={(e) => setForm({ ...form, bifurcates: e.target.checked })} />
            Bifurcates (group stage splits into per-piece ProductionVariants on receipt — like Plating)
          </label>
          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.requiresShortName}
              onChange={(e) => setForm({ ...form, requiresShortName: e.target.checked })} />
            Requires vendor short name (e.g. CAM/Designer — used to auto-generate the design code TVM-XXX)
          </label>
        </div>
      </Dialog>
    </div>
  );
}
