'use client';
import { useEffect, useState } from 'react';
import type { ReceiptPage } from '@/lib/server/receipt';
import type { FeedJson, FeedRow } from '@/lib/types';
import { Modal } from './Modal';
import { amt, tint, usd, verdict } from './score';

/**
 * One swap, judged: the verdict and score (instant, from the feed row), then the proof loaded from /api/receipt:
 * the attestation in force, its EIP-712 signer, the quoter's ENS name, and the model's calibration records on ENS.
 */
export function JudgementModal({ row, feed, you, onClose }: { row: FeedRow | null; feed: FeedJson; you: boolean; onClose: () => void }) {
  const [rc, setRc] = useState<ReceiptPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!row) return;
    let live = true; // parent keys this component per swap, so state starts fresh
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    // A freshly landed swap may not be fully indexed by the RPC yet (500) or its next-block data may still be pending:
    // retry every RETRY_MS for up to RETRY_FOR_MS, keeping "loading proof…" instead of a raw RPC error.
    const load = async () => {
      let again = false;
      try {
        const r = await fetch(`/api/receipt/${row.tx}`, { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j as { error?: string }).error ?? r.statusText);
        if (!live) return;
        setRc(j as ReceiptPage);
        setErr(null);
        again = !!(j as ReceiptPage).pending;
      } catch (e) {
        if (!live) return;
        again = true;
        if (Date.now() - started + RETRY_MS > RETRY_FOR_MS) setErr((e as Error).message);
      }
      if (live && again && Date.now() - started + RETRY_MS <= RETRY_FOR_MS) timer = setTimeout(load, RETRY_MS);
    };
    load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [row]);

  if (!row) return null;
  const v = verdict(row);
  const t = tint(row.score);
  const { base } = feed.pair;
  const att = rc?.attestation;
  const cal = rc?.calibration;
  const ens = cal?.ens ?? {};
  const bpsTxt = (s?: string, d = 1) => (s && s !== '' && Number.isFinite(Number(s)) ? `${(Number(s) / 100).toFixed(d)}%` : null);
  const brierTxt = (s?: string) => (s && Number.isFinite(Number(s)) ? (Number(s) / 10_000).toFixed(3) : null);
  // "" (unset ENS record) and 0 both mean the settler has not graded this model yet
  const calN = ens['calibration.n'] ? Number(ens['calibration.n']) : cal?.hook?.n;
  const graded = calN != null && Number.isFinite(calN) && calN > 0;
  const status = cal?.demotedNow ? (cal.unseasoned ? 'On probation' : 'Demoted') : cal ? 'Active' : null;
  const outcome = row.markoutUsd;
  const judgedToxic = row.arbDir && !row.stale && row.score >= 0.5;
  const correct = outcome === null || !row.arbDir || row.stale ? null : judgedToxic === outcome > 0;
  const thr = Number((rc?.config as { arbThresholdPips?: number } | undefined)?.arbThresholdPips ?? 0);

  return (
    <Modal open onClose={onClose} width={520}>
      {/* header */}
      <div className="relative overflow-hidden rounded-t-lg border-b border-line px-6 pb-5 pt-6" style={{ background: row.score >= 0.15 ? t.bg : 'var(--surface-2)' }}>
        <div className="mb-3 flex items-center gap-2 text-xs text-muted">
          <span className="mono">block {row.block.toLocaleString()}</span>
          {you && <span className="rounded-sm bg-primary px-2 py-0.5 text-[10px] font-bold tracking-wider text-white">YOUR SWAP</span>}
        </div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-[13px] text-ink-2">Oniblock judgement</div>
            <div className={`font-display text-[34px] uppercase leading-tight ${v.tone === 'toxic' ? 'text-bad-soft' : v.tone === 'watch' ? 'text-bad-softer' : v.tone === 'stale' ? 'text-warn' : 'text-ink'}`}>
              {v.tone === 'toxic' ? 'Toxic arbitrage' : v.tone === 'watch' ? 'Suspicious flow' : v.tone === 'clean' ? 'Clean flow' : v.tone === 'stale' ? 'Oracle stale' : 'Counter-trend trade'}
            </div>
          </div>
          <div className="text-right">
            <div className="mono text-4xl font-semibold" style={{ color: row.score >= 0.15 ? t.text : 'var(--text)' }}>
              {row.arbDir && !row.stale ? row.score.toFixed(2) : '—'}
            </div>
            <div className="text-[11px] text-muted">score = p × confidence</div>
          </div>
        </div>
        <div className="mt-3 text-sm text-ink-2">
          {row.side === 'buy' ? 'Bought' : 'Sold'} <b className="text-ink">{amt(row.baseAmount)} {base}</b> ({usd(row.usd)}) · paid{' '}
          <b className="text-ink">{(row.feePips / 10_000).toFixed(2)}%</b>
          {row.feePips - row.baseFeePips >= 100 && row.extraUsd >= 0.005 && (
            <>
              {' '}
              → <b className="text-oni">+{usd(row.extraUsd, 2)}</b> to LPs
            </>
          )}
        </div>
      </div>

      <div className="space-y-5 px-6 pb-6 pt-5">
        {/* why */}
        <Section title="Why this fee">
          <div className="grid grid-cols-3 gap-2">
            <Stat k="P(toxic)" v={row.pToxicBps != null ? `${(row.pToxicBps / 100).toFixed(0)}%` : '—'} />
            <Stat k="Confidence" v={row.confidenceBps != null ? `${(row.confidenceBps / 100).toFixed(0)}%` : '—'} />
            <Stat k="k (fee slope)" v={(row.kBps / 10_000).toFixed(2)} />
          </div>
          <div className="mt-3 rounded-md border border-line bg-surface-2 px-4 py-3 text-xs leading-relaxed text-ink-2">
            {row.stale ? (
              <>No fresh attestation, so the pool charged its conservative fee.</>
            ) : row.arbDir ? (
              <>
                Pool price was <b className="text-ink">{(row.gapPips / 100).toFixed(1)} bps</b> off Binance and this trade closed the gap.
                {row.kBps === 0 && (
                  <> The fee slope k was 0 at this block (the model was still on probation or demoted by its calibration), so only the base fee applied.</>
                )}
                <div className="mono mt-2 text-[11px] text-muted">
                  fee = base {(row.baseFeePips / 10_000).toFixed(2)}% + k·(gap{thr ? ` − ${(thr / 100).toFixed(1)} bps` : ''}) = <span className="text-ink">{(row.feePips / 10_000).toFixed(2)}%</span>
                </div>
              </>
            ) : (
              <>This trade moved the pool away from Binance (not arbitrage), so it paid the base fee.</>
            )}
          </div>
        </Section>

        {/* outcome */}
        {row.arbDir && !row.stale && (
          <Section title="What actually happened">
            {outcome === null ? (
              <div className="text-xs text-muted">Waiting for the next Binance price to grade this trade…</div>
            ) : (
              <div className="flex items-center justify-between rounded-md border border-line bg-surface-2 px-4 py-3">
                <div className="text-xs text-ink-2">
                  Trader {outcome > 0 ? 'beat' : 'lost to'} Binance by <b className="text-ink">{usd(Math.abs(outcome), 2)}</b>
                  <div className="text-muted">{outcome > 0 ? 'informed flow: LPs were the losing side' : 'uninformed flow'}</div>
                </div>
                {correct !== null && (
                  <span className={`rounded-sm px-2.5 py-1 text-[11px] font-medium ${correct ? 'bg-oni/15 text-oni' : 'bg-warn/12 text-warn'}`}>{correct ? '✓ judgement matched' : '✗ judgement missed'}</span>
                )}
              </div>
            )}
          </Section>
        )}

        {/* trust / ENS */}
        <Section title="Who judged it: verified via ENS">
          {!rc && !err && (
            <div className="flex h-24 animate-pulse items-center justify-center rounded-md bg-surface-2 text-xs text-muted">loading proof…</div>
          )}
          {!rc && err && (
            <div className="rounded-md border border-line bg-surface-2 px-4 py-3 text-xs text-ink-2">
              Proof not available yet. Try again in a few seconds or open the full receipt.
              <div className="mono mt-1 truncate text-[11px] text-muted" title={err}>
                {err}
              </div>
            </div>
          )}
          {rc && (
            <div className="divide-y divide-line rounded-md border border-line bg-surface-2 text-xs">
              <Line k="Model" v={<span className="mono text-ink">{cal?.modelName ?? row.model ?? '—'}</span>} badge={status ? { t: status, ok: status === 'Active' } : undefined} />
              <Line
                k="Calibration (ENS records)"
                v={
                  graded ? (
                    <span className="mono text-ink-2">
                      Brier {brierTxt(ens['calibration.brier']) ?? (cal?.hook ? (cal.hook.brierBps / 10_000).toFixed(3) : '—')} · hit {bpsTxt(ens['calibration.hitRate'], 0) ?? (cal?.hook ? `${(cal.hook.hitRateBps / 100).toFixed(0)}%` : '—')} · n{' '}
                      {calN}
                    </span>
                  ) : (
                    <span className="text-muted">
                      not graded yet{cal?.minSamples ? <span className="mono"> (n 0 / {cal.minSamples})</span> : null}
                    </span>
                  )
                }
              />
              <Line
                k="Posted by"
                v={<span className="mono text-ink-2">{att?.quoterEns?.name ?? short(att?.quoter)}</span>}
                badge={att?.quoterEns ? { t: att.quoterEns.matches ? 'ENS role ✓' : 'mismatch', ok: !!att.quoterEns.matches } : undefined}
              />
              <Line
                k="Signed by attestor"
                v={<span className="mono text-ink-2">{short(att?.recovered)}</span>}
                badge={att ? { t: att.verified ? 'EIP-712 ✓' : att.verified === false ? 'invalid' : 'n/a', ok: !!att.verified } : undefined}
              />
            </div>
          )}
        </Section>

        <div className="flex items-center justify-between text-xs">
          {feed.chain.explorer ? (
            <a href={`${feed.chain.explorer}/tx/${row.tx}`} target="_blank" rel="noreferrer" className="text-ink-2 hover:text-ink">
              View on Etherscan ↗
            </a>
          ) : (
            <span className="mono text-muted">{short(row.tx)}</span>
          )}
          <a href={`/receipt/${row.tx}`} target="_blank" rel="noreferrer" className="text-muted hover:text-ink-2">
            Full receipt ↗
          </a>
        </div>
      </div>
    </Modal>
  );
}

const RETRY_MS = 3_000;
const RETRY_FOR_MS = 30_000;

function short(a?: string | null) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted">{title}</div>
      {children}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
      <div className="text-[11px] text-muted">{k}</div>
      <div className="mono mt-0.5 text-lg text-ink">{v}</div>
    </div>
  );
}

function Line({ k, v, badge }: { k: string; v: React.ReactNode; badge?: { t: string; ok: boolean } }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="shrink-0 text-muted">{k}</span>
      <span className="flex min-w-0 items-center gap-2 truncate">
        {v}
        {badge && <span className={`shrink-0 rounded-sm px-2 py-0.5 text-[10px] font-medium ${badge.ok ? 'bg-oni/15 text-oni' : 'bg-warn/12 text-warn'}`}>{badge.t}</span>}
      </span>
    </div>
  );
}
