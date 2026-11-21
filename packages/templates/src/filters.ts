/** A filter gets the current value and its string arguments; it never runs user code. */
export type Filter = (value: unknown, args: string[]) => unknown;

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';

const toNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const toDate = (v: unknown): Date | undefined => {
  const n = toNumber(v);
  const d =
    n !== undefined ? new Date(n < 1e10 ? n * 1000 : n) : typeof v === 'string' ? new Date(v) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
};

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** UTC formatting with tokens yyyy MM dd HH mm ss SSS. */
export function formatDate(d: Date, format = 'yyyy-MM-dd HH:mm:ss'): string {
  const parts: Record<string, string> = {
    yyyy: String(d.getUTCFullYear()),
    MM: pad(d.getUTCMonth() + 1),
    dd: pad(d.getUTCDate()),
    HH: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
    SSS: pad(d.getUTCMilliseconds(), 3),
  };
  return format.replace(/yyyy|SSS|MM|dd|HH|mm|ss/g, (t) => parts[t]!);
}

export const FILTERS: Record<string, Filter> = {
  upper: (v) => (isEmpty(v) ? v : String(v).toUpperCase()),
  lower: (v) => (isEmpty(v) ? v : String(v).toLowerCase()),
  truncate: (v, [len = '80']) => {
    if (isEmpty(v)) return v;
    const s = String(v);
    const n = Number(len);
    return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
  },
  number: (v, [decimals]) => {
    const n = toNumber(v);
    if (n === undefined) return v;
    const d = decimals === undefined ? undefined : Number(decimals);
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d ?? 3 }).format(
      n,
    );
  },
  currency: (v, [code]) => {
    const n = toNumber(v);
    if (n === undefined) return v;
    if (!code)
      return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(n);
    } catch {
      return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${code}`;
    }
  },
  date: (v, [format]) => {
    const d = toDate(v);
    return d ? formatDate(d, format) : v;
  },
  default: (v, [fallback = '']) => (isEmpty(v) ? fallback : v),
  json: (v) => JSON.stringify(v ?? null),
};
