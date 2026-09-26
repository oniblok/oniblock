'use client';
import { EnsNamespaceCard, PrimaryName } from '@/components/EnsNamespace';
import { LineChart } from '@/components/LineChart';
import { bpsPct, brier, short } from '@/lib/format';
import type { ModelsPage } from '@/lib/server/models';
import type { EnsNamespaceJson } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';

export default function Models() {
  const { data, error } = usePoll<ModelsPage>('/api/models', 4000);
  const en = usePoll<EnsNamespaceJson>('/api/ens', 10_000);
  if (!data) return <div className="card p-6 text-ink-2">{error ? <span className="text-bad">{error}</span> : 'Loading models…'}</div>;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Model nodes</h1>
        <span className="text-sm text-ink-2">
          Scored by the settler against next-block markouts. Score = 0.25 × Brier ÷ Brier of the base-rate predictor (0.25 = no better than always guessing the base rate; raw Brier and skill are in the ENS records). Score above {brier(data.brierDemoteBps)} → k forced to kDefault on-chain, no admin step. New models start on probation until n ≥ {data.minSamples}.
          {data.jitHead ? (
            <>
              {' '}
              Each model also has a <b className="text-ink">JIT head</b>: its second prediction sets the penalty window for new liquidity ({data.jitWindow.min ?? '—'}–{data.jitWindow.max ?? '—'} blocks), scored under its own key (calibration.jit.*) and demoted on its own → default {data.jitWindow.default ?? '—'} blocks.
            </>
          ) : null}
        </span>
        <span className="ml-auto text-xs text-muted">
          block {data.head} · {data.chain.ens ? `ENS: ${data.chain.ensName}` : 'no ENS on this chain — labels from deployments'}
        </span>
      </div>
      {en.data && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-xs text-ink-2">
          {en.data.primary.map((p) => (
            <span key={p.role}>
              {p.role === 'quoter' ? 'Quoter (posts attestations)' : 'Settler (scores models, writes calibration.*)'}:{' '}
              <PrimaryName name={p.name} address={p.address} className="text-ink" />
              {p.name ? <span className="mono text-muted"> {short(p.address)}</span> : null}
              {p.matches === false ? <span className="text-bad"> · addr({p.expected}) ≠ key</span> : null}
            </span>
          ))}
          <span className="text-muted">primary names via UniversalResolverV2.reverse (ENSIP-19); raw address when none is set</span>
        </div>
      )}
      {data.models.length === 0 && <div className="card p-6 text-muted">No model has attested yet.</div>}
      {data.models.map((m) => {
        const current = data.currentModelNode === m.modelNode.toLowerCase();
        return (
          <div key={m.modelNode} className="card overflow-hidden">
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <h2 className="font-semibold">{m.name ?? short(m.modelNode)}</h2>
              {current && <span className="rounded bg-oni/20 px-2 py-0.5 text-xs text-oni">in force</span>}
              {m.demoted ? (
                <span className="rounded bg-bad/15 px-2 py-0.5 text-xs text-bad">demoted</span>
              ) : m.unseasoned ? (
                <span className="rounded bg-warn/15 px-2 py-0.5 text-xs text-warn">unseasoned (n &lt; {data.minSamples}) → kDefault</span>
              ) : (
                <span className="rounded bg-good/15 px-2 py-0.5 text-xs text-good">active</span>
              )}
              {m.allowed === false && <span className="rounded bg-bad/15 px-2 py-0.5 text-xs text-bad">not allowlisted</span>}
              <span className="mono ml-auto text-xs text-muted">{m.modelNode}</span>
            </div>
            <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_2fr] divide-x divide-line">
              <Cell label="Calibration score" value={brier(m.brierBps)} tone={m.demoted ? 'text-bad' : ''} />
              <Cell label="Hit rate" value={bpsPct(m.hitRateBps, 0)} />
              <Cell label="n (scored blocks)" value={m.n} />
              <Cell label="Attestations" value={m.attestations} sub={m.lastAttestBlock ? `last in block ${m.lastAttestBlock}` : undefined} />
              <Cell label="Updated" value={m.updatedBlock ?? '—'} sub="block" />
              <div className="px-4 py-3 text-xs">
                <div className="label mb-1">ENS text records</div>
                {m.ens ? (
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    {Object.entries(m.ens).map(([k, v]) => (
                      <div key={k} className="contents">
                        <span className="text-muted">{k}</span>
                        <span className="truncate">{v || <span className="text-muted">(empty)</span>}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted">{data.chain.ens ? 'unresolvable' : 'no ENS on local anvil; on a fork/Sepolia these come from UniversalResolverV2'}</span>
                )}
              </div>
            </div>
            {m.jit && (
              <div className="border-t border-line">
                <div className="flex items-center gap-3 px-4 pt-2.5">
                  <span className="label">JIT head</span>
                  <span className="text-xs text-ink-2">second knob: window = min + (max − min) · p_jit · confidence, {data.jitWindow.min ?? '—'}–{data.jitWindow.max ?? '—'} blocks</span>
                  {m.jit.demoted ? (
                    <span className="rounded bg-bad/15 px-2 py-0.5 text-xs text-bad">demoted → default {data.jitWindow.default ?? '—'} blk</span>
                  ) : m.jit.unseasoned ? (
                    <span className="rounded bg-warn/15 px-2 py-0.5 text-xs text-warn">unseasoned (n &lt; {data.minSamples}) → default {data.jitWindow.default ?? '—'} blk</span>
                  ) : (
                    <span className="rounded bg-good/15 px-2 py-0.5 text-xs text-good">active</span>
                  )}
                  <span className="mono ml-auto text-xs text-muted" title="jitCalibrationKey(modelNode) = keccak256(modelNode ‖ keccak256(&quot;jit&quot;))">
                    key {short(m.jit.calibrationKey, 8)}
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_2fr] divide-x divide-line">
                  <Cell label="JIT score" value={brier(m.jit.brierBps)} tone={m.jit.demoted ? 'text-bad' : ''} />
                  <Cell label="Hit rate" value={bpsPct(m.jit.hitRateBps, 0)} />
                  <Cell label="n (scored blocks)" value={m.jit.n} sub={m.jit.unseasoned ? `unseasoned until n ≥ ${data.minSamples}` : undefined} />
                  <Cell label="Window in force" value={current && data.jitWindow.now != null ? `${data.jitWindow.now} blk` : '—'} sub={current ? 'poolState.jitWindow' : 'not the model in force'} />
                  <Cell label="Updated" value={m.jit.updatedBlock ?? '—'} sub="block" />
                  <div className="px-4 py-3 text-xs">
                    <div className="label mb-1">ENS text records (calibration.jit.*)</div>
                    {m.jit.ens ? (
                      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                        {Object.entries(m.jit.ens).map(([k, v]) => (
                          <div key={k} className="contents">
                            <span className="text-muted">{k}</span>
                            <span className="truncate">{v || <span className="text-muted">(empty)</span>}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted">{data.chain.ens ? 'unresolvable' : 'no ENS on local anvil; on a fork/Sepolia these come from UniversalResolverV2'}</span>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="border-t border-line p-4">
              <div className="label mb-1">Calibration score over time (CalibrationUpdated{m.jit?.history.length ? ' · arb head and JIT head' : ''})</div>
              <LineChart
                series={[
                  { name: 'Score', color: 'var(--oni)', values: m.history.map((h) => ({ x: h.block, y: h.brierBps / 10_000 })) },
                  ...(m.jit?.history.length ? [{ name: 'JIT head', color: 'var(--vanilla)', values: m.jit.history.map((h) => ({ x: h.block, y: h.brierBps / 10_000 })) }] : []),
                ]}
                height={160}
                zeroLine={false}
                refLine={{ y: data.brierDemoteBps / 10_000, label: 'demote' }}
                yFormat={(v) => v.toFixed(3)}
                xFormat={(v) => `#${v}`}
              />
            </div>
          </div>
        );
      })}
      <EnsNamespaceCard data={en.data} error={en.error} title="ENS namespace (live records)" />
    </div>
  );
}

function Cell({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="label">{label}</div>
      <div className={`text-2xl font-semibold ${tone ?? ''}`}>{value}</div>
      {sub && <div className="text-xs text-ink-2">{sub}</div>}
    </div>
  );
}
