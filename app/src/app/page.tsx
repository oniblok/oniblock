'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chart } from '@/components/live/Chart';
import { JudgementModal } from '@/components/live/JudgementModal';
import { SwapModal } from '@/components/live/SwapModal';
import { usd } from '@/components/live/score';
import { TxList, type Pending } from '@/components/live/TxList';
import type { FeedJson, FeedRow } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';

const MINE_KEY = 'oniblock.mine';

function loadMine(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MINE_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function saveMine(v: string[]) {
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(v.slice(-200)));
  } catch {
    /* storage unavailable: labels just won't persist */
  }
}

export default function Live() {
  const { data: feed, error } = usePoll<FeedJson>('/api/feed?rows=80', 2500);
  // client-only page content (rows render after the first poll), so reading storage in the initialiser is safe
  const [mine, setMine] = useState<string[]>(() => (typeof window === 'undefined' ? [] : loadMine()));
  const [pending, setPending] = useState<Pending[]>([]);
  // deep links: ?swap=1 opens the swap modal, ?tx=0x… opens that swap's judgement once it is in the feed
  const [swapOpen, setSwapOpen] = useState(() => typeof window !== 'undefined' && new URLSearchParams(location.search).get('swap') === '1');
  const [deepTx, setDeepTx] = useState(() => (typeof window === 'undefined' ? null : new URLSearchParams(location.search).get('tx')?.toLowerCase() ?? null));
  const [picked, setPicked] = useState<FeedRow | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  // a pending placeholder hides as soon as its swap is in the feed; the "landed" toast shows for a few seconds
  const seen = useMemo(() => new Set((feed?.rows ?? []).map((r) => r.tx.toLowerCase())), [feed]);
  const waiting = pending.filter((p) => !seen.has(p.hash.toLowerCase()));
  const landed = pending.find((p) => seen.has(p.hash.toLowerCase()));
  useEffect(() => {
    if (!landed) return;
    const t = setTimeout(() => setPending((ps) => ps.filter((p) => p.hash !== landed.hash)), 4500);
    return () => clearTimeout(t);
  }, [landed]);
  const toast = landed ? 'Your swap landed. Click it to see how Oniblock judged it.' : null;

  const mineSet = useMemo(() => new Set(mine.map((h) => h.toLowerCase())), [mine]);
  const onSubmitted = useCallback((hash: string, label: string) => {
    setMine((m) => {
      const v = [...m, hash];
      saveMine(v);
      return v;
    });
    setPending((p) => [...p, { hash, label }]);
  }, []);

  const open = picked ?? (deepTx ? (feed?.rows.find((r) => r.tx.toLowerCase() === deepTx) ?? null) : null);
  const closeJudgement = useCallback(() => {
    setPicked(null);
    setDeepTx(null);
  }, []);

  const edge = feed ? feed.chart.oniTotal - feed.chart.vanTotal : 0;
  const chainLabel = !feed ? '' : feed.chain.name === 'sepolia' ? 'Ethereum Sepolia' : feed.chain.name === 'fork' ? 'Sepolia fork' : 'Local chain';

  return (
    <div className="mx-auto flex h-screen max-w-[1240px] flex-col gap-4 px-5 py-4">
      {/* header */}
      {/* wraps / shrinks on narrow screens (390 px) so the Swap button never causes a horizontal scroll */}
      <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex shrink-0 items-center gap-2.5">
          <Logo />
          <span className="font-display text-[19px] uppercase leading-none">Oniblock</span>
        </div>
        {feed && (
          <div className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-line bg-surface px-3 py-1 text-xs text-ink-2">
            <span className={`live-dot h-1.5 w-1.5 shrink-0 rounded-full ${error ? 'bg-warn' : 'bg-good'}`} />
            <span className="min-w-0 truncate">{chainLabel}</span>
            <span className="mono shrink-0 text-muted">#{feed.chain.block.toLocaleString()}</span>
          </div>
        )}
        {feed && (
          <button
            onClick={() => setSwapOpen(true)}
            className="ml-auto flex h-10 shrink-0 items-center gap-2 rounded-md bg-primary pl-4 pr-5 text-xs font-bold uppercase text-white transition-colors hover:bg-primary-hover"
          >
            <span className="text-base leading-none">⇅</span> Swap
          </button>
        )}
      </header>

      {/* chart */}
      <section className="glass flex h-[36vh] min-h-[250px] flex-col px-5 pb-3 pt-4">
        <div className="mb-2 flex flex-wrap items-end gap-x-8 gap-y-2">
          <Figure color="var(--oni)" label="LPs with Oniblock" value={feed?.chart.oniTotal} solid />
          <Figure color="var(--vanilla)" label="LPs without (plain pool)" value={feed?.chart.vanTotal} />
          {feed && (
            <div className={`rounded-md px-3 py-1 text-xs font-medium ${edge >= 0 ? 'bg-oni/12 text-oni' : 'bg-bad/12 text-bad-soft'}`}>
              Oniblock edge {edge >= 0 ? '+' : '−'}
              {usd(Math.abs(edge), 2)}
            </div>
          )}
          <div className="ml-auto text-right text-[11px] leading-tight text-muted">
            LP profit vs Binance
          </div>
        </div>
        <div className="min-h-0 flex-1">{feed ? <Chart buckets={feed.chart.buckets} quote={feed.pair.quote} /> : <Skeleton />}</div>
      </section>

      {/* swaps */}
      <section className="glass relative flex min-h-0 flex-1 flex-col pt-3">
        <div className="flex items-center gap-3 px-5 pb-2">
          <div className="text-sm font-bold">Live swaps</div>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted">
            clean
            <span className="h-1.5 w-20 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.08), rgba(239,83,80,0.45), rgb(239,83,80))' }} />
            toxic
          </div>
        </div>
        <div className="mx-5 grid grid-cols-[52px_minmax(0,1fr)_minmax(0,150px)_minmax(0,190px)_16px] gap-4 border-b border-line px-4 pb-2 text-[10.5px] uppercase tracking-[0.08em] text-muted">
          <span>Age</span>
          <span>Trade</span>
          <span>Fee charged</span>
          <span>Oniblock score</span>
          <span />
        </div>
        <div className="min-h-0 flex-1 px-4 pb-3 pt-1">
          {feed ? <TxList rows={feed.rows} base={feed.pair.base} mine={mineSet} pending={waiting} now={now} onOpen={setPicked} /> : <Skeleton />}
        </div>
      </section>

      {error && !feed && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-bad/40 bg-surface px-4 py-2 text-xs text-bad-soft">{error}</div>}
      {toast && <div className="pop-in fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-md border border-oni/40 bg-surface px-4 py-2 text-xs text-oni shadow-xl">{toast}</div>}

      {feed && <SwapModal open={swapOpen} onClose={() => setSwapOpen(false)} feed={feed} onSubmitted={onSubmitted} />}
      {feed && open && <JudgementModal key={`${open.tx}:${open.logIndex}`} row={open} feed={feed} you={mineSet.has(open.tx.toLowerCase())} onClose={closeJudgement} />}
    </div>
  );
}

function Figure({ color, label, value, solid }: { color: string; label: string; value?: number; solid?: boolean }) {
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-2 text-xs text-ink-2">
        <span className="inline-block h-[2px] w-4 rounded" style={{ background: solid ? color : `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` }} />
        {label}
      </div>
      <div className="mono text-2xl font-semibold tracking-tight" style={{ color: solid ? 'var(--text)' : 'var(--text-2)' }}>
        {value == null ? '—' : `${value >= 0 ? '+' : '−'}${usd(Math.abs(value), 2)}`}
      </div>
    </div>
  );
}

function Skeleton() {
  return <div className="h-full w-full animate-pulse rounded-lg bg-white/[0.02]" />;
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b6cf5" />
          <stop offset="1" stopColor="#0344dc" />
        </linearGradient>
      </defs>
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" fill="url(#lg)" />
      <path d="M12 7.2l4.16 2.4v4.8L12 16.8l-4.16-2.4V9.6z" fill="#141314" />
    </svg>
  );
}
