'use client';

import * as React from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, Pencil, Trash2, Search, ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { fileUrl, formatCurrency } from '@/lib/utils';
import { VariantForm } from './variant-form';
import type { Category, MaterialVariant } from '@/lib/types';

// Module-level cache — survives client-side nav, resets on hard reload.
let cachedMaterialsFilter = { search: '', categoryId: '', status: '' };

export default function MaterialsPage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const [search, setSearch] = React.useState(() => cachedMaterialsFilter.search);
  const [categoryId, setCategoryId] = React.useState(() => cachedMaterialsFilter.categoryId);
  const [status, setStatus] = React.useState(() => cachedMaterialsFilter.status);
  React.useEffect(() => { cachedMaterialsFilter = { search, categoryId, status }; }, [search, categoryId, status]);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editId, setEditId] = React.useState<number | null>(null);
  const [prefillName, setPrefillName] = React.useState<string>('');
  // Bumped on every open so the form remounts fresh — no stale values from a prior entry.
  const [formKey, setFormKey] = React.useState(0);
  const openAdd = (initialName = '') => {
    setEditId(null);
    setPrefillName(initialName);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };
  const openEdit = (id: number) => { setEditId(id); setPrefillName(''); setFormKey((k) => k + 1); setFormOpen(true); };

  // Deep-link: when this page is opened with ?addVariant=<typed name>,
  // auto-open the create form with the name pre-filled. Used by Item
  // Master's BOM "+ New Material Variant" button — saves the user from
  // re-typing what they were just searching for. The URL is cleaned up
  // after opening so a refresh doesn't re-trigger.
  const searchParams = useSearchParams();
  const router = useRouter();
  React.useEffect(() => {
    const addParam = searchParams?.get('addVariant');
    if (addParam != null) {
      openAdd(addParam);
      const url = new URL(window.location.href);
      url.searchParams.delete('addVariant');
      router.replace(url.pathname + url.search);
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categoriesQ = useQuery<Category[]>({ queryKey: ['categories'], queryFn: () => Api.materials.categories() });

  const variantsQ = useQuery<MaterialVariant[]>({
    queryKey: ['variants', { search, categoryId, status }],
    queryFn: () =>
      Api.materials.variants({
        search: search || undefined,
        categoryId: categoryId || undefined,
        status: status || undefined,
      }),
  });

  // Soft fallback when delete is blocked by existing production history —
  // the backend returns a BadRequest with a friendly message, and we offer
  // the user a one-click "Deactivate instead" via the toast action so they
  // don't have to dig into the edit form.
  const deactivate = useMutation({
    mutationFn: (id: number) => Api.materials.setVariantStatus(id, 'INACTIVE'),
    onSuccess: () => {
      toast.success('Variant deactivated. History stays intact; it no longer appears in new issues / BOMs.');
      qc.invalidateQueries({ queryKey: ['variants'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => Api.materials.removeVariant(id),
    onSuccess: () => {
      toast.success('Variant deleted.');
      qc.invalidateQueries({ queryKey: ['variants'] });
    },
    onError: (e, id) => {
      const msg = getApiError(e).message;
      // FK-blocked deletes have history attached → offer Deactivate one-click.
      const blocked = /can'?t delete|referenced by|history/i.test(msg);
      toast.error(msg, blocked ? {
        action: { label: 'Deactivate instead', onClick: () => deactivate.mutate(id) },
        duration: 12000,
      } : undefined);
    },
  });

  const columns: ColumnDef<MaterialVariant>[] = [
    {
      id: 'image', header: '', enableSorting: false,
      cell: ({ row }) =>
        row.original.imageUrl ? (
          <a href={fileUrl(row.original.imagePath)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Open full image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(row.original.imagePath)} alt="" className="size-11 rounded-md border border-border object-cover transition-opacity hover:opacity-80" />
          </a>
        ) : (
          <div className="flex size-11 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <ImageIcon className="size-4" />
          </div>
        ),
    },
    { accessorKey: 'variantCode', header: 'Code', cell: ({ row }) => <span className="font-semibold tracking-tight text-foreground">{row.original.variantCode}</span> },
    {
      accessorKey: 'variantName', header: 'Material / Variant',
      cell: ({ row }) => (
        // Primary identifier column — gets the most width. Code, category,
        // and material-code (auto-gen string) all fold down here as a
        // secondary line so the table doesn't need 9 columns to read.
        <div className="min-w-[240px] max-w-[360px]">
          <div className="font-medium leading-snug line-clamp-2" title={row.original.variantName ?? ''}>
            {row.original.variantName}
          </div>
          <div className="text-xs text-muted-foreground truncate" title={row.original.materialName ?? ''}>
            {row.original.materialName}
            {row.original.categoryName ? ` · ${row.original.categoryName}` : ''}
            {row.original.code ? ` · ${row.original.code}` : ''}
          </div>
        </div>
      ),
    },
    {
      id: 'specs', header: 'Specs', enableSorting: false,
      cell: ({ row }) => {
        const specs = [row.original.size, row.original.color, row.original.finish, row.original.shape].filter(Boolean);
        return specs.length ? (
          <div className="flex flex-wrap gap-1">{specs.map((s, i) => <Badge key={i} variant="outline">{s}</Badge>)}</div>
        ) : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: 'vendors', header: 'Vendors', enableSorting: false,
      cell: ({ row }) => <Badge variant="info">{row.original.vendorCount ?? 0} vendor(s)</Badge>,
    },
    { id: 'price', header: 'From', cell: ({ row }) => formatCurrency(row.original.minPrice) },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    {
      id: 'actions', header: () => <div className="text-right">Actions</div>, enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="icon" onClick={() => openEdit(row.original.id)}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="text-destructive hover:bg-destructive/10"
            onClick={() => confirm({
              title: 'Delete variant?',
              message: `This will permanently delete ${row.original.variantName}.`,
              onConfirm: () => remove.mutateAsync(row.original.id),
            })}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Material Variant Master"
        subtitle="Raw materials & components — stones, pearls, hooks, chains, meena colors, packaging…"
        actions={<Button onClick={() => openAdd()}><Plus className="size-4" /> Add Variant</Button>}
      />

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative flex-1 min-w-0 sm:min-w-[240px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search material / variant / code…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="w-full sm:w-52">
            <SearchableSelect
              value={categoryId}
              placeholder="All categories"
              onChange={(v) => setCategoryId(v)}
              options={[{ value: '', label: 'All categories' }, ...((categoriesQ.data ?? []).map((c) => ({ value: String(c.id), label: c.name })))]}
            />
          </div>
          <Select className="w-full sm:w-36" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </CardContent>
      </Card>

      {/* DataTable renders its own bordered card — no outer Card wrapper.  */}
      <DataTable
            columns={columns}
            data={variantsQ.data ?? []}
            loading={variantsQ.isLoading}
            emptyTitle="No material variants yet"
            emptyDescription="Add your first variant to build the catalog."
            mobileCard={(row) => (
              <div className="flex gap-3">
                {row.imageUrl ? (
                  <img src={fileUrl(row.imagePath)} alt="" className="size-12 shrink-0 rounded-md border border-border object-cover" />
                ) : (
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <ImageIcon className="size-5" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-bold text-foreground">{row.variantName}</div>
                      <div className="text-[11px] text-text-faint">
                        {row.variantCode}{row.materialName ? ` · ${row.materialName}` : ''}
                      </div>
                    </div>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {[row.size, row.color, row.finish, row.shape].filter(Boolean).map((s, i) => (
                      <Badge key={i} variant="outline" className="text-[10px]">{s}</Badge>
                    ))}
                    <Badge variant="info" className="text-[10px]">{row.vendorCount ?? 0} vendor(s)</Badge>
                    {row.minPrice != null && (
                      <span className="text-[11px] text-text-faint">from {formatCurrency(row.minPrice)}</span>
                    )}
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => openEdit(row.id)}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10"
                      onClick={() => confirm({
                        title: 'Delete variant?',
                        message: `Permanently delete ${row.variantName}.`,
                        onConfirm: () => remove.mutateAsync(row.id),
                      })}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          />

      <VariantForm key={formKey} open={formOpen} onClose={() => setFormOpen(false)} variantId={editId} initialMaterialName={prefillName} />
      {dialog}
    </div>
  );
}
