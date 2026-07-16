'use client';

import * as React from 'react';
import { Menu, LogOut, ChevronDown, UserCircle2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { FiscalYearChip } from '@/lib/fiscal-year';

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = React.useState(false);

  const role = (user?.role ?? '').toUpperCase();
  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-card/80 px-3 backdrop-blur-md sm:h-16 sm:gap-3 sm:px-4">
      {/* Mobile menu */}
      <button
        onClick={onMenu}
        className="-ml-1 rounded-md p-2 text-text-muted transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </button>

      {/* Centre — date pill (desktop only) */}
      <div className="hidden items-center gap-3 lg:flex">
        <span className="rounded-md border border-border bg-secondary/40 px-2.5 py-1 font-mono text-[11px] text-text-faint">
          {today}
        </span>
      </div>

      {/* Right — FY chip + role + user dropdown */}
      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <FiscalYearChip />
        {role && (
          <span className="hidden items-center gap-1 rounded-full border border-gold/30 bg-gold/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold-light sm:inline-flex">
            <ShieldCheck className="size-3" />
            {role}
          </span>
        )}

        <div className="relative">
          <button
            onClick={() => setOpen((o) => !o)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground transition-colors hover:border-gold/30 hover:bg-secondary"
          >
            <UserCircle2 className="size-5 text-gold/80" />
            <span className="hidden font-medium sm:inline">{user?.fullName ?? 'User'}</span>
            <ChevronDown className="size-4 text-text-faint" />
          </button>
          {open && (
            <div className="absolute right-0 mt-1 w-52 rounded-md border border-border bg-card py-1 shadow-2xl ring-1 ring-gold/10">
              <div className="px-3 py-2 text-xs text-text-faint">
                Signed in as <span className="font-semibold text-foreground">{user?.username}</span>
              </div>
              <div className="my-1 border-t border-border" />
              <button
                onMouseDown={logout}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
