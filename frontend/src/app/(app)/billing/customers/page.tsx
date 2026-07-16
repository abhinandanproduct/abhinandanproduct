'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Users2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/shared/field';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

export default function CustomersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = React.useState('');
  const [open, setOpen] = React.useState(false);
  // editId=null → dialog is in "New Customer" mode; otherwise the dialog
  // pre-fills from the picked customer and Save calls updateCustomer.
  const [editId, setEditId] = React.useState<number | null>(null);
  const [form, setForm] = React.useState<any>({});

  const customersQ = useQuery<any[]>({
    queryKey: ['customers', search],
    queryFn: () => Api.billing.customers(search || undefined),
  });

  const openAdd = () => {
    setEditId(null);
    setForm({});
    setOpen(true);
  };
  const openEdit = (c: any) => {
    setEditId(c.id);
    // Pull every persisted field so the operator sees today's state and
    // can tweak just the parts they need.
    setForm({
      customerName: c.customerName ?? '',
      gstin: c.gstin ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      addressLine1: c.addressLine1 ?? '',
      addressLine2: c.addressLine2 ?? '',
      city: c.city ?? '',
      state: c.state ?? '',
      stateCode: c.stateCode ?? '',
      pincode: c.pincode ?? '',
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: () =>
      editId != null
        ? Api.billing.updateCustomer(editId, form)
        : Api.billing.createCustomer(form),
    onSuccess: () => {
      toast.success(editId != null ? 'Customer updated.' : 'Customer added.');
      qc.invalidateQueries({ queryKey: ['customers'] });
      setOpen(false);
      setEditId(null);
      setForm({});
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customers"
        description="Master list of parties you invoice. Each carries running balance + ledger."
        actions={
          <Button onClick={openAdd}>
            <Plus className="size-4" /> Add Customer
          </Button>
        }
      />

      <div className="flex items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search name / code / GSTIN / phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {customersQ.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Spinner /> Loading...
            </div>
          ) : (
            <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">GSTIN</th>
                  <th className="px-4 py-2">Phone</th>
                  <th className="px-4 py-2">City</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(customersQ.data ?? []).map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-secondary/20">
                    <td className="px-4 py-2 font-semibold">
                      <Link href={`/billing/customers/${c.id}`} className="text-info hover:underline">
                        {c.customerCode}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{c.customerName}</td>
                    <td className="px-4 py-2 text-xs">{c.gstin ?? '—'}</td>
                    <td className="px-4 py-2 text-xs">{c.phone ?? '—'}</td>
                    <td className="px-4 py-2 text-xs">{c.city ?? '—'}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      Rs. {Number(c.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end">
                        <Button variant="outline" size="icon" title="Edit customer"
                          onClick={() => openEdit(c)}>
                          <Pencil className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {(customersQ.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      No customers yet. Add one to start invoicing.
                    </td>
                  </tr>
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
        title={editId != null ? 'Edit Customer' : 'New Customer'}
        description={
          editId != null
            ? 'Update billing details — address, GSTIN, phone. Changes flow into every future invoice for this customer.'
            : 'Buyer party for tax invoices / estimates / delivery challans.'
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !form.customerName}>
              {save.isPending && <Spinner className="text-primary-foreground" />} {editId != null ? 'Save Changes' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer Name *" className="col-span-2">
            <Input value={form.customerName ?? ''} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
          </Field>
          <Field label="GSTIN">
            <Input value={form.gstin ?? ''} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Address line 1" className="col-span-2">
            <Input value={form.addressLine1 ?? ''} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} />
          </Field>
          <Field label="Address line 2" className="col-span-2">
            <Input value={form.addressLine2 ?? ''} onChange={(e) => setForm({ ...form, addressLine2: e.target.value })} />
          </Field>
          <Field label="City">
            <Input value={form.city ?? ''} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </Field>
          <Field label="State">
            <Input value={form.state ?? ''} onChange={(e) => setForm({ ...form, state: e.target.value })} />
          </Field>
          <Field label="State code (GST)">
            <Input maxLength={2} value={form.stateCode ?? ''} onChange={(e) => setForm({ ...form, stateCode: e.target.value })} />
          </Field>
          <Field label="Pincode">
            <Input value={form.pincode ?? ''} onChange={(e) => setForm({ ...form, pincode: e.target.value })} />
          </Field>
          <Field label="Email" className="col-span-2">
            <Input type="email" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
