'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  LayoutGrid,
  Truck,
  Gem,
  Boxes,
  ClipboardList,
  Package,
  PackageCheck,
  Receipt,
  Layers,
  Wallet,
  Wrench,
  Settings,
  Activity,
  Users,
  BarChart3,
  HandCoins,
  FileText,
  Users2,
  IndianRupee,
  ShoppingCart,
  ShoppingBag,
  ScrollText,
  FileMinus,
  RotateCcw,
  CreditCard,
  Banknote,
  ChevronDown,
  Scale,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Nav model:
//   `link`  — direct link
//   `section` — plain uppercase label (not collapsible)
//   `group`  — collapsible dropdown w/ nested links (Sales / Purchases / Finance)
type Link = { kind: 'link'; href: string; label: string; icon: any; disabled?: boolean };
type Section = { kind: 'section'; label: string };
type Group = { kind: 'group'; id: string; label: string; icon: any; children: Link[] };
type NavEntry = Link | Section | Group;

const link = (href: string, label: string, icon: any, disabled = false): Link =>
  ({ kind: 'link', href, label, icon, disabled });
const section = (label: string): Section => ({ kind: 'section', label });
const group = (id: string, label: string, icon: any, children: Link[]): Group =>
  ({ kind: 'group', id, label, icon, children });

