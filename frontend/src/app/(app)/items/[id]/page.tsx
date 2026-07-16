'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Eye, Settings2, Star, Diamond, Info, Boxes, Hash, Layers, AlertTriangle, Factory } from 'lucide-react';
import { Api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { Spinner } from '@/components/ui/spinner';
import { AllocateItemNumberDialog } from '@/components/shared/allocate-item-number-dialog';
import { RecastMissingPartsDialog } from '@/components/shared/recast-missing-parts-dialog';
import { fileUrl, formatCurrency } from '@/lib/utils';
import type { Item } from '@/lib/types';

const ATTR_LABELS: Record<string, string> = {
  weight: 'Weight Per Piece (g)', metal_type: 'Metal Type',
};

export default function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const itemId = Number(id);
  const router = useRouter();
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [recastOpen, setRecastOpen] = useState(false);

  const { data: item, isLoading } = useQuery<Item>({
    queryKey: ['item', itemId],
    queryFn: () => Api.items.get(itemId),
  });

  // Open missing-parts count — drives the recast banner. Cheap query;
  // refetches on focus so a sibling tab's flag from a receive form
  // surfaces here without manual reload.
  const missingQ = useQuery({
    queryKey: ['missing-parts', itemId],
    queryFn: () => Api.items.listMissingParts(itemId),
    enabled: !isNaN(itemId),
    refetchOnWindowFocus: true,
  });
  const openMissing = (missingQ.data ?? []).filter((r: any) => r.isOpen);
  const openMissingPcs = openMissing.reduce((s: number, r: any) => s + r.qtyMissing, 0);

  if (isLoading || !item) {
    return <div className="flex items-center justify-center py-20"><Spinner className="size-6 text-primary" /></div>;
  }

  // Design parts are silver-ERP additions to the Item Master — pendant /
  // earring / patti / etc., each with qtyPerSet and weightPerPc. Total
  // expected weight per set = Σ (qtyPerSet × weightPerPc).
  const designParts: Array<{ id?: number; partName: string; qtyPerSet: number; weightPerPc: any; photoPath?: string; notes?: string }> = (item as any).designParts ?? [];
  const totalPartWeight = designParts.reduce((sum, p) => sum + (Number(p.qtyPerSet) || 0) * (Number(p.weightPerPc) || 0), 0);
  const totalPartPcs = designParts.reduce((sum, p) => sum + (Number(p.qtyPerSet) || 0), 0);

  // Production variants — N per piece, born at the Plating receipt and
  // travelling through the rest of the chain with their own weight history.
  // Phase 5 — populated by the casting service on plating receive.
  const productionVariants: Array<{ id: number; variantCode: string; variantIndex: number; birthWeight: any; state: string; createdAt: string }> = (item as any).productionVariants ?? [];
  const variantStateCount = productionVariants.reduce((acc: Record<string, number>, v) => {
    acc[v.state] = (acc[v.state] ?? 0) + 1;
    return acc;
  }, {});

  // Cost price is auto-calculated by the system (design + process costs, cost/kg aware).
  const totalCost = item.costPrice ?? 0;

  const basics: [string, string | null | undefined][] = [
    ['Item Number', item.itemNumber != null ? String(item.itemNumber) : null],
    ['Category', item.category], ['Subcategory', item.subcategory],
    ['Collection', item.collection], ['Design Type', item.designType],
    ['Designer', item.designerName],
    ['Design Cost', item.designCost != null ? formatCurrency(item.designCost) : null],
    ['Cost Price', item.costPrice != null ? formatCurrency(item.costPrice) : null],
    ['Selling Price', item.sellingPrice != null ? formatCurrency(item.sellingPrice) : null],
  ];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            {item.sampleDesignCode} <StatusBadge status={item.sampleStatus} />
          </h1>
          <p className="text-sm text-muted-foreground">
            {item.itemNumber != null ? `Item No. ${item.itemNumber}` : 'No item number'}
            {item.collection ? ` · ${item.collection}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {/* router.back() preserves the list's scroll position — pushing
              to /items as a fresh Link nav would reset scroll to top. */}
          <Button variant="outline" onClick={() => router.back()}><ArrowLeft className="size-4" /> Back</Button>
          {/* Allocate Item Number — only when the design has no number yet.
              Server-side gate also requires at least one Packing receipt to
              exist; the click will surface that as a toast error if not met. */}
          {!item.itemNumber && (
            <Button variant="secondary" onClick={() => setAllocateOpen(true)}>
              <Hash className="size-4" /> Allocate Item Number
            </Button>
          )}
          <Link href={`/items/${itemId}/edit`}><Button><Pencil className="size-4" /> Edit</Button></Link>
        </div>
      </div>

      <AllocateItemNumberDialog
        itemId={itemId}
        designCode={item.sampleDesignCode}
        open={allocateOpen}
        onClose={() => setAllocateOpen(false)}
      />
      <RecastMissingPartsDialog
        itemId={itemId}
        designCode={item.sampleDesignCode}
        open={recastOpen}
        onClose={() => setRecastOpen(false)}
      />

      {/* Recast banner — surfaces when at least one MissingPart is open
          (flagged at a receive form, not yet recast). One click opens
          the dialog where the operator picks records + casting vendor
          and creates the recast batch. */}
      {openMissing.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <div className="font-semibold text-warning">
                {openMissingPcs} piece{openMissingPcs === 1 ? '' : 's'} missing across {openMissing.length} record{openMissing.length === 1 ? '' : 's'}
              </div>
              <div className="text-xs text-text-muted">
                Pieces flagged short at a receive form. Recast in a new casting batch to make them good.
              </div>
            </div>
          </div>
          <Button variant="default" onClick={() => setRecastOpen(true)}>
            <Factory className="size-4" /> Recast missing parts
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              {item.images.length > 0 ? (
                <>
                  <a href={fileUrl(item.images[0].filePath)} target="_blank" rel="noreferrer" title="Open full image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(item.images[0].filePath)} alt="" className="mb-2 w-full rounded-lg object-contain transition-opacity hover:opacity-90 bg-muted max-h-[520px]" />
                  </a>
                  <div className="flex flex-wrap gap-2">
                    {item.images.slice(1).map((im) => (
                      <a key={im.id} href={fileUrl(im.filePath)} target="_blank" rel="noreferrer" title="Open full image">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fileUrl(im.filePath)} alt="" className="size-16 rounded-md border border-border object-cover transition-opacity hover:opacity-80" />
                      </a>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center py-10 text-muted-foreground">
                  <Diamond className="size-8" /><span className="mt-2 text-sm">No images</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <h2 className="mb-3 flex items-center gap-2 font-semibold"><Info className="size-4 text-primary" /> Basic Info</h2>
              {basics.map(([label, value]) => (
                <div key={label} className="flex justify-between border-b border-border py-1.5 text-sm last:border-0">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium">{value || '—'}</span>
                </div>
              ))}
              {item.cadFileUrl && (
                <a href={fileUrl(item.cadFilePath)} target="_blank" rel="noreferrer" className="mt-3 block">
                  <Button variant="outline" className="w-full"><Eye className="size-4" /> View CAD File</Button>
                </a>
              )}
              {item.notes && (
                <div className="mt-3">
                  <div className="mb-1 text-xs text-muted-foreground">Notes</div>
                  <p className="text-sm">{item.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Production Variants — populated post-Plating bifurcation.
              Each row is a physical piece with its own weight history. */}
          {productionVariants.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-3 flex items-center gap-2 font-semibold">
                  <Layers className="size-4 text-gold" /> Production Variants
                  <Badge variant="info">{productionVariants.length}</Badge>
                </h2>
                <div className="mb-3 flex flex-wrap gap-2 text-xs">
                  {Object.entries(variantStateCount).map(([state, n]) => (
                    <Badge
                      key={state}
                      variant={
                        state === 'PACKED' ? 'success' :
                        state === 'IN_PROGRESS' ? 'warning' :
                        state === 'SOLD' ? 'info' : 'destructive'
                      }
                    >
                      {state.replace(/_/g, ' ')}: {n}
                    </Badge>
                  ))}
                </div>
                <div className="table-scroll max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-text-faint">
                      <tr>
                        <th className="py-1 pr-2 font-medium">Variant</th>
                        <th className="py-1 pr-2 text-right font-medium">Birth Wt (g)</th>
                        <th className="py-1 font-medium">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productionVariants.map((v) => (
                        <tr key={v.id} className="border-t border-border">
                          <td className="py-1.5 pr-2 font-semibold tracking-tight text-gold">{v.variantCode}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{Number(v.birthWeight ?? 0).toFixed(3)}</td>
                          <td className="py-1.5">
                            <span className={
                              v.state === 'PACKED' ? 'text-success' :
                              v.state === 'IN_PROGRESS' ? 'text-warning' :
                              v.state === 'SOLD' ? 'text-info' : 'text-destructive'
                            }>
                              {v.state.replace(/_/g, ' ')}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Design Parts — the components this design is assembled from
              (pendant + earring + patti, etc.). Per-piece weight × qty per
              set drives the planned issue weight at Casting. */}
          {designParts.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-3 flex items-center gap-2 font-semibold">
                  <Layers className="size-4 text-primary" /> Design Parts
                </h2>
                <div className="table-scroll">
                <table className="w-full text-sm">
                  <thead className="text-left text-text-faint">
                    <tr>
                      <th className="py-1 pr-2 font-medium">Photo</th>
                      <th className="py-1 pr-2 font-medium">Part</th>
                      <th className="py-1 pr-2 text-right font-medium">Qty/Set</th>
                      <th className="py-1 text-right font-medium">Wt/Pc (g)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {designParts.map((p, i) => (
                      <tr key={p.id ?? i} className="border-t border-border">
                        <td className="py-1.5 pr-2">
                          {p.photoPath ? (
                            <a href={fileUrl(p.photoPath)} target="_blank" rel="noreferrer" title="Open full size">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={fileUrl(p.photoPath)} alt={p.partName} className="size-10 rounded border border-border object-cover" />
                            </a>
                          ) : (
                            <div className="flex size-10 items-center justify-center rounded border border-dashed border-border text-text-faint">
                              <Boxes className="size-4" />
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 pr-2 font-medium">{p.partName}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{p.qtyPerSet}</td>
                        <td className="py-1.5 text-right tabular-nums">{Number(p.weightPerPc ?? 0).toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border text-text-muted">
                      <td className="py-1.5 pr-2 text-xs uppercase tracking-wide" colSpan={2}>Total per set</td>
                      <td className="py-1.5 pr-2 text-right font-semibold tabular-nums">{totalPartPcs} pcs</td>
                      <td className="py-1.5 text-right font-semibold tabular-nums">{totalPartWeight.toFixed(3)} g</td>
                    </tr>
                  </tfoot>
                </table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column: blueprint */}
        <div className="lg:col-span-2">
          <Card>
            <CardContent className="p-5">
              <h2 className="mb-4 flex items-center gap-2 font-semibold"><Settings2 className="size-4 text-primary" /> Manufacturing Blueprint</h2>

              {item.processes.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground">
                  No processes defined yet. <Link href={`/items/${itemId}/edit`} className="text-primary hover:underline">Add process details</Link>.
                </p>
              ) : (
                <div className="space-y-3">
                  {item.processes.map((p) => {
                    const isKg = p.costUnit === 'KG';
                    const usesColor = p.vendors.some((v) => v.color);
                    return (
                    <div key={p.processId} className="rounded-lg border border-border p-4">
                      <h3 className="mb-2 flex items-center gap-2 font-semibold text-primary">
                        <Settings2 className="size-4" /> {p.name}
                        {isKg && <Badge variant="info">per g</Badge>}
                      </h3>
                      {Object.keys(p.attributes).length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                          {Object.entries(p.attributes).map(([k, v]) => (
                            <span key={k}>
                              <span className="text-muted-foreground">{ATTR_LABELS[k] ?? k}: </span>
                              <span className="font-medium">{v}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {!!(p.services && p.services.length) && (
                        <div className="mb-2 text-sm">
                          <span className="text-muted-foreground">Services: </span>
                          {p.services.map((s, i) => (
                            <span key={s.serviceId} className="font-medium">
                              {i > 0 ? ', ' : ''}{s.name}{s.cost != null ? ` (${formatCurrency(s.cost)})` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {p.vendors.length > 0 ? (
                        <div className="table-scroll">
                          <table className="w-full table-fixed text-sm" style={{ minWidth: 640 }}>
                            <colgroup>
                              <col style={{ width: usesColor ? '24%' : '30%' }} />
                              {usesColor && <col style={{ width: '14%' }} />}
                              <col style={{ width: '20%' }} />
                              <col style={{ width: '16%' }} />
                              <col style={{ width: '8%' }} />
                              <col style={{ width: usesColor ? '18%' : '26%' }} />
                            </colgroup>
                            <thead className="text-left text-muted-foreground">
                              <tr>
                                <th className="py-1 pr-3">Vendor</th>
                                {usesColor && <th className="py-1 pr-3">Colour</th>}
                                <th className="py-1 pr-3">Vendor Design Ref.</th>
                                <th className="py-1 pr-3">{isKg ? 'Cost / g' : 'Cost / Pc'}</th>
                                <th className="py-1 pr-3">Pref.</th>
                                <th className="py-1">Notes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.vendors.map((v, i) => (
                                <tr key={i} className="border-t border-border align-top">
                                  <td className="truncate py-1.5 pr-3">{v.vendorCode} · {v.vendorName}</td>
                                  {usesColor && <td className="truncate py-1.5 pr-3">{v.color || '—'}</td>}
                                  <td className="truncate py-1.5 pr-3">{v.vendorDesignReference || '—'}</td>
                                  <td className="py-1.5 pr-3">{formatCurrency(v.costPerPiece)}</td>
                                  <td className="py-1.5 pr-3">{v.isPreferred ? <Star className="size-4 fill-amber-400 text-amber-400" /> : '—'}</td>
                                  <td className="truncate py-1.5 text-muted-foreground">{v.notes || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">No vendors assigned yet.</p>
                      )}
                      {!!(p.photos && p.photos.length) && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {p.photos!.map((ph) => (
                            <a key={ph.id} href={fileUrl(ph.filePath)} target="_blank" rel="noreferrer" title="Open full image">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={fileUrl(ph.filePath)} alt="" className="size-12 rounded border border-border object-cover transition-opacity hover:opacity-80" />
                            </a>
                          ))}
                        </div>
                      )}
                      {p.notes && <p className="mt-2 text-sm text-muted-foreground">Note: {p.notes}</p>}
                    </div>
                    );
                  })}
                </div>
              )}

              {/* Bill of Materials — preferred sticking colour only */}
              {(() => {
                const stick = item.processes.find((p) => p.code === 'STICKING');
                const sv = stick?.vendors ?? [];
                const prefColour = ((sv.find((v) => v.isPreferred) ?? sv[0])?.color ?? '').trim();
                const rows = (item.materials ?? []).filter(
                  (m) => ((m.stickingColor ?? '').trim().toLowerCase()) === prefColour.toLowerCase(),
                );
                if (!rows.length) return null;
                return (
                  <div className="mt-4 rounded-lg border border-border p-4">
                    <h3 className="mb-2 flex items-center gap-2 font-semibold text-primary">
                      <Boxes className="size-4" /> Bill of Materials
                      {prefColour && <Badge variant="outline">{prefColour}</Badge>}
                    </h3>
                    <div className="table-scroll">
                      <table className="w-full min-w-[560px] text-sm">
                        <thead className="text-left text-muted-foreground">
                          <tr>
                            <th className="py-1 pr-3">Material</th>
                            <th className="py-1 pr-3">Qty/pc</th>
                            <th className="py-1 pr-3">Price/pc</th>
                            <th className="py-1 pr-3">Line Cost</th>
                            <th className="py-1">In Stock</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((m, i) => (
                            <tr key={i} className="border-t border-border">
                              <td className="py-1.5 pr-3">
                                <span className="font-medium">{m.variantName}</span>
                                {(m.size || m.color) && <span className="text-muted-foreground"> · {[m.size, m.color].filter(Boolean).join(' · ')}</span>}
                              </td>
                              <td className="py-1.5 pr-3">{m.quantity} pcs</td>
                              <td className="py-1.5 pr-3">{formatCurrency(m.price)}</td>
                              <td className="py-1.5 pr-3">{formatCurrency(m.lineCost)}</td>
                              <td className="py-1.5">{m.stockQty}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
                <span className="font-medium">Auto cost price (design + process + material costs)</span>
                <span className="font-bold text-primary">{formatCurrency(totalCost)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
