'use client';
import { useMemo, useState } from 'react';
import type { FeedJson } from '@/lib/types';
import { Modal } from './Modal';
import { amt, usd } from './score';

const PRESETS = { base: [0.1, 0.5, 1, 2], quote: [250, 1000, 2500, 5000] };

/** Exact-in swap on the Oniblock pool, signed by the demo swapper server-side (no wallet needed). */
export function SwapModal({ open, onClose, feed, onSubmitted }: { open: boolean; onClose: () => void; feed: FeedJson; onSubmitted: (hash: string, label: string) => void }) {
  const [pay, setPay] = useState<'base' | 'quote'>('quote');
  const [amount, setAmount] = useState('1000');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { base, quote } = feed.pair;
  const m = feed.market;
  const a = Number(amount);

  const q = useMemo(() => {
    const d = pay === 'base' ? m.sellBase : m.buyBase;
    const x = pay === 'base' ? m.reserveBase : m.reserveQuote;
    const y = pay === 'base' ? m.reserveQuote : m.reserveBase;
    const out = (fee: number) => {
      if (!(a > 0) || !(x > 0)) return 0;
      const dx = a * (1 - fee / 1e6);
      return (y * dx) / (x + dx);
    };
    const mid = m.oracleMid ?? m.poolMid;
    const inUsd = pay === 'base' ? a * mid : a;
    return {
      feePips: d.feePips,
      arbDir: d.arbDir,
      out: out(d.feePips),
      feeUsd: (inUsd * d.feePips) / 1e6,
      extraUsd: (inUsd * Math.max(0, d.feePips - feed.baseFeePips)) / 1e6,
    };
  }, [pay, a, m, feed.baseFeePips]);

  const flip = () => {
    const mid = m.oracleMid ?? m.poolMid;
    setPay(pay === 'base' ? 'quote' : 'base');
    if (a > 0) setAmount(pay === 'base' ? String(Math.round(a * mid)) : String(+(a / mid).toFixed(3)));
    setErr(null);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pay, amount: a }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      const label = pay === 'base' ? `Sell ${amt(a)} ${base}` : `Buy ${base} with ${amt(a)} ${quote}`;
      onSubmitted(j.hash as string, label);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tokIn = pay === 'base' ? base : quote;
  const tokOut = pay === 'base' ? quote : base;
  const disabled = busy || !feed.swapEnabled || !(a > 0);

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <div className="p-6">
        <div className="font-display mb-1 text-2xl uppercase leading-none">Swap</div>
        <div className="mb-5 text-xs text-muted">
          {base}/{quote} Oniblock pool · {feed.chain.name === 'sepolia' ? 'Ethereum Sepolia' : feed.chain.name === 'fork' ? 'Sepolia fork' : 'local chain'}
        </div>

        <div className="relative">
          <Field label="You pay" token={tokIn}>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setErr(null);
              }}
              className="w-full bg-transparent text-3xl font-medium tracking-tight text-ink outline-none placeholder:text-muted"
              placeholder="0"
              autoFocus
            />
          </Field>
          <button
            onClick={flip}
            className="absolute left-1/2 top-1/2 z-10 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md border-4 border-surface bg-surface-3 text-ink-2 transition hover:rotate-180 hover:text-ink"
            aria-label="Switch direction"
          >
            ↓
          </button>
          <div className="h-1" />
          <Field label="You receive (est.)" token={tokOut}>
            <div className="text-3xl font-medium tracking-tight text-ink-2">{q.out > 0 ? amt(q.out) : '0'}</div>
          </Field>
        </div>

        <div className="mt-3 flex gap-2">
          {PRESETS[pay].map((p) => (
            <button key={p} onClick={() => setAmount(String(p))} className="whitespace-nowrap rounded-md border border-line bg-surface-2 px-3 py-1 text-xs font-bold text-ink-2 hover:border-line-strong hover:text-ink">
              {amt(p)}
            </button>
          ))}
        </div>

        <div className={`mt-5 rounded-lg border p-4 text-sm ${q.arbDir ? 'border-bad/35 bg-bad/6' : 'border-line bg-surface-2'}`}>
          <div className="flex items-center justify-between">
            <span className="text-ink-2">Oniblock fee now</span>
            <span className="mono text-ink">{(q.feePips / 10_000).toFixed(2)}%</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-muted">Plain Uniswap pool</span>
            <span className="mono text-muted">{((feed.vanillaFeePips ?? feed.baseFeePips) / 10_000).toFixed(2)}%</span>
          </div>
          <div className="mt-3 text-xs leading-relaxed text-ink-2">
            {q.arbDir && q.feePips - feed.baseFeePips < 100 ? (
              <>This trade moves the pool toward the Binance price (the arbitrage direction), but the model&apos;s current k keeps the fee at the base rate.</>
            ) : q.arbDir ? (
              <>
                This trade moves the pool <b className="text-ink">toward the Binance price</b>, which is what an arbitrageur does. Oniblock charges{' '}
                <b className="text-bad-soft">+{usd(q.extraUsd, 2)}</b> extra, paid to LPs.
              </>
            ) : (
              <>This trade goes against the arbitrage direction, so you pay only the base fee ({usd(q.feeUsd, 2)}).</>
            )}
          </div>
        </div>

        {err && <div className="mt-3 rounded-md bg-bad/10 px-3 py-2 text-xs text-bad-soft">{err}</div>}

        <button
          onClick={submit}
          disabled={disabled}
          className="mt-5 h-12 w-full rounded-md bg-primary text-[13px] font-bold uppercase text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-muted"
        >
          {busy ? 'Sending…' : !feed.swapEnabled ? 'Swaps disabled' : 'Swap'}
        </button>
        <div className="mt-3 text-center text-[11px] text-muted">Signed by the demo wallet. No wallet needed; test tokens only.</div>
      </div>
    </Modal>
  );
}

function Field({ label, token, children }: { label: string; token: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-4 pb-4 pt-3">
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        <span className="shrink-0 rounded-md border border-line bg-surface-3 px-3 py-1.5 text-sm font-bold text-ink">{token}</span>
      </div>
    </div>
  );
}
