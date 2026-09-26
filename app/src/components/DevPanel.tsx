'use client';
import Link from 'next/link';
import { useState } from 'react';
import { pct, short } from '@/lib/format';
import type { StateJson } from '@/lib/types';

interface Log {
  t: string;
  text: string;
  tx?: string;
  ok: boolean;
}

/** Dev-only demo controls (rendered only when the API reports a dev chain). All signing is server-side. */
export function DevPanel({ s, onDone }: { s: StateJson; onDone: () => void }) {
  const [size, setSize] = useState('5');
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Log[]>([]);
  const push = (l: Omit<Log, 't'>) => setLog((x) => [{ ...l, t: new Date().toLocaleTimeString() }, ...x].slice(0, 8));

  async function call(label: string, url: string, body: unknown) {
    setBusy(label);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      return j;
    } catch (e) {
      push({ text: `${label}: ${(e as Error).message}`, ok: false });
      return null;
    } finally {
      setBusy(null);
      onDone();
    }
  }

  async function swap(direction: 'arb' | 'reverse') {
    const j = await call('Execute swap', '/api/dev/swap', { direction, size: Number(size), target: 'both' });
    if (!j) return;
    const oni = j.results.find((r: { pool: string }) => r.pool === s.pools.oniblock.name);
    push({
      text: `${direction === 'arb' ? 'Arb-direction' : 'Reverse'} swap ${size} ${s.pair.base} on both pools · Oniblock quoted fee ${pct(j.quotedFeePips)} (gap ${(j.quotedGapPips / 100).toFixed(1)} bps)`,
      tx: oni?.hash,
      ok: true,
    });
  }

  const quoterBadge = (on?: boolean) =>
    on === undefined ? <span className="text-muted">?</span> : on ? <span className="text-good">● active</span> : <span className="text-bad">○ revoked</span>;

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">Dev controls</h3>
        <span className="text-xs text-muted">
          {s.chain.name} · chain {s.chain.chainId} · anvil dev keys, server-side
        </span>
      </div>

      <div className="mb-4">
        <div className="label mb-1.5">Execute swap (same swap on both pools)</div>
        <div className="flex items-center gap-2">
          <input
            value={size}
            onChange={(e) => setSize(e.target.value)}
            className="w-20 rounded-md border border-line bg-bg px-2 py-1.5 text-sm"
            inputMode="decimal"
          />
          <span className="text-sm text-ink-2">{s.pair.base}</span>
          <button disabled={!!busy} onClick={() => swap('arb')} className="rounded-md bg-oni px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            Arb direction
          </button>
          <button disabled={!!busy} onClick={() => swap('reverse')} className="rounded-md border border-line px-3 py-1.5 text-sm disabled:opacity-50">
            Reverse
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">Arb direction pays base + k·max(0, gap − arb threshold) (anchored for the block); below the threshold and in reverse it pays the base fee.</p>
      </div>

      <div className="mb-4">
        <div className="label mb-1.5">Model</div>
        <div className="flex items-center gap-2">
          <button
            disabled={!!busy}
            onClick={async () => {
              const j = await call('Degrade model', '/api/dev/degrade', { degraded: !s.flags.degraded });
              if (j) push({ text: j.degraded ? 'Keeper now posts a deliberately wrong model — watch its calibration score rise and k clamp' : 'Model restored', ok: true });
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${s.flags.degraded ? 'bg-bad text-white' : 'border border-line'}`}
          >
            {s.flags.degraded ? 'Degraded — restore model' : 'Degrade model'}
          </button>
          <span className="text-xs text-muted">keeper reads .runtime/keeper-flags.json each block</span>
        </div>
      </div>

      <div className="mb-4">
        <div className="label mb-1.5">Kill switch ({s.roleOracleType === 'mock' ? 'MockRoleOracle' : 'ENSv2 roles'})</div>
        <div className="mb-2 grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-xs">
          <span className="text-muted">quoter</span>
          <span className="mono">
            {s.roles.quoterName ? <span className="font-sans text-ink">{s.roles.quoterName} · </span> : null}
            {short(s.roles.quoter)}
          </span>
          {quoterBadge(s.roles.quoterActive)}
          <span className="text-muted">backup</span>
          <span className="mono">{short(s.roles.backupQuoter)}</span>
          {quoterBadge(s.roles.backupActive)}
        </div>
        <div className="flex flex-wrap gap-2">
          <button disabled={!!busy} onClick={async () => { const j = await call('Revoke quoter', '/api/dev/quoter', { action: 'revoke' }); if (j) push({ text: 'Quoter revoked — next attestation reverts, mid goes stale → conservative fee', tx: j.txs[0]?.hash, ok: true }); }} className="rounded-md border border-bad px-3 py-1.5 text-sm text-bad disabled:opacity-50">
            Revoke quoter
          </button>
          <button disabled={!!busy} onClick={async () => { const j = await call('Grant backup', '/api/dev/quoter', { action: 'grant-backup' }); if (j) push({ text: 'Backup quoter granted — keeper switches key, attestations resume', tx: j.txs[0]?.hash, ok: true }); }} className="rounded-md border border-good px-3 py-1.5 text-sm text-good disabled:opacity-50">
            Grant backup quoter
          </button>
          <button disabled={!!busy} onClick={async () => { const j = await call('Restore', '/api/dev/quoter', { action: 'restore' }); if (j) push({ text: 'Primary quoter restored', ok: true }); }} className="rounded-md border border-line px-3 py-1.5 text-sm disabled:opacity-50">
            Restore primary
          </button>
        </div>
      </div>

      {busy && <div className="mb-2 text-xs text-ink-2">{busy}…</div>}
      <ul className="space-y-1 text-xs">
        {log.map((l, i) => (
          <li key={i} className={l.ok ? 'text-ink-2' : 'text-bad'}>
            <span className="text-muted">{l.t}</span> {l.text}{' '}
            {l.tx && (
              <Link className="text-oni underline" href={`/receipt/${l.tx}`}>
                receipt
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
