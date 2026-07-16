'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, Pencil, Trash2, Search, Eye, ImageIcon, FileDown } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { fileUrl, formatDate, SAMPLE_STATUS_LABELS } from '@/lib/utils';
import type { ItemListRow } from '@/lib/types';

// Module-level cache for the list's filter — survives client-side
// navigation (e.g. clicking Edit on a row → save → back) because the
// module isn't re-evaluated. Resets on hard reload because the JS
// runtime tears down. Matches the user's spec: "after reload it is
// okay but when not reloaded the page must have that filter until
// not removed."
// Pending-filter options match the strings the backend pushes into
// row.pending[]. 'any' = at least one pending field; '' = no filter.
type PendingFilter =
  | '' | 'any'
  | 'image' | 'item no' | 'category' | 'designer'
  | 'processes' | 'casting wt' | 'BOM';

let cachedItemsFilter: { search: string; sampleStatus: string; photo: '' | 'with' | 'without'; pending: PendingFilter } = { search: '', sampleStatus: '', photo: '', pending: '' };

export default function ItemsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const [search, setSearch] = React.useState(() => cachedItemsFilter.search);
  const [sampleStatus, setSampleStatus] = React.useState(() => cachedItemsFilter.sampleStatus);
  // Photo filter — client-side post-filter on the items list. Operator
  // uses "Without photo" to triage designs that still need a shoot.
  const [photo, setPhoto] = React.useState<'' | 'with' | 'without'>(() => cachedItemsFilter.photo);
  // Pending-fields filter — surfaces designs whose master data is
  // incomplete. 'any' = at least one missing field; specific value =
  // missing that field. Helps operators triage what still needs to be
  // entered before a design is production-ready.
  const [pending, setPending] = React.useState<PendingFilter>(() => cachedItemsFilter.pending);

  // Keep the module cache in sync so the next mount of this page
  // (after navigating away and back) sees the same filter values.
  React.useEffect(() => {
    cachedItemsFilter = { search, sampleStatus, photo, pending };
  }, [search, sampleStatus, photo, pending]);

  const itemsQ = useQuery<ItemListRow[]>({
    queryKey: ['items', { search, sampleStatus }],
    queryFn: () => Api.items.list({ search: search || undefined, sampleStatus: sampleStatus || undefined }),
  });

  // Client-side filtered view — keeps the server query cache hot across
  // photo-filter changes (the backend doesn't know about thumbUrl-based
  // filtering, so doing it here means flipping the photo dropdown is
  // instant rather than triggering a refetch).
  const visibleItems = React.useMemo(() => {
    let rows = itemsQ.data ?? [];
    if (photo === 'with') rows = rows.filter((r) => !!r.thumbUrl);
    else if (photo === 'without') rows = rows.filter((r) => !r.thumbUrl);
    if (pending === 'any') rows = rows.filter((r) => (r.pending?.length ?? 0) > 0);
    else if (pending) rows = rows.filter((r) => r.pending?.includes(pending));
    return rows;
  }, [itemsQ.data, photo, pending]);

  const remove = useMutation({
    mutationFn: (id: number) => Api.items.remove(id),
    onSuccess: () => { toast.success('Item deleted.'); qc.invalidateQueries({ queryKey: ['items'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const columns: ColumnDef<ItemListRow>[] = [
    {
      id: 'image', header: '', enableSorting: false,
      cell: ({ row }) => row.original.thumbUrl ? (
        <a href={fileUrl(row.original.thumbUrl)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Open full image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fileUrl(row.original.thumbUrl)} alt="" className="size-12 rounded-md border border-border object-cover transition-opacity hover:opacity-80" />
        </a>
      ) : (
        <div className="flex size-12 items-center justify-center rounded-md border border-dashed border-border bg-secondary/30 text-muted-foreground">
          <ImageIcon className="size-4" />
        </div>
      ),
    },
    {
      // Merged identity column — primary is Item No (bold, vendor-facing);
      // secondary is Sample Code + collection. Replaces the two separate
      // "Sample Code" and "Item No" columns that were forcing the operator
      // to jump between two very-similar identifiers.
      accessorKey: 'itemNumber', header: 'Item',
      cell: ({ row }) => (
        <Link href={`/items/${row.original.id}`} className="group block min-w-0">
          <div className="font-semibold text-foreground group-hover:text-primary group-hover:underline">
            {row.original.itemNumber ?? row.original.sampleDesignCode}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="font-mono">{row.original.sampleDesignCode}</span>
            {row.original.collection && (
              <>
                <span className="text-text-faint">·</span>
                <span>{row.original.collection}</span>
              </>
            )}
          </div>
        </Link>
      ),
    },
    {
      // Type column merges Category + Design so the row has one place
      // to read "what is this design", instead of two adjacent columns
      // that both often show "—".
      id: 'type', header: 'Type', enableSorting: false,
      cell: ({ row }) => {
        const cat = row.original.category?.trim();
        const design = row.original.designType?.trim();
        if (!cat && !design) return <span className="text-text-faint">—</span>;
        return (
          <div className="flex flex-col text-sm">
            {cat && <span className="text-foreground">{cat}</span>}
            {design && <span className="text-[11px] text-muted-foreground">{design}</span>}
          </div>
        );
      },
    },
    {
      accessorKey: 'sampleStatus', header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.sampleStatus} />,
    },
    {
      // Pending master-data labels — up to 3 chips shown inline, rest
      // collapsed to "+N more" with a tooltip. Empty = green check.
      id: 'pending', header: 'Pending', enableSorting: false,
      cell: ({ row }) => {
        const list = row.original.pending ?? [];
        if (list.length === 0) {
          return <span className="inline-flex items-center gap-1 text-xs text-success">✓ complete</span>;
        }
        const head = list.slice(0, 3);
        const overflow = list.length - head.length;
        return (
          <div className="flex flex-wrap items-center gap-1" title={list.join(', ')}>
            {head.map((label) => (
              <span key={label} className="rounded bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning ring-1 ring-warning/30">
                {label}
              </span>
            ))}
            {overflow > 0 && (
              <span className="text-[11px] text-muted-foreground" title={list.slice(3).join(', ')}>+{overflow} more</span>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: 'updatedAt', header: 'Updated',
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatDate(row.original.updatedAt)}</span>,
    },
    {
      id: 'actions', header: () => <div className="text-right">Actions</div>, enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          <Button variant="ghost" size="icon" title="View details"
            onClick={() => router.push(`/items/${row.original.id}`)}>
            <Eye className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="Edit"
            onClick={() => router.push(`/items/${row.original.id}/edit`)}>
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost" size="icon"
            title="Download datasheet"
            onClick={() => window.open(Api.items.datasheetPdfUrl(row.original.id, row.original.itemNumber), '_blank', 'noopener')}
          >
            <FileDown className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="Delete"
            className="text-destructive hover:bg-destructive/10"
            onClick={() => confirm({
              title: 'Delete item?',
              message: `This permanently deletes ${row.original.sampleDesignCode} and all its process/image data.`,
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
        title="Item Master"
        subtitle="Permanent manufacturing blueprint for every jewellery design. Save drafts and complete details progressively."
        actions={<Button onClick={() => router.push('/items/new')}><Plus className="size-4" /> Create Item</Button>}
      />

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative flex-1 min-w-0 sm:min-w-[240px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search code, name, designer, category…"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            className="w-full sm:w-48"
            value={sampleStatus}
            onChange={(e) => setSampleStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {Object.entries(SAMPLE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          {/* Photo presence — triage filter for "which designs still
              need a shoot". Client-side; resets on hard reload via the
              cache pattern above. */}
          <Select
            className="w-full sm:w-44"
            value={photo}
            onChange={(e) => setPhoto(e.target.value as '' | 'with' | 'without')}
          >
            <option value="">All items</option>
            <option value="with">With photo</option>
            <option value="without">Without photo</option>
          </Select>
          {/* Pending-fields filter — operator triages incomplete designs. */}
          <Select
            className="w-full sm:w-56"
            value={pending}
            onChange={(e) => setPending(e.target.value as PendingFilter)}
          >
            <option value="">All — no pending filter</option>
            <option value="any">Any pending field</option>
            <option value="image">Missing image</option>
            <option value="item no">Missing item no</option>
            <option value="category">Missing category</option>
            <option value="designer">Missing designer</option>
            <option value="processes">Missing processes</option>
            <option value="casting wt">Missing casting wt</option>
            <option value="BOM">Missing BOM</option>
          </Select>
        </CardContent>
      </Card>

      {/* DataTable renders its own bordered card — no outer wrapper
          needed. Wrapping it produced a nested-box "double line" look. */}
      <DataTable
            columns={columns}
            data={visibleItems}
            loading={itemsQ.isLoading}
            emptyTitle="No items yet"
            emptyDescription="Create your first design blueprint."
            mobileCard={(row: any) => (
              <div className="flex gap-3">
                {/* Thumbnail — the list API exposes it as `thumbUrl` (same
                    field the desktop table cell reads). Was checking the
                    wrong key (`primaryImagePath`) which never populates,
                    so mobile always fell through to the placeholder. */}
                {row.thumbUrl ? (
                  <a href={fileUrl(row.thumbUrl)} target="_blank" rel="noreferrer" title="Open full image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(row.thumbUrl)} alt="" className="size-14 shrink-0 rounded-md border border-border object-cover" />
                  </a>
                ) : (
                  <div className="flex size-14 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-secondary/30 text-muted-foreground">
                    <ImageIcon className="size-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-bold text-foreground">{row.sampleDesignCode}</div>
                      <div className="truncate text-[11px] text-text-faint">
                        {row.itemName ?? '—'}{row.itemNumber ? ` · ${row.itemNumber}` : ''}
                      </div>
                    </div>
                    <StatusBadge status={row.sampleStatus} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
                    {row.category && <Badge variant="outline">{row.category}</Badge>}
                    {row.designerName && <Badge variant="outline">{row.designerName}</Badge>}
                  </div>
                  <div className="mt-2">
                    <Link href={`/items/${row.id}`}>
                      <Button variant="outline" size="sm">Open</Button>
                    </Link>
                  </div>
                </div>
              </div>
            )}
          />

      {dialog}
    </div>
  );
}
