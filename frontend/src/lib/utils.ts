import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const FILE_BASE =
  process.env.NEXT_PUBLIC_FILE_BASE ?? 'http://localhost:4000';

/** Build an absolute URL for an uploaded file path returned by the API. */
export function fileUrl(path?: string | null): string {
  if (!path) return '';
  if (path.startsWith('http') || path.startsWith('/uploads')) {
    return path.startsWith('http') ? path : FILE_BASE + path;
  }
  return `${FILE_BASE}/uploads/${path}`;
}

export function formatCurrency(value?: number | string | null): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (Number.isNaN(n)) return '—';
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

export function formatDate(value?: string | Date | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Map enum-ish status to a label + badge variant. */
export const SAMPLE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  IN_DEVELOPMENT: 'In Development',
  SAMPLE_READY: 'Sample Ready',
  PRODUCTION_READY: 'Production Ready',
};
