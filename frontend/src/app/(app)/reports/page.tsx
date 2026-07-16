'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Download, Gem, Wallet, Layers, FileSpreadsheet } from 'lucide-react';
import { Api } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils';

type Tab = 'loss-gain' | 'stones' | 'vendor-metal' | 'per-design';

const TAB_LABELS: Record<Tab, string> = {
  'loss-gain':    'Loss / Gain',
  'stones':       'Stones',
  'vendor-metal': 'Vendor Metal',
  'per-design':   'Per Design',
};

function thisMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const toISO = (d: Date) => d.toISOString().slice(0, 10);
  return { from: toISO(first), to: toISO(last) };
}

function csvDownload(filename: string, rows: any[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const escape = (v: any) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function ReportsPage() {
  const [tab, setTab] = React.useState<Tab>('loss-gain');
  const def = thisMonthRange();
  const [from, setFrom] = React.useState(def.from);
  const [to, setTo]     = React.useState(def.to);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        description="Month-end loss/gain, stones consumed, vendor metal positions, per-design loss profile."
      />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end">
          {tab !== 'vendor-metal' && (
            <>
              <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </>
          )}
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
              <Button
                key={t}
                variant={tab === t ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTab(t)}
              >
                {TAB_LABELS[t]}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {tab === 'loss-gain'    && <LossGainTab    from={from} to={to} />}
      {tab === 'stones'       && <StonesTab      from={from} to={to} />}
      {tab === 'vendor-metal' && <VendorMetalTab />}
      {tab === 'per-design'   && <PerDesignTab   from={from} to={to} />}
    </div>
  );
}

function SectionCard({ icon: Icon, title, action, children }: any) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="section-label flex items-center gap-2"><Icon className="size-4 text-gold" /> {title}</h2>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function LossGainTab({ from, to }: { from: string; to: string }) {
  const q = useQuery({
    queryKey: ['reports-loss-gain', from, to],
    queryFn: () => Api.reports.lossGain({ from, to }),
  });
  const rows = q.data?.rows ?? [];
  const t = q.data?.totals;

  return (
    <SectionCard
      icon={BarChart3}
      title="Process × Vendor — Loss / Gain"
      action={<Button variant="outline" size="sm" onClick={() => csvDownload(`loss-gain_${from}_${to}.csv`, rows)} disabled={!rows.length}><Download className="size-4" /> CSV</Button>}
    >
      {q.isLoading ? <div className="py-8 text-center"><Spinner /></div> :
       rows.length === 0 ? <p className="py-4 text-sm text-text-muted">No receipts in this window.</p> : (
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="text-left text-text-faint">
              <tr>
                <th className="py-2 pr-3 font-medium">Process</th>
                <th className="py-2 pr-3 font-medium">Vendor</th>
                <th className="py-2 pr-3 text-right font-medium">Issued (g)</th>
                <th className="py-2 pr-3 text-right font-medium">Received (g)</th>
                <th className="py-2 pr-3 text-right font-medium">Loss (g)</th>
                <th className="py-2 pr-3 text-right font-medium">Loss %</th>
                <th className="py-2 pr-3 text-right font-medium">Recv Qty</th>
                <th className="py-2 text-right font-medium">Reject</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.processId}-${r.vendorId}-${i}`} className="border-t border-border">
                  <td className="py-2 pr-3 font-medium">{r.processName}</td>
                  <td className="py-2 pr-3"><div>{r.vendorName}</div><div className="text-xs text-text-faint">{r.vendorCode}</div></td>
                  <td className="py-2 pr-3 text-right font-mono">{r.issuedWeight.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.receivedWeight.toFixed(3)}</td>
                  <td className={`py-2 pr-3 text-right font-mono ${r.lossWeight > 0 ? 'text-warning' : 'text-success'}`}>{r.lossWeight.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-text-muted">{r.lossPct.toFixed(2)}%</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.receivedQty}</td>
                  <td className="py-2 text-right font-mono text-warning">{r.rejectedQty}</td>
                </tr>
              ))}
            </tbody>
            {t && (
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="py-2 pr-3" colSpan={2}>Total</td>
                  <td className="py-2 pr-3 text-right font-mono">{t.issuedWeight.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{t.receivedWeight.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-warning">{t.lossWeight.toFixed(3)}</td>
                  <td></td>
                  <td className="py-2 pr-3 text-right font-mono">{t.receivedQty}</td>
                  <td className="py-2 text-right font-mono text-warning">{t.rejectedQty}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function StonesTab({ from, to }: { from: string; to: string }) {
  const q = useQuery({
    queryKey: ['reports-stones', from, to],
    queryFn: () => Api.reports.stones({ from, to }),
  });
  const rows = q.data?.rows ?? [];
  const t = q.data?.totals;
  return (
    <SectionCard
      icon={Gem}
      title="Stones consumed (by variant × vendor)"
      action={<Button variant="outline" size="sm" onClick={() => csvDownload(`stones_${from}_${to}.csv`, rows)} disabled={!rows.length}><Download className="size-4" /> CSV</Button>}
    >
      {q.isLoading ? <div className="py-8 text-center"><Spinner /></div> :
       rows.length === 0 ? <p className="py-4 text-sm text-text-muted">No stone issues in this window.</p> : (
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="text-left text-text-faint">
              <tr>
                <th className="py-2 pr-3 font-medium">Variant</th>
                <th className="py-2 pr-3 font-medium">Vendor</th>
                <th className="py-2 pr-3 text-right font-medium">Issued (pcs)</th>
                <th className="py-2 pr-3 text-right font-medium">Issued (g)</th>
                <th className="py-2 pr-3 text-right font-medium">Received</th>
                <th className="py-2 pr-3 text-right font-medium">Consumed</th>
                <th className="py-2 text-right font-medium">Short</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-2 pr-3"><div className="font-medium">{r.variantName}</div><div className="text-xs text-text-faint">{r.variantCode}</div></td>
                  <td className="py-2 pr-3">{r.vendorName} <span className="text-xs text-text-faint">({r.vendorCode})</span></td>
                  <td className="py-2 pr-3 text-right font-mono">{r.issuedQty}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.issuedWeight.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.receivedQty}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.consumedQty}</td>
                  <td className="py-2 text-right font-mono text-warning">{r.shortQty}</td>
                </tr>
              ))}
            </tbody>
            {t && (
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="py-2 pr-3" colSpan={2}>Total</td>
                  <td className="py-2 pr-3 text-right font-mono">{t.issuedQty}</td>
                  <td className="py-2 pr-3 text-right font-mono">{t.issuedWeight.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{t.receivedQty}</td>
                  <td className="py-2 pr-3 text-right font-mono">{t.consumedQty}</td>
                  <td className="py-2 text-right font-mono text-warning">{t.shortQty}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function VendorMetalTab() {
  const q = useQuery({ queryKey: ['reports-vendor-metal'], queryFn: () => Api.reports.vendorMetal() });
  const rows = q.data?.rows ?? [];
  return (
    <SectionCard
      icon={Wallet}
      title="Vendor Metal Position"
      action={<Button variant="outline" size="sm" onClick={() => csvDownload('vendor-metal.csv', rows)} disabled={!rows.length}><Download className="size-4" /> CSV</Button>}
    >
      <div className="mb-3 flex items-center gap-2 text-sm">
        <Badge variant="success">Total: {q.data?.totalAdvance?.toFixed(3) ?? '0.000'} g</Badge>
        <span className="text-text-faint">across {rows.length} (vendor × variant) balances</span>
      </div>
      {q.isLoading ? <div className="py-8 text-center"><Spinner /></div> :
       rows.length === 0 ? <p className="py-4 text-sm text-text-muted">No active advances.</p> : (
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="text-left text-text-faint">
              <tr>
                <th className="py-2 pr-3 font-medium">Vendor</th>
                <th className="py-2 pr-3 font-medium">Variant</th>
                <th className="py-2 pr-3 text-right font-medium">Balance (g)</th>
                <th className="py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-2 pr-3"><div className="font-medium">{r.vendorName}</div><div className="text-xs text-text-faint">{r.vendorCode}</div></td>
                  <td className="py-2 pr-3">{r.variantName} <span className="text-xs text-text-faint">({r.materialName})</span></td>
                  <td className="py-2 pr-3 text-right font-mono font-semibold text-gold">{Number(r.balanceWeight).toFixed(3)}</td>
                  <td className="py-2 text-text-muted">{formatDate(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function PerDesignTab({ from, to }: { from: string; to: string }) {
  const q = useQuery({
    queryKey: ['reports-per-design', from, to],
    queryFn: () => Api.reports.perDesign({ from, to }),
  });
  const rows = q.data?.rows ?? [];
  return (
    <SectionCard
      icon={Layers}
      title="Per-Design Loss Profile"
      action={<Button variant="outline" size="sm" onClick={() => csvDownload(`per-design_${from}_${to}.csv`, rows)} disabled={!rows.length}><Download className="size-4" /> CSV</Button>}
    >
      {q.isLoading ? <div className="py-8 text-center"><Spinner /></div> :
       rows.length === 0 ? <p className="py-4 text-sm text-text-muted">No receipts in this window.</p> : (
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="text-left text-text-faint">
              <tr>
                <th className="py-2 pr-3 font-medium">Design</th>
                <th className="py-2 pr-3 font-medium">Item No.</th>
                <th className="py-2 pr-3 text-right font-medium">Stages</th>
                <th className="py-2 pr-3 text-right font-medium">Recv Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Issued (g)</th>
                <th className="py-2 pr-3 text-right font-medium">Received (g)</th>
                <th className="py-2 pr-3 text-right font-medium">Loss (g)</th>
                <th className="py-2 text-right font-medium">Loss %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-2 pr-3"><div className="font-medium">{r.sampleDesignCode}</div><div className="text-xs text-text-faint">{r.itemName ?? '—'}</div></td>
                  <td className="py-2 pr-3">{r.itemNumber ?? <span className="text-text-faint">unallocated</span>}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.stages}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.receivedQty}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.issuedWeight.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.receivedWeight.toFixed(3)}</td>
                  <td className={`py-2 pr-3 text-right font-mono ${r.lossWeight > 0 ? 'text-warning' : 'text-success'}`}>{r.lossWeight.toFixed(3)}</td>
                  <td className="py-2 text-right font-mono text-text-muted">{r.lossPct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
