import Link from 'next/link';
import type { Hex } from 'viem';
import { bpsPct, brier, gapBps, kFmt, money, pct, price, prob, short } from '@/lib/format';
import { getReceiptPage, type AttestationView, type ReceiptPage } from '@/lib/server/receipt';

export const dynamic = 'force-dynamic';

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-4 border-t border-line py-1.5 text-sm first:border-t-0">
      <span className="w-48 shrink-0 text-muted">{k}</span>
      <span className={`min-w-0 break-all ${mono ? 'mono text-xs leading-5' : ''}`}>{v}</span>
    </div>
  );
}

function Big({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="label">{label}</div>
      <div className={`text-3xl font-semibold ${tone ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

function Attestation({ a, p, title }: { a: AttestationView; p: ReceiptPage; title: string }) {
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-3">
        <h3 className="font-semibold">{title}</h3>
        {a.verified === true && <span className="rounded bg-good/15 px-2 py-0.5 text-xs text-good">✓ verified at post time</span>}
        {a.verified === false && <span className="rounded bg-bad/15 px-2 py-0.5 text-xs text-bad">✗ signer ≠ attestor</span>}
      </div>
      <Row k="attested block" v={`${a.attBlock} (mined in ${a.minedBlock})`} />
      <Row k={`CEX mid (${p.pair.quote})`} v={price(a.oracleMid)} />
      <Row k="p_toxic / confidence" v={`${prob(a.pToxicBps)} / ${bpsPct(a.confidenceBps, 0)}`} />
      <Row k="attested k" v={kFmt(a.kBps)} />
      <Row k="model" v={<>{a.modelName ?? <span className="text-muted">unlabelled node</span>} <span className="text-muted">({a.model ?? '—'})</span></>} />
      <Row k="model node (namehash)" v={a.modelNode} mono />
      <Row
        k="quoter"
        v={
          <>
            <span className="mono text-xs">{a.quoter}</span>
            {a.quoterEns && (
              <span className="ml-2 text-xs">
                {a.quoterEns.name} → {a.quoterEns.resolved ? short(a.quoterEns.resolved) : 'unresolved'}{' '}
                {a.quoterEns.matches === true ? <span className="text-good">matches</span> : a.quoterEns.matches === false ? <span className="text-warn">differs (backup quoter?)</span> : null}
              </span>
            )}
          </>
        }
      />
      <Row k="attestation tx" v={<Link className="text-oni underline" href={`/receipt/${a.tx}`}>{a.tx}</Link>} mono />
      <div className="mt-3 label">EIP-712 signature (from setAttestation calldata)</div>
      {a.domain ? (
        <>
          <Row k="domain" v={`${a.domain.name} v${a.domain.version} · chainId ${a.domain.chainId} · ${a.domain.verifyingContract}`} mono />
          <Row k="type" v="Attestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96,uint32 pToxicBps,uint32 confidenceBps,bytes32 modelNode)" mono />
          <Row k="oracleMidX96" v={a.oracleMidX96} mono />
          <Row k="r" v={a.sig?.r} mono />
          <Row k="s" v={a.sig?.s} mono />
          <Row k="v" v={a.sig?.v} mono />
          <Row k="recovered signer" v={a.recovered} mono />
          <Row k="hook.attestor() at post" v={a.attestorAtPost} mono />
          {a.attestorNow && a.attestorNow !== a.attestorAtPost && <Row k="hook.attestor() now" v={a.attestorNow} mono />}
        </>
      ) : (
        <div className="text-sm text-warn">{a.verifyNote}</div>
      )}
    </div>
  );
}

export default async function ReceiptPageView({ params }: { params: Promise<{ tx: string }> }) {
  const { tx } = await params;
  let p: ReceiptPage;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error('invalid transaction hash');
    p = await getReceiptPage(tx as Hex);
  } catch (e) {
    return (
      <div className="card p-6">
        <div className="font-semibold text-bad">Could not load receipt</div>
        <div className="mt-1 text-sm text-ink-2">{((e as Error).message ?? '').split('\n')[0]}</div>
        <Link href="/" className="mt-3 inline-block text-sm text-oni underline">
          ← back to live demo
        </Link>
      </div>
    );
  }
  const r = p.receipts[0];
  const cfg = p.config as { baseFee: number; feeMax: number; brierDemoteBps: number; conservativeFee: number; arbThresholdPips?: number };
  const thr = Number(cfg.arbThresholdPips ?? 0);
  const sym0 = p.pair.token0;
  const sym1 = p.pair.token1;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <Link href="/" className="text-sm text-ink-2 hover:text-ink">← live</Link>
        <h1 className="text-xl font-semibold">Receipt</h1>
        <span className="mono text-xs text-muted">{p.tx}</span>
        <span className="ml-auto text-xs text-muted">block {p.block} · {p.chain.name} ({p.chain.chainId}) · {p.status}</span>
      </div>

      {p.notes.map((n) => (
        <div key={n} className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink-2">{n}</div>
      ))}

      {p.receipts.map((rc) => (
        <div key={rc.logIndex} className="card">
          <div className="grid grid-cols-5 divide-x divide-line">
            <Big
              label="Fee charged"
              value={pct(rc.feePips)}
              sub={
                rc.stale
                  ? `stale mid → conservative`
                  : rc.arbDir
                    ? thr > 0 && rc.gapPips <= thr
                      ? 'arb direction, below threshold → base'
                      : rc.kBps === 0
                        ? 'arb direction, k = 0 → base (model: no profitable arb / no trusted model)'
                        : 'regime fee (arb direction)'
                    : 'base fee (reverse direction)'
              }
              tone={rc.stale ? 'text-bad' : rc.arbDir && rc.feePips > cfg.baseFee ? 'text-warn' : ''}
            />
            <Big label="Gap vs CEX mid" value={gapBps(rc.gapPips)} sub="anchored at the block's first swap" />
            <Big label="Attested k" value={kFmt(rc.kBps)} sub={rc.modelName?.split('.')[0] ?? short(rc.modelNode)} />
            <Big label="Direction" value={rc.arbDir ? 'Arb' : 'Reverse'} sub={rc.zeroForOne ? `sell ${sym0}` : `buy ${sym0}`} />
            <Big label="Swapper markout" value={rc.markout == null ? '—' : money(rc.markout)} sub={`${p.pair.quote} at next attested mid`} tone={rc.markout != null && rc.markout > 0 ? 'text-bad' : ''} />
          </div>
          <div className="border-t border-line px-4 py-3">
            <div className="text-sm text-ink-2">
              Fee law check:{' '}
              {rc.stale ? (
                <>stale mid → conservativeFee {pct(cfg.conservativeFee)}</>
              ) : rc.arbDir ? (
                thr > 0 && rc.gapPips <= thr ? (
                  <>gap {gapBps(rc.gapPips)} ≤ arb threshold {gapBps(thr)} → base {pct(cfg.baseFee)} (no profitable arbitrage below the threshold)</>
                ) : thr > 0 ? (
                  <>min({pct(cfg.baseFee)} + {kFmt(rc.kBps)} × ({gapBps(rc.gapPips)} − {gapBps(thr)}), {pct(cfg.feeMax)}) = <b className="text-ink">{pct(Math.min(cfg.baseFee + Math.floor((Math.max(0, rc.gapPips - thr) * rc.kBps) / 10_000), cfg.feeMax))}</b></>
                ) : (
                  <>min({pct(cfg.baseFee)} + {kFmt(rc.kBps)} × {gapBps(rc.gapPips)}, {pct(cfg.feeMax)}) = <b className="text-ink">{pct(Math.min(cfg.baseFee + Math.floor((rc.gapPips * rc.kBps) / 10_000), cfg.feeMax))}</b>{rc.kBps === 0 ? ' (k = 0: the model saw no profitable arbitrage, or had no power yet)' : ''}</>
                )
              ) : (
                <>reverse direction → base {pct(cfg.baseFee)}</>
              )}
            </div>
            <Row k={`amount0 (${sym0})`} v={`${rc.amount0Human.toLocaleString('en-US', { maximumFractionDigits: 6 })}  (raw ${rc.amount0})`} />
            <Row k={`amount1 (${sym1})`} v={`${rc.amount1Human.toLocaleString('en-US', { maximumFractionDigits: 6 })}  (raw ${rc.amount1})`} />
            <Row k="sender (router)" v={rc.sender} mono />
            <Row k="stale flag" v={rc.stale ? 'true' : 'false'} />
            <Row k="model node" v={rc.modelNode} mono />
          </div>
        </div>
      ))}

      <div className="grid grid-cols-2 gap-4">
        {p.attestation && r && <Attestation a={p.attestation} p={p} title={`Attestation in force for block ${r.block}`} />}
        {p.postedInTx && <Attestation a={p.postedInTx} p={p} title="Attestation posted in this tx" />}

        {p.calibration && (
          <div className="card p-4">
            <h3 className="mb-2 font-semibold">Running calibration · {p.calibration.modelName ?? short(p.calibration.modelNode)}</h3>
            <div className="grid grid-cols-3 divide-x divide-line rounded-md border border-line">
              <Big label="Calibration score" value={brier(p.calibration.hook?.n ? p.calibration.hook.brierBps : null)} sub={`demote above ${brier(cfg.brierDemoteBps)}`} tone={p.calibration.demotedNow && !p.calibration.unseasoned ? 'text-bad' : ''} />
              <Big label="Hit rate" value={p.calibration.hook?.n ? bpsPct(p.calibration.hook.hitRateBps, 0) : '—'} />
              <Big label="n" value={p.calibration.hook?.n ?? 0} sub={p.calibration.unseasoned ? `unseasoned (n < ${p.calibration.minSamples}) → kDefault` : p.calibration.demotedNow ? 'DEMOTED → kDefault' : 'active'} tone={p.calibration.unseasoned ? 'text-warn' : p.calibration.demotedNow ? 'text-bad' : ''} />
            </div>
            <div className="mt-3 label">Source</div>
            <Row k="hook.calibration()" v={p.calibration.hook ? `updated block ${p.calibration.hook.updatedBlock}` : '—'} />
            <Row k="ENS name" v={p.calibration.modelName ?? '—'} />
            <Row k="namehash" v={p.calibration.ensNamehash ?? p.calibration.modelNode} mono />
            {p.calibration.ens ? (
              Object.entries(p.calibration.ens).map(([k, v]) => <Row key={k} k={`text ${k}`} v={v || <span className="text-muted">(empty)</span>} />)
            ) : (
              <Row k="ENS text records" v={<span className="text-muted">{p.chain.ens ? 'not resolvable' : 'no ENS on this chain (local anvil)'}</span>} />
            )}
            <div className="mt-3 label">CalibrationUpdated history</div>
            <div className="max-h-48 overflow-auto text-xs">
              {p.calibration.history.slice(-20).reverse().map((h) => (
                <div key={h.block} className="flex gap-4 border-t border-line py-1">
                  <span className="w-24 text-muted">block {h.block}</span>
                  <span>score {brier(h.brierBps)}</span>
                  <span>hit {bpsPct(h.hitRateBps, 0)}</span>
                  <span>n {h.n}</span>
                </div>
              ))}
              {p.calibration.history.length === 0 && <div className="text-muted">none yet</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
