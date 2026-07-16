'use client';

import * as React from 'react';

/** India fiscal year runs 1 April → 31 March.
 *  fy = 2026 means 2026-04-01 to 2027-03-31.
 */
export interface FiscalYear {
  startYear: number;
  start: string; // ISO YYYY-MM-DD
  end: string;
  label: string; // "2026 - 2027"
}

export function fyForDate(d: Date): number {
  const m = d.getMonth();
  const y = d.getFullYear();
  return m >= 3 ? y : y - 1; // before April → previous FY
}

export function makeFY(startYear: number): FiscalYear {
  return {
    startYear,
    start: `${startYear}-04-01`,
    end:   `${startYear + 1}-03-31`,
    label: `${startYear} - ${startYear + 1}`,
  };
}

const FY_KEY = 'erp_fy';

const FiscalYearContext = React.createContext<{
  fy: FiscalYear;
  setFy: (year: number) => void;
  years: FiscalYear[];
}>({
  fy: makeFY(new Date().getFullYear()),
  setFy: () => {},
  years: [],
});

export function FiscalYearProvider({ children }: { children: React.ReactNode }) {
  const today = new Date();
  const currentFY = fyForDate(today);
  // Span 5 fiscal years — 2 past + current + 2 future. Operator usually picks
  // current or last; past lookups beyond that go through reports.
  const years = React.useMemo(
    () => [-2, -1, 0, 1, 2].map((d) => makeFY(currentFY + d)),
    [currentFY],
  );

  const [startYear, setStartYear] = React.useState<number>(() => {
    if (typeof window === 'undefined') return currentFY;
    const stored = window.localStorage.getItem(FY_KEY);
    if (stored) {
      const n = Number(stored);
      if (Number.isFinite(n)) return n;
    }
    return currentFY;
  });

  const setFy = React.useCallback((y: number) => {
    setStartYear(y);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(FY_KEY, String(y));
      // Tell any open list-page query to refetch — they read FY off context
      // via useFiscalYear so re-render handles it; we just push a custom
      // event for code that listens (e.g. polling pages).
      window.dispatchEvent(new CustomEvent('fy-changed', { detail: { startYear: y } }));
    }
  }, []);

  const fy = React.useMemo(() => makeFY(startYear), [startYear]);

  return (
    <FiscalYearContext.Provider value={{ fy, setFy, years }}>
      {children}
    </FiscalYearContext.Provider>
  );
}

export function useFiscalYear() {
  return React.useContext(FiscalYearContext);
}

/** Header-bar selector chip. */
export function FiscalYearChip() {
  const { fy, setFy, years } = useFiscalYear();
  return (
    <select
      className="h-8 rounded-md border border-input bg-background px-2 text-xs font-medium tabular-nums"
      value={fy.startYear}
      onChange={(e) => setFy(Number(e.target.value))}
      title="Fiscal year filter — scopes invoices, bills, payments"
    >
      {years.map((y) => (
        <option key={y.startYear} value={y.startYear}>{y.label}</option>
      ))}
    </select>
  );
}
