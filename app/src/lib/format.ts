/** Client-safe formatting helpers (units: pips = 1e-6, bps = 1e-4). */
export const pct = (pips: number | null | undefined, digits = 2) => (pips == null ? '—' : `${(pips / 10_000).toFixed(digits)}%`);
export const bpsPct = (bps: number | null | undefined, digits = 1) => (bps == null ? '—' : `${(bps / 100).toFixed(digits)}%`);
export const kFmt = (bps: number | null | undefined) => (bps == null ? '—' : (bps / 10_000).toFixed(2));
export const prob = (bps: number | null | undefined) => (bps == null ? '—' : (bps / 10_000).toFixed(2));
export const brier = (bps: number | null | undefined) => (bps == null ? '—' : (bps / 10_000).toFixed(3));
export const gapBps = (pips: number | null | undefined) => (pips == null ? '—' : `${(pips / 100).toFixed(1)} bps`);
export const short = (h?: string | null, n = 6) => (!h ? '—' : h.length <= 2 * n + 2 ? h : `${h.slice(0, n + 2)}…${h.slice(-n)}`);

export function money(x: number | null | undefined, digits = 2) {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${x < 0 ? '−' : ''}${s}`;
}

export function signed(x: number | null | undefined, digits = 2) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x > 0 ? '+' : ''}${money(x, digits)}`;
}

export function price(x: number | null | undefined) {
  if (x == null || !Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
