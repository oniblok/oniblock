import type { FeedRow } from '@/lib/types';

/** Verdict shown for a swap. The score is p·c of the attestation in force, applied only to arb-direction swaps. */
export function verdict(r: Pick<FeedRow, 'score' | 'arbDir' | 'stale'>): { label: string; tone: 'toxic' | 'watch' | 'clean' | 'neutral' | 'stale' } {
  if (r.stale) return { label: 'Oracle stale', tone: 'stale' };
  if (!r.arbDir) return { label: 'Counter-trend', tone: 'neutral' };
  if (r.score >= 0.6) return { label: 'Toxic', tone: 'toxic' };
  if (r.score >= 0.3) return { label: 'Suspicious', tone: 'watch' };
  return { label: 'Clean', tone: 'clean' };
}

/** Row tint: nothing below 0.15, then a red that deepens with the score. */
export function tint(score: number): { bg: string; strip: string; text: string } {
  if (score < 0.15) return { bg: 'transparent', strip: 'transparent', text: 'var(--text-2)' };
  const s = Math.min(1, score);
  const a = 0.05 + 0.3 * s ** 1.3;
  const strip = `rgba(var(--toxic) / ${(0.35 + 0.65 * s).toFixed(2)})`;
  return {
    bg: `linear-gradient(90deg, rgba(var(--toxic) / ${(a + 0.06).toFixed(3)}) 0%, rgba(var(--toxic) / ${(a * 0.45).toFixed(3)}) 55%, rgba(var(--toxic) / ${(a * 0.2).toFixed(3)}) 100%)`,
    strip,
    text: s >= 0.6 ? 'var(--bad-soft)' : 'var(--bad-softer)',
  };
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round(now - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function amt(x: number): string {
  if (x >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (x >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return x.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function usd(x: number, digits?: number): string {
  const d = digits ?? (Math.abs(x) >= 100 ? 0 : 2);
  return `$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function rowKey(r: Pick<FeedRow, 'tx' | 'logIndex'>) {
  return `${r.tx}:${r.logIndex}`;
}