const nav: NavEntry[] = [
  section('Overview'),
  link('/dashboard', 'Dashboard', LayoutGrid),

  section('Masters'),
  link('/vendors',           'Vendor Master',     Truck),
  link('/billing/customers', 'Customer Master',   Users2),
  link('/materials',         'Material Variants', Gem),
  link('/items',             'Item Master',       Package),
  link('/processes',         'Process Master',    Layers),

  section('Production'),
  link('/casting/batches',      'Production Management', Layers),
  link('/produced',             'Production Tracking',   PackageCheck),
  link('/production-inventory', 'Production Inventory',  Boxes),
  link('/batch-inventory',      'Batch Inventory',       ClipboardList),
  link('/repairs',              'Repair Orders',         Wrench),

  section('Inventory'),
  link('/inventory',       'Raw Materials Inventory', Boxes),
  link('/material-issues', 'Material Issues',         Receipt),

  // Billing sections collapsed as dropdown groups so daily-use pages
  // (Production, Inventory) stay above the fold. Expanded on-hover and
  // auto-opens when the current route falls inside the group.
  group('sales', 'Sales', ShoppingCart, [
    link('/billing/quotes',       'Estimates',          ScrollText),
    link('/billing/sales-orders', 'Sales Orders',       ClipboardList),
    link('/billing/invoices',     'Invoices',           FileText),
    link('/billing/temp-invoices','Temp Invoices',      FileText),
    link('/billing/recurring',    'Recurring Invoices', RotateCcw),
    link('/billing/challans',     'Delivery Challans',  Truck),
    link('/billing/payments',     'Payments Received',  IndianRupee),
    link('/billing/credit-notes', 'Credit Notes',       FileMinus),
  ]),

  group('purchases', 'Purchases', ShoppingBag, [
    link('/purchases/expenses',       'Expenses',        CreditCard),
    link('/purchases/orders',         'Purchase Orders', ClipboardList),
    link('/purchases/bills',          'Bills',           FileText),
    link('/purchases/payments',       'Payments Made',   Banknote),
    link('/purchases/vendor-credits', 'Debit Notes',     FileMinus),
    link('/vendor-drift',             'Vendor Drift',    Scale),
  ]),

  group('finance', 'Finance', Wallet, [
    link('/vendor-ledger',   'Vendor Ledger',   Wallet),
    link('/vendor-advances', 'Vendor Advances', HandCoins),
    link('/silver-lots',     'Silver Lots',     HandCoins),
    link('/alloying',        'Alloying',        HandCoins),
    link('/reports',         'Reports',         BarChart3),
  ]),

  section('Admin'),
  link('/admin/activity', 'Activity Log',    Activity),
  link('/admin/users',    'User Management', Users),
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const isActive = (href: string) => {
    if (!href || href === '#') return false;
    const [path, query] = href.split('?');
    if (query) {
      const sp = new URLSearchParams(query);
      const wanted = Object.fromEntries(sp.entries());
      return pathname === path && Object.entries(wanted).every(([k, v]) => search.get(k) === v);
    }
    return pathname === href || (pathname.startsWith(href) && href !== pathname && !search.get('scope'));
  };

  // Which groups are open. Auto-expand the group that contains the current
  // route so navigating in never leaves the user "lost" behind a collapsed
  // header. `openGroups` is a set of group ids.
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const entry of nav) {
      if (entry.kind === 'group' && entry.children.some((c) => isActive(c.href))) {
        initial.add(entry.id);
      }
    }
    return initial;
  });
  // Re-run when pathname changes so route-jumps into a group auto-open it.
  React.useEffect(() => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      for (const entry of nav) {
        if (entry.kind === 'group' && entry.children.some((c) => isActive(c.href))) {
          next.add(entry.id);
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-dark-1/70 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-sidebar text-sidebar-foreground',
          'border-r border-white/5 transition-transform duration-200 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand block */}
        <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
          <Link href="/dashboard" className="group flex min-w-0 items-center gap-2.5 font-bold text-white">
            <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-gold to-gold-light text-base font-extrabold text-primary-foreground shadow-[0_0_18px_-6px_hsl(var(--gold)/0.7)] transition-shadow group-hover:shadow-[0_0_22px_-4px_hsl(var(--gold)/0.85)]">
              ◈
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[13px] font-bold tracking-tight">Shree Abhinandan Product</span>
              <span className="block truncate text-[10px] font-medium text-text-faint">(Pratik Product)</span>
              <span className="block truncate text-[10px] font-medium italic text-text-faint">Jewellery made with emotions.</span>
            </span>
          </Link>
          <button
            onClick={onClose}
            className="rounded p-1 text-white/60 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Close menu"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3">
          {nav.map((entry, i) => {
            if (entry.kind === 'section') {
              return (
                <div
                  key={`s${i}`}
                  className="px-4 pb-1.5 pt-5 text-[10px] font-bold uppercase tracking-[0.12em] text-text-faint/80 first:pt-2"
                >
                  {entry.label}
                </div>
              );
            }
            if (entry.kind === 'group') {
              const opened = openGroups.has(entry.id);
              const anyChildActive = entry.children.some((c) => isActive(c.href));
              return (
                <div key={`g${entry.id}`} className="mt-3 first:mt-2">
                  <button
                    type="button"
                    onClick={() => toggleGroup(entry.id)}
                    className={cn(
                      'group relative mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-md px-3 py-2 text-[13px] font-semibold transition-all',
                      anyChildActive
                        ? 'text-white'
                        : 'text-slate-200 hover:bg-white/[0.03] hover:text-white',
                    )}
                    aria-expanded={opened}
                  >
                    <entry.icon
                      className={cn(
                        'size-[18px] shrink-0 transition-colors',
                        anyChildActive ? 'text-gold' : 'text-slate-400 group-hover:text-slate-200',
                      )}
                    />
                    <span className="flex-1 text-left uppercase tracking-[0.06em] text-[11px]">{entry.label}</span>
                    <ChevronDown
                      className={cn(
                        'size-4 shrink-0 text-text-faint transition-transform duration-150',
                        opened ? 'rotate-0' : '-rotate-90',
                      )}
                    />
                  </button>
                  {opened && (
                    <div className="mt-0.5 space-y-0.5">
                      {entry.children.map((child, ci) => (
                        <Link
                          key={child.href + ci}
                          href={child.disabled ? '#' : child.href}
                          onClick={(e) => {
                            if (child.disabled) e.preventDefault();
                            else if (window.innerWidth < 1024) onClose();
                          }}
                          className={cn(
                            'group relative mx-2 flex items-center gap-3 rounded-md py-1.5 pl-9 pr-3 text-[13px] font-medium transition-all',
                            child.disabled
                              ? 'cursor-not-allowed text-text-faint/60'
                              : isActive(child.href)
                                ? 'bg-gold/10 text-white shadow-[inset_0_0_0_1px_hsl(var(--gold)/0.25)]'
                                : 'text-slate-300 hover:bg-white/[0.04] hover:text-white',
                          )}
                        >
                          {isActive(child.href) && (
                            <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-x-2 -translate-y-1/2 rounded-r bg-gold shadow-[0_0_8px_hsl(var(--gold)/0.6)]" />
                          )}
                          <child.icon
                            className={cn(
                              'size-[15px] shrink-0 transition-colors',
                              isActive(child.href) ? 'text-gold' : 'text-slate-500 group-hover:text-slate-300',
                            )}
                          />
                          <span className="truncate">{child.label}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            // kind === 'link'
            return (
              <Link
                key={entry.href + i}
                href={entry.disabled ? '#' : entry.href}
                onClick={(e) => {
                  if (entry.disabled) e.preventDefault();
                  else if (window.innerWidth < 1024) onClose();
                }}
                className={cn(
                  'group relative mx-2 flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-all',
                  entry.disabled
                    ? 'cursor-not-allowed text-text-faint/60'
                    : isActive(entry.href)
                      ? 'bg-gold/10 text-white shadow-[inset_0_0_0_1px_hsl(var(--gold)/0.25)]'
                      : 'text-slate-300 hover:bg-white/[0.04] hover:text-white',
                )}
              >
                {isActive(entry.href) && (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-x-2 -translate-y-1/2 rounded-r bg-gold shadow-[0_0_8px_hsl(var(--gold)/0.6)]" />
                )}
                <entry.icon
                  className={cn(
                    'size-[18px] shrink-0 transition-colors',
                    isActive(entry.href) ? 'text-gold' : 'text-slate-400 group-hover:text-slate-200',
                  )}
                />
                <span className="truncate">{entry.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Footer hint */}
        <div className="border-t border-white/5 px-4 py-3 text-[10px] text-text-faint/70">
          <span className="font-mono">v1.0</span> · 92.5 Silver ERP
        </div>
      </aside>
    </>
  );
}
