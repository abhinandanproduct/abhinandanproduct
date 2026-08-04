'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

/**
 * Mobile responsiveness helper.
 *
 * Below 1280px the global `.table-scroll` CSS collapses a `<table>` into a
 * stacked-card layout, showing each cell's label from its `data-label`
 * attribute (`td[data-label]::before`). Hand-adding `data-label` to every
 * `<td>` across dozens of pages is impractical, so this component does it
 * automatically: for every `.table-scroll > table` it copies each column's
 * `<thead> <th>` text onto the matching `<td>` in the body. Cells that
 * already declare their own `data-label` are left untouched, and colspan
 * cells (footers / empty-state rows) are skipped.
 *
 * Mounted once in the app shell. Re-runs on route change and, debounced,
 * whenever new rows render (data loads asynchronously via TanStack Query).
 */
export function AutoTableLabels() {
  const pathname = usePathname();

  React.useEffect(() => {
    // Copy each column's header text onto the matching body cell's
    // data-label, so the stacked-card CSS can show a label per value.
    const labelTable = (table: HTMLTableElement) => {
      const headRow = table.querySelector(':scope > thead > tr:last-child');
      const headers = headRow
        ? Array.from(headRow.querySelectorAll(':scope > th')).map((th) => (th.textContent || '').replace(/\s+/g, ' ').trim())
        : [];
      if (!headers.length) return;
      table.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr').forEach((tr) => {
        const cells = Array.from(tr.children).filter((c) => c.tagName === 'TD') as HTMLTableCellElement[];
        // Skip rows that don't map 1:1 to the header (e.g. a single colspan
        // cell for an empty-state / grouping row).
        if (cells.length !== headers.length) return;
        cells.forEach((td, i) => {
          if (td.colSpan > 1) return;
          const label = headers[i];
          if (label && !td.hasAttribute('data-label')) td.setAttribute('data-label', label);
        });
      });
    };

    const apply = () => {
      // Every data table in the page body. `.table-scroll` tables already
      // stack via their own CSS; all other tables get the `stackable` class
      // so they stack the same way on phones/tablets. Both then get their
      // cells labelled from the column headers. Tables that opt out (a
      // `no-stack` class — e.g. a deliberately compact desktop-only grid)
      // are left alone.
      document.querySelectorAll<HTMLTableElement>('main table').forEach((table) => {
        if (table.classList.contains('no-stack')) return;
        if (!table.closest('.table-scroll')) table.classList.add('stackable');
        labelTable(table);
      });
    };

    apply();

    // Re-apply (debounced) when rows arrive after the initial render.
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(() => { scheduled = false; apply(); }, 150);
    };
    const observer = new MutationObserver((muts) => {
      if (muts.some((m) => m.addedNodes.length > 0)) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [pathname]);

  return null;
}
