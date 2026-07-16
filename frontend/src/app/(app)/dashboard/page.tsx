'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import {
  Layers, PackageCheck, Clock, Truck, Factory, Gem, Hash, FlaskConical, ScanLine,
  Hammer, Sparkles, Anchor, Magnet, Wind, Palette, Link as LinkIcon, Paperclip,
  AlertTriangle,
} from 'lucide-react';
import { Api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { RecastPopup } from '@/components/shared/recast-popup';
import { formatCurrency, formatDate } from '@/lib/utils';

// Silvira-style dashboard for Shree Abhinandan Product.
//
// Layout top → bottom:
//   1. 4 KPI tiles
//   2. Outsource Outstanding strip (5 chips)
//   3. Pipeline Health (3fr) + Metal Flow (1fr)
//   4. In-Process Stock by Design (compressed table)
//   5. Recent Designs (compact)
//
// Reads ONLY existing endpoints: /dashboard, /items, /vendor-advances.

const PROCESS_ICON: Record<string, any> = {
  CAM:           ScanLine,
  CASTING:       Factory,
  DIE_NUMBER:    Hash,
  FILING:        Hammer,
  POLISH:        Sparkles,
  KACHA_FITTING: Anchor,
  MAGNET:        Magnet,
  SAND_BLAST:    Wind,
  PLATING:       FlaskConical,
  MEENA:         Palette,
  FITTING_MALA:  LinkIcon,
  STICKING:      Paperclip,
  PACKING:       PackageCheck,
};

export default function DashboardPage() {
  const { user } = useAuth();
  const dashQ = useQuery({
    queryKey: ['dashboard'],
    queryFn:  () => Api.dashboard(),
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const recastsQ = useQuery<any[]>({
    queryKey: ['pending-recasts'],
    queryFn: () => Api.missingParts.pending(),
    refetchInterval: 60_000,
  });
  const [recastOpen, setRecastOpen] = React.useState(false);
  const advancesQ = useQuery({
    queryKey: ['vendor-advance-balances', ''],
    queryFn:  () => Api.vendorAdvances.balances(),
    refetchOnWindowFocus: true,
  });
  const itemsQ = useQuery({
    queryKey: ['items', { recent: true }],
    queryFn:  () => Api.items.list({}),
  });

  if (dashQ.isLoading || !dashQ.data) {
    return <div className="flex items-center justify-center py-20"><Spinner className="size-6 text-gold" /></div>;
  }

  const d = dashQ.data;
  const prodInv  = d.productionInventory ?? { finished: 0, inHouse: 0, atVendor: 0, total: 0 };

  const totalAdvanceMetal = (advancesQ.data ?? []).reduce((s: number, r: any) => s + Number(r.balanceWeight || 0), 0);
  const totalPipelinePcs  = (d.processWorkload ?? []).reduce((s: number, p: any) => s + (p.pendingQty || 0), 0);
  const totalIssuedWeight = Number(d.totalWeightSent ?? 0);
  const topVendor = d.payableByVendor?.[0];
  const itemNumbersAllocated = (itemsQ.data ?? []).filter((i: any) => i.itemNumber).length;

  return (
    <div className="space-y-4">
      {/* Greeting */}
      <div>
        <h1 className="text-xl font-bold">Welcome back, {user?.fullName} ✦</h1>
        <p className="text-sm text-text-faint">Overview &amp; recent designs · auto-refreshes every 30s</p>
      </div>

      {/* 4 KPI tiles */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Kpi icon="💎" value={d.totalItems} label="Total Designs"
             sub={`${d.productionReadyItems ?? 0} production-ready`} color="gold" />
        <Kpi icon="⚠️" value={totalPipelinePcs} label="Pipeline Pending"
             sub="across all stages" color="success" />
        <Kpi icon="🏷️" value={itemNumbersAllocated} label="Item Numbers Allocated"
             sub={`${(d.totalItems ?? 0) - itemNumbersAllocated} pending`} color="info" />
        <Kpi icon="📦" value={prodInv.finished} label="Pieces Packed"
             sub={`${prodInv.atVendor} at vendor`} color="success" />
      </div>

      {/* Outsource Outstanding strip */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="section-label">🤝 Outsource Outstanding</h2>
            <Link href="/reports" className="text-xs text-gold hover:underline">View Reports →</Link>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
            <Chip tint="gold"    label="Total Payable" value={formatCurrency(d.payableThisMonthTotal ?? 0)} />
            <Chip tint="info"    label="Metal Issued" value={`${totalIssuedWeight.toFixed(3)} g`} />
            <Chip tint="warning" label="Balance ₹" value={formatCurrency(d.outstandingBalance ?? d.payableThisMonthTotal ?? 0)} />
            <Chip tint="info"    label="Advance Metal" value={`${totalAdvanceMetal.toFixed(3)} g`} />
            <Chip tint="gold"    label="Top Vendor" value={topVendor ? topVendor.name : '—'} sub={topVendor ? formatCurrency(topVendor.amount) : ''} />
          </div>
        </CardContent>
      </Card>

      {/* Pipeline Health + Metal Flow */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Card><CardContent className="p-4">
            <h2 className="section-label mb-3">🔄 Pipeline Health</h2>
            {(d.processWorkload ?? []).length === 0 ? (
              <p className="py-4 text-sm text-text-muted">No active processes.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {d.processWorkload.map((p: any, i: number) => {
                  const code = p.code ?? p.name?.toUpperCase().replace(/[^A-Z]+/g, '_');
                  const Icon = PROCESS_ICON[code] ?? Layers;
                  const busy = (p.pendingQty ?? 0) > 0;
                  return (
                    <Link
                      key={`${code}-${i}`}
                      href="/casting/batches"
                      className={`block rounded-lg border p-3 text-center transition-transform hover:scale-[1.02] ${
                        busy ? 'border-success/30 bg-success/5' : 'border-border bg-card opacity-60'
                      }`}
                    >
                      <Icon className={`mx-auto mb-1 size-5 ${busy ? 'text-success' : 'text-text-faint'}`} />
                      <div className={`font-mono text-xl font-bold leading-none ${busy ? 'text-success' : 'text-text-faint'}`}>
                        {p.pendingQty ?? 0}
                      </div>
                      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-text-faint">{p.name}</div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent></Card>
        </div>

        <Card><CardContent className="p-4">
          <h2 className="section-label mb-3">⚖️ Metal Flow</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-text-muted">In House (mid-chain)</span>
              <span className="font-mono font-semibold text-info">{prodInv.inHouse} pcs</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">At Vendor</span>
              <span className="font-mono font-semibold text-warning">{prodInv.atVendor} pcs</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Packed</span>
              <span className="font-mono font-semibold text-success">{prodInv.finished} pcs</span>
            </div>
            <div className="border-t border-border pt-2">
              <div className="flex justify-between">
                <span className="text-text-muted">Total Issued (g)</span>
                <span className="font-mono font-bold text-gold">{totalIssuedWeight.toFixed(3)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Advance Pool (g)</span>
                <span className="font-mono font-bold text-info">{totalAdvanceMetal.toFixed(3)}</span>
              </div>
            </div>
          </div>
        </CardContent></Card>
      </div>

      {/* Pending Recasts — surfaces MissingPart rows that haven't been
          recast yet (operator picked "later" on the receive popup). */}
      {(recastsQ.data?.length ?? 0) > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="section-label flex items-center gap-2 text-warning"><AlertTriangle className="size-4" /> Pending Recasts</h2>
              <Button size="sm" variant="outline" onClick={() => setRecastOpen(true)}>
                Resolve {recastsQ.data!.length} pending
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {recastsQ.data!.slice(0, 6).map((r) => (
                <div key={r.id} className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
                  <div className="font-semibold">{r.designCode ?? r.itemNumber} · {r.partName}</div>
                  <div className="text-xs text-text-faint">
                    {r.qtyMissing} pc{r.qtyMissing === 1 ? '' : 's'} · {r.batchNumber ?? 'no batch'} · {r.stageProcessName ?? r.stageProcessCode}
                  </div>
                </div>
              ))}
              {recastsQ.data!.length > 6 && (
                <div className="rounded border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  +{recastsQ.data!.length - 6} more pending
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      <RecastPopup open={recastOpen} rows={recastsQ.data ?? []} onClose={() => setRecastOpen(false)} />

      {/* Aging pending batches + Recent activity (carry-over from Pratik) */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card><CardContent className="p-4">
          <h2 className="section-label mb-3 flex items-center gap-2"><Clock className="size-4 text-gold" /> Aging — Pending Batches</h2>
          {(d.agingPending ?? []).length === 0 ? <p className="py-3 text-sm text-text-muted">Nothing pending. All caught up.</p> : (
            <div className="space-y-2">
              {d.agingPending.slice(0, 5).map((b: any) => (
                <Link key={b.batchNumber} href="/casting/batches" className="flex items-center justify-between rounded border border-border bg-card px-3 py-2 text-sm hover:bg-secondary">
                  <div className="min-w-0">
                    <div className="font-medium">{b.batchNumber} <span className="text-text-faint">· {b.processName}</span></div>
                    <div className="truncate text-xs text-text-faint">{b.vendors.join(', ')}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="warning">{b.pendingQty} pcs</Badge>
                    <Badge variant={b.days >= 14 ? 'destructive' : 'secondary'}>{b.days}d</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent></Card>

        <Card><CardContent className="p-4">
          <h2 className="section-label mb-3 flex items-center gap-2"><Truck className="size-4 text-gold" /> Top Vendor Holdings</h2>
          {(!d.topVendorHoldings || d.topVendorHoldings.length === 0) ? <p className="py-3 text-sm text-text-muted">No raw materials with vendors.</p> : (
            <div className="space-y-2">
              {d.topVendorHoldings.slice(0, 5).map((v: any) => (
                <Link key={v.vendorId} href="/material-issues" className="flex items-center justify-between rounded border border-border bg-card px-3 py-2 text-sm hover:bg-secondary">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{v.name}</div>
                    <div className="text-xs text-text-faint">{v.vouchers} voucher{v.vouchers === 1 ? '' : 's'}</div>
                  </div>
                  <Badge variant="info">{v.qty} pcs</Badge>
                </Link>
              ))}
            </div>
          )}
        </CardContent></Card>
      </div>

      {/* Recent Designs */}
      <Card><CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="section-label flex items-center gap-2"><Gem className="size-4 text-gold" /> Recent Designs</h2>
          <Link href="/items" className="text-xs text-gold hover:underline">View All →</Link>
        </div>
        {(itemsQ.data ?? []).length === 0 ? <p className="py-3 text-sm text-text-muted">No designs yet.</p> : (
          <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="text-left text-text-faint">
                <tr>
                  <th className="py-2 pr-3 font-medium">Design #</th>
                  <th className="py-2 pr-3 font-medium">Item No.</th>
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Designer</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Sample Status</th>
                  <th className="py-2 font-medium">Added</th>
                </tr>
              </thead>
              <tbody>
                {itemsQ.data!.slice(0, 10).map((it: any) => (
                  <tr key={it.id} className="border-t border-border">
                    <td className="py-2 pr-3 font-semibold text-gold">
                      <Link href={`/items/${it.id}`} className="hover:underline">{it.sampleDesignCode}</Link>
                    </td>
                    <td className="py-2 pr-3 font-semibold tracking-tight">{it.itemNumber ?? <span className="font-normal text-text-faint">—</span>}</td>
                    <td className="py-2 pr-3">{it.itemName ?? <span className="text-text-faint">—</span>}</td>
                    <td className="py-2 pr-3 text-text-muted">{it.designerShortName ?? it.designerName ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={it.designType === 'CAD' ? 'info' : 'secondary'}>{it.designType ?? '—'}</Badge>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={it.sampleStatus === 'PRODUCTION_READY' ? 'success' : it.sampleStatus === 'DRAFT' ? 'warning' : 'info'}>
                        {it.sampleStatus}
                      </Badge>
                    </td>
                    <td className="py-2 text-text-muted">{formatDate(it.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent></Card>
    </div>
  );
}

function Kpi({ icon, value, label, sub, color }: {
  icon: string; value: number | string; label: string; sub?: string;
  color: 'gold' | 'success' | 'info' | 'warning';
}) {
  const tone = {
    gold:    { text: 'text-gold',    glow: 'shadow-[0_0_24px_-12px_hsl(var(--gold)/0.5)]' },
    success: { text: 'text-success', glow: 'shadow-[0_0_24px_-12px_hsl(var(--success)/0.5)]' },
    info:    { text: 'text-info',    glow: 'shadow-[0_0_24px_-12px_hsl(var(--info)/0.5)]' },
    warning: { text: 'text-warning', glow: 'shadow-[0_0_24px_-12px_hsl(var(--warning)/0.5)]' },
  }[color];
  return (
    <Card className={`transition-transform hover:-translate-y-0.5 ${tone.glow}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <span className="text-xl">{icon}</span>
        </div>
        <div className={`mt-1 font-mono text-3xl font-extrabold leading-none ${tone.text}`}>{value}</div>
        <div className="mt-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-text-muted">{label}</div>
        {sub && <div className="mt-0.5 text-[10px] text-text-faint">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function Chip({ tint, label, value, sub }: {
  tint: 'gold' | 'success' | 'info' | 'warning';
  label: string; value: string; sub?: string;
}) {
  const cls = {
    gold:    'gold-tint',
    success: 'success-tint',
    info:    'info-tint',
    warning: 'warning-tint',
  }[tint];
  const textCls = {
    gold:    'text-gold',
    success: 'text-success',
    info:    'text-info',
    warning: 'text-warning',
  }[tint];
  return (
    <div className={`rounded-lg p-3 text-center ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">{label}</div>
      <div className={`mt-1 truncate font-mono text-sm font-extrabold ${textCls}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[10px] font-mono text-text-faint">{sub}</div>}
    </div>
  );
}
