'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity, ChevronDown, ChevronRight, Filter, RotateCcw, Search, Undo2, User as UserIcon } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { Dialog } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { formatDate } from '@/lib/utils';

// ─── module-level filter cache ───────────────────────────────────────────
// Mirror the cachedItemsFilter pattern used elsewhere — the filters
// persist across in-app navigation but reset on hard reload, matching
// the operator's "I left the page filter at X, I want it still on X
// when I come back" mental model.
let cachedActivityFilter: { search: string; userId: string; action: string; actionPrefix: string } = {
  search: '', userId: '', action: '', actionPrefix: '',
};

/**
 * /admin/activity — append-only audit timeline for the whole ERP.
 *
 * Each row collapses to a one-liner (user × action × time × description).
 * Expanding shows the BEFORE / AFTER snapshots side-by-side so the operator
 * can SEE what changed. Rows with a registered undo handler get an Undo
 * button that calls POST /audit/logs/:id/undo.
 *
 * Filters across the top: search (matches description), user, action
 * prefix (Items / Casting / Vendors / Materials). Cursor-paginated; the
 * "Load more" button at the bottom drives the next page.
 */
export default function ActivityPage() {
  const qc = useQueryClient();
  const [search, setSearch] = React.useState(() => cachedActivityFilter.search);
  const [userId, setUserId] = React.useState(() => cachedActivityFilter.userId);
  const [action, setAction] = React.useState(() => cachedActivityFilter.action);
  const [actionPrefix, setActionPrefix] = React.useState(() => cachedActivityFilter.actionPrefix);
  React.useEffect(() => {
    cachedActivityFilter = { search, userId, action, actionPrefix };
  }, [search, userId, action, actionPrefix]);

  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const toggle = (id: number) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Cursor pagination — we accumulate pages client-side so "Load more"
  // appends without losing the user's expansions/scroll.
  const [pages, setPages] = React.useState<any[][]>([]);
  const [nextCursor, setNextCursor] = React.useState<number | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // First-page query — re-fires when filters change; we reset the
  // accumulated pages so the list starts fresh from the top.
  const firstQ = useQuery({
    queryKey: ['audit-logs', { search, userId, action, actionPrefix }],
    queryFn: () => Api.audit.list({
      search: search.trim() || undefined,
      userId: userId ? Number(userId) : undefined,
      action: action.trim() || undefined,
      actionPrefix: actionPrefix || undefined,
      limit: 50,
    }),
  });
  React.useEffect(() => {
    if (firstQ.data) {
      setPages([firstQ.data.items]);
      setNextCursor(firstQ.data.nextCursor);
    }
  }, [firstQ.data]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const r = await Api.audit.list({
        search: search.trim() || undefined,
        userId: userId ? Number(userId) : undefined,
        action: action.trim() || undefined,
        actionPrefix: actionPrefix || undefined,
        limit: 50,
        cursor: nextCursor,
      });
      setPages((p) => [...p, r.items]);
      setNextCursor(r.nextCursor);
    } catch (e) {
      toast.error(getApiError(e).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const undoOne = useMutation({
    mutationFn: (id: number) => Api.audit.undo(id),
    onSuccess: (_r, id) => {
      toast.success('Action undone.');
      qc.invalidateQueries({ queryKey: ['audit-logs'] });
      // Pages won't refresh automatically — kick the first page so
      // the row's "Undone" stamp + the new ".undo" entry appear at top.
      firstQ.refetch();
      void id;
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const [confirmUndo, setConfirmUndo] = React.useState<any | null>(null);

  const rows = pages.flat();

  return (
    <div>
      <PageHeader
        title="Activity"
        subtitle="Every mutation across the ERP — who, what, when, before & after. Expand any row to see the diff; tap Undo on supported actions to reverse."
      />

      <Card className="mb-4">
        <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-12">
          <div className="relative sm:col-span-5">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search description (item code, vendor, batch #…)" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="sm:col-span-3">
            <Select value={actionPrefix} onChange={(e) => setActionPrefix(e.target.value)}>
              <option value="">All modules</option>
              <option value="items.">Items</option>
              <option value="casting.">Casting / Production</option>
              <option value="vendors.">Vendors</option>
              <option value="materials.">Materials</option>
              <option value="material-issues.">Material issues</option>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Input placeholder="Exact action (optional)" value={action} onChange={(e) => setAction(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Input type="number" placeholder="User id" value={userId} onChange={(e) => setUserId(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {firstQ.isLoading ? (
            <div className="flex items-center justify-center p-8 text-sm text-muted-foreground"><Spinner /> Loading activity…</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <Activity className="mx-auto mb-2 size-8 opacity-30" />
              No activity yet. Mutations across Items, Casting, Vendors and Materials will show up here as users work.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row: any) => {
                const isOpen = expanded.has(row.id);
                const time = row.createdAt ? formatDate(row.createdAt) : '—';
                return (
                  <li key={row.id} className="hover:bg-muted/20">
                    {/* Whole header row is the expand toggle — operator
                        doesn't have to hit the small chevron. role=button
                        gives keyboard support; Undo gets stopPropagation
                        below so clicking it doesn't double-up as an expand. */}
                    <div
                      className="flex cursor-pointer items-start gap-3 px-4 py-3 select-none"
                      role="button"
                      tabIndex={0}
                      onClick={() => toggle(row.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle(row.id);
                        }
                      }}
                      aria-expanded={isOpen}
                    >
                      <span
                        className="mt-0.5 text-muted-foreground"
                        aria-hidden
                      >
                        {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          {/* Human verb phrase ("Forwarded to next
                              process") is what the operator reads first;
                              the technical key drops back to a small
                              tooltip-only badge for filtering & debugging. */}
                          <span className="font-semibold text-foreground">{humaniseAction(row.action)}</span>
                          <Badge variant="outline" className="hidden font-mono text-[10px] sm:inline-flex" title={`Action key: ${row.action}`}>{row.action}</Badge>
                          {row.undoneAt && (
                            <Badge variant="secondary" className="text-[10px]" title={`Undone at ${formatDate(row.undoneAt)}`}>
                              ↶ undone
                            </Badge>
                          )}
                          {row.undoOfId && (
                            <Badge variant="outline" className="text-[10px]">undo of #{row.undoOfId}</Badge>
                          )}
                          <span className="truncate text-muted-foreground">
                            — {row.description ?? `${row.targetType ?? ''}${row.targetId ? ` #${row.targetId}` : ''}`}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <UserIcon className="size-3" />
                            {row.user ? `${row.user.fullName || row.user.username}` : '— system —'}
                            {row.user?.role && <Badge variant="outline" className="ml-1 px-1 py-0 text-[9px]">{row.user.role}</Badge>}
                          </span>
                          <span>·</span>
                          <span>{time}</span>
                          {row.targetType && row.targetId && (
                            <>
                              <span>·</span>
                              <span className="font-mono">{row.targetType}#{row.targetId}</span>
                            </>
                          )}
                        </div>
                      </div>
                      {row.canUndo && (
                        <Button
                          variant="outline" size="sm" className="shrink-0 text-warning hover:bg-warning/10"
                          onClick={(e) => { e.stopPropagation(); setConfirmUndo(row); }}
                          disabled={undoOne.isPending}
                        >
                          <Undo2 className="size-3.5" /> Undo
                        </Button>
                      )}
                    </div>

                    {isOpen && (
                      <div className="border-t border-border bg-muted/20 px-4 py-3">
                        <ChangeView before={row.snapshotBefore} after={row.snapshotAfter} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Spinner />} Load more
          </Button>
        </div>
      )}

      {confirmUndo && (
        <Dialog
          open
          onClose={() => setConfirmUndo(null)}
          size="md"
          title="Undo this action?"
          description={confirmUndo.description ?? confirmUndo.action}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirmUndo(null)} disabled={undoOne.isPending}>Cancel</Button>
              <Button
                onClick={() => undoOne.mutate(confirmUndo.id, { onSuccess: () => setConfirmUndo(null) })}
                disabled={undoOne.isPending}
                className="bg-amber-600 hover:bg-amber-700"
              >
                {undoOne.isPending && <Spinner />} <Undo2 className="size-4" /> Yes, undo
              </Button>
            </>
          }
        >
          <div className="space-y-2 text-sm">
            <p>This will reverse the action using the snapshot stored at the time it was performed.</p>
            <p className="text-muted-foreground">
              Some undos can be blocked by downstream state — for example, "undo a forward" fails if pieces have
              already been received from the forwarded stage. You'll see a clear error in that case and nothing changes.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ─── human-readable diff plumbing ─────────────────────────────────────
// Goal: when the operator expands an activity row, they see a "Category:
// — → Earring" list of the actual changes, NOT a wall of JSON. The
// utilities below normalise values (null ≡ empty string ≡ undefined →
// "—"), translate technical field names to human labels, and reduce
// noisy fields (createdAt, updatedAt, _count helpers etc.) out of the
// view. A toggle reveals the raw JSON for power users when needed.

/** Action key → human verb phrase shown next to the technical badge.
 *  Anything not mapped falls back to a tidied form of the raw key
 *  ("foo.barBaz" → "Foo · Bar baz"). */
const ACTION_LABELS: Record<string, string> = {
  // Items
  'items.create': 'Created design',
  'items.update': 'Updated design',
  'items.delete': 'Deleted design',
  'items.setProcessRate': 'Updated process rate',
  // Vendors
  'vendors.create': 'Added vendor',
  'vendors.update': 'Updated vendor',
  'vendors.delete': 'Deleted vendor',
  // Materials
  'materials.createVariant': 'Added material variant',
  'materials.updateVariant': 'Updated material variant',
  'materials.removeVariant': 'Deleted material variant',
  'materials.adjustStock': 'Stock adjustment',
  // Material issues
  'material-issues.create': 'Issued materials',
  'material-issues.update': 'Updated issue voucher',
  'material-issues.return': 'Returned materials',
  // Casting / production
  'casting.createBatch': 'Created production batch',
  'casting.updateBatch': 'Edited batch',
  'casting.removeBatch': 'Removed batch',
  'casting.addBatchDesign': 'Added design to batch',
  'casting.updateStage': 'Edited stage',
  'casting.forwardStage': 'Forwarded to next process',
  'casting.shortCloseStage': 'Short-closed stage',
  'casting.reopenStage': 'Reopened stage',
  'casting.createReceipt': 'Received from vendor',
  'casting.deleteReceipt': 'Deleted receipt',
  'casting.swapDesign': 'Swapped design on stage',
  'casting.undo': 'Undid action',
};

function humaniseAction(key: string): string {
  if (ACTION_LABELS[key]) return ACTION_LABELS[key];
  const [prefix, ...rest] = key.split('.');
  const tail = rest.join('.').replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return `${prefix[0]?.toUpperCase() ?? ''}${prefix.slice(1)}${tail ? ` · ${tail.charAt(0).toUpperCase()}${tail.slice(1)}` : ''}`;
}

/** Field-name → human label. Anything not in here falls back to the
 *  raw key with first letter uppercased — good enough for unknown
 *  actions that haven't been mapped yet. Centralised so future
 *  modules can extend it in one place. */
const FIELD_LABELS: Record<string, string> = {
  // Generic
  id: 'ID',
  notes: 'Notes',
  status: 'Status',
  // Items
  itemNumber: 'Item No.',
  itemName: 'Item Name',
  category: 'Category',
  subcategory: 'Subcategory',
  collection: 'Collection',
  designType: 'Design Type',
  designerName: 'Designer',
  designerShortName: 'Designer Short',
  designCost: 'Design Cost',
  sellingPrice: 'Selling Price',
  costPrice: 'Cost Price',
  sampleStatus: 'Sample Status',
  sampleDesignCode: 'Sample Code',
  cadFilePath: 'CAD File',
  // Casting / Stages
  vendorId: 'Vendor',
  vendorDesignReference: 'Vendor Design Ref',
  weight: 'Wt / pc',
  quantity: 'Qty',
  totalWeight: 'Total Weight',
  costPerKg: 'Rate / g',
  color: 'Colour',
  remarks: 'Remarks',
  purpose: 'Purpose',
  itemId: 'Item',
  batchId: 'Batch',
  processId: 'Process',
  parentItemId: 'Parent Stage',
  closed: 'Closed',
  closedReason: 'Closed Reason',
  shortQty: 'Short Qty',
  shortWeight: 'Short Weight',
  // Receipt
  receivedQty: 'Received Qty',
  receivedWeight: 'Received Weight',
  acceptedQty: 'Accepted',
  repairQty: 'Repair',
  rejectedQty: 'Rejected',
  rejectPaymentMode: 'Reject Payment Mode',
  rejectAdjustment: 'Reject Adjustment',
  receiptDate: 'Receipt Date',
  receiptNumber: 'Receipt No.',
  // Users
  username: 'Username',
  email: 'Email',
  fullName: 'Full Name',
  role: 'Role',
  // Relations (rendered as count-only by default)
  images: 'Images',
  processes: 'Processes',
  materials: 'Materials',
  colorModels: 'Colour Models',
  items: 'Items',
};

/** Fields skipped from the diff entirely — timestamps and internal
 *  count helpers that change on every save without being meaningful to
 *  the operator. */
const SKIPPED_FIELDS = new Set<string>([
  'createdAt', 'updatedAt', 'lastLoginAt', '_count', 'passwordHash',
]);

/** Human label for a field. Falls back to a humanised version of the
 *  raw key when not in the map ("rejectAdjustment" → "Reject Adjustment"). */
function labelFor(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  // Camel-case → space-separated title case.
  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/** Normalise empty-ish values to a single sentinel so "null" / "" /
 *  undefined / "0" / [] all compare equal AND render as an em dash
 *  in the diff. Numeric 0 stays as 0 because that's a meaningful
 *  business value (e.g. shortQty=0 means "no short"). */
function isEmpty(v: any): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/** Pretty-print a single value for the diff cell. Handles nulls, Decimal-
 *  as-strings (Prisma serialises them), dates, arrays (count + first few),
 *  booleans, and plain objects (single-line JSON). */
function formatValue(v: any): React.ReactNode {
  if (isEmpty(v)) return <span className="italic text-muted-foreground">—</span>;
  if (typeof v === 'boolean') return v ? '✓ yes' : '✗ no';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    // Decimal-as-string ("12.50") → render as plain number; otherwise
    // raw text. Date detection: ISO 8601 prefix → re-format short.
    if (/^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v);
      return Number.isInteger(n) ? String(n) : String(n);
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toLocaleString();
    }
    return v;
  }
  if (Array.isArray(v)) {
    // Show count + small inline preview of up to 2 items. Operator
    // expands the raw JSON if they want the full payload.
    const preview = v.slice(0, 2).map((it) => {
      if (it && typeof it === 'object') {
        const id = it.id ?? it.itemId ?? '';
        const name = it.name ?? it.itemName ?? it.color ?? it.code ?? it.vendorName ?? '';
        return [id, name].filter(Boolean).join(' · ') || '{…}';
      }
      return String(it);
    });
    return (
      <span>
        <strong>{v.length}</strong> item{v.length === 1 ? '' : 's'}
        {preview.length > 0 && (
          <span className="text-muted-foreground"> — {preview.join(', ')}{v.length > preview.length ? ', …' : ''}</span>
        )}
      </span>
    );
  }
  if (typeof v === 'object') {
    // Plain object — render compactly. Rare in a diff (nested objects
    // are usually unrolled by the field walker below).
    return <code className="text-xs">{JSON.stringify(v)}</code>;
  }
  return String(v);
}

/** Decide if two values count as "the same" for diff purposes. Empties
 *  collapse together so null vs "" doesn't show as a change. Arrays
 *  and objects do a shallow JSON compare — good enough for the
 *  snapshot-vs-snapshot use case. */
function valuesEqual(a: any, b: any): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

interface DiffEntry { field: string; label: string; before: any; after: any; }

/** Compare two snapshot objects and return only the fields that changed.
 *  Walks the union of keys; skips known noisy fields. Snapshot-level
 *  only — doesn't recurse into nested objects (those render via the
 *  formatValue helper which handles arrays + objects compactly). */
function diffSnapshots(before: any, after: any): DiffEntry[] {
  const out: DiffEntry[] = [];
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  for (const k of keys) {
    if (SKIPPED_FIELDS.has(k)) continue;
    if (k.startsWith('_')) continue;
    if (valuesEqual(b[k], a[k])) continue;
    out.push({ field: k, label: labelFor(k), before: b[k], after: a[k] });
  }
  // Stable, predictable order — alphabetical by label. Better than
  // insertion order which can drift between snapshot versions.
  out.sort((x, y) => x.label.localeCompare(y.label));
  return out;
}

/**
 * Replaces the previous side-by-side raw-JSON pane. Shows ONLY the
 * fields that changed, as a clean "Field: before → after" list. The
 * raw JSON is still available behind a "Show raw JSON" toggle for
 * power users / debugging.
 */
function ChangeView({ before, after }: { before: any; after: any }) {
  const [showRaw, setShowRaw] = React.useState(false);
  const entries = React.useMemo(() => diffSnapshots(before, after), [before, after]);

  // Pure-create or pure-delete: one side is empty. Show all populated
  // fields as the "after" (create) or "before" (delete) state so the
  // operator sees what was added / removed rather than an empty diff.
  const isCreate = (before == null || Object.keys(before).length === 0) && after && typeof after === 'object';
  const isDelete = (after == null || Object.keys(after).length === 0) && before && typeof before === 'object';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {isCreate ? 'Created with' : isDelete ? 'Removed' : 'What changed'}
        </div>
        <button
          type="button"
          onClick={() => setShowRaw((s) => !s)}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
        </button>
      </div>

      {/* Friendly diff */}
      {!showRaw && (
        <>
          {entries.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-card px-3 py-2 text-xs italic text-muted-foreground">
              No field-level changes detected (this can happen when only timestamps moved or a Decimal was re-saved at the same value).
            </div>
          ) : (
            <div className="table-scroll rounded-md border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Field</th>
                    <th className="px-3 py-1.5 font-medium">{isDelete ? 'Was' : 'Before'}</th>
                    <th className="px-3 py-1.5 font-medium">{isCreate ? 'Now' : 'After'}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.field} className="border-t border-border align-top">
                      <td className="px-3 py-1.5 font-semibold text-foreground">{e.label}</td>
                      <td className="px-3 py-1.5">
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive ring-1 ring-red-100">
                          {formatValue(e.before)}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="rounded bg-success/10 px-1.5 py-0.5 text-xs text-success ring-1 ring-emerald-100">
                          {formatValue(e.after)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Raw JSON fallback — kept for cases the friendly diff misses
          (deeply nested changes) or for engineer-level debugging. */}
      {showRaw && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <RawSnapshotPane title="Before" data={before} accent="red" />
          <RawSnapshotPane title="After" data={after} accent="emerald" />
        </div>
      )}
    </div>
  );
}

/** Verbatim JSON view — kept under the "Show raw JSON" toggle for the
 *  rare case the operator (or engineer) wants the full payload. */
function RawSnapshotPane({ title, data, accent }: { title: string; data: unknown; accent: 'red' | 'emerald' }) {
  const accentCls = accent === 'red'
    ? 'border-destructive/30 bg-destructive/10/60'
    : 'border-success/30 bg-success/15';
  const labelCls = accent === 'red' ? 'text-destructive' : 'text-success';
  return (
    <div className={`rounded-md border ${accentCls} p-2`}>
      <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${labelCls}`}>{title}</div>
      {data == null ? (
        <div className="text-xs italic text-muted-foreground">(none)</div>
      ) : (
        <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap break-all rounded bg-card px-2 py-1.5 font-mono text-[11px] leading-tight text-foreground">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
