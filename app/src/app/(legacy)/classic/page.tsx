'use client';
import Link from 'next/link';
import { DevPanel } from '@/components/DevPanel';
import { EnsNamespaceCard, PrimaryName } from '@/components/EnsNamespace';
import { JitPenaltyTable } from '@/components/JitPenalties';
import { LineChart } from '@/components/LineChart';
import { RegimeMap } from '@/components/RegimeMap';
import { gapBps, kFmt, money, pct, price, prob, short, signed } from '@/lib/format';
import { ATTACK_TYPES, attackLabel, type EnsNamespaceJson, type HistoryJson, type PoolTotals, type StateJson, type VerdictJson } from '@/lib/types';
import { usePoll } from '@/lib/usePoll';

function Stat({ label, value, sub, tone, title }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'good' | 'bad' | 'warn'; title?: string }) {
  const c = tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <div className="min-w-0 px-4 py-3" title={title}>
      <div className="label">{label}</div>
      <div className={`mt-0.5 truncate text-2xl font-semibold ${c}`}>{value}</div>
      {sub && <div className="truncate text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

function PoolPanel({
  title,
  accent,
  poolMid,
  cexMid,
  totals,
  feeLine,
  quote,
}: {
  title: string;
  accent: string;
  poolMid?: number;
  cexMid: number | null;
  totals?: PoolTotals;
  feeLine: React.ReactNode;
  quote: string;
}) {
  const gap = poolMid && cexMid ? ((poolMid - cexMid) / cexMid) * 10_000 : null;
  const lvh = totals?.lpMinusHodl ?? null;
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5" style={{ boxShadow: `inset 3px 0 0 ${accent}` }}>
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: accent }} />
        <h2 className="font-semibold">{title}</h2>
        <span className="ml-auto text-xs text-ink-2">{feeLine}</span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-line">
        <Stat label={`LP vs HODL (${quote})`} value={signed(lvh)} tone={lvh == null ? undefined : lvh >= 0 ? 'good' : 'bad'} sub="pool value + fees − held tokens" />
        <Stat label={`Pool price (${quote})`} value={price(poolMid)} sub={gap == null ? '—' : `${gap >= 0 ? '+' : ''}${gap.toFixed(1)} bps vs CEX mid`} />
      </div>
      <div className="grid grid-cols-3 divide-x divide-line border-t border-line">
        <Stat label="Fees earned" value={money(totals?.fees)} sub={quote} />
        <Stat label="Loss to arb" value={money(totals?.lossToArb)} sub="swapper markout > 0" />
        <Stat label="Swaps" value={totals?.swaps ?? '—'} sub={`vol ${money(totals?.volume, 0)}`} />
      </div>
    </div>
  );
}

export default function Home() {
  const st = usePoll<StateJson>('/api/state', 2000);
  const hi = usePoll<HistoryJson>('/api/history', 3000);
  const vd = usePoll<VerdictJson[]>('/api/verdicts?limit=1', 2000);
  // ENSv2 namespace (wildcard live.* records + ENSIP-19 primary names): slow-changing, 10 s is plenty.
  const en = usePoll<EnsNamespaceJson>('/api/ens', 10_000);
  const s = st.data;
  const h = hi.data;

  if (!s) {
    return (
      <div className="card p-6 text-ink-2">
        {st.error ? (
          <>
            <div className="font-semibold text-bad">Cannot reach the chain</div>
            <div className="mt-1 text-sm">{st.error}</div>
            <div className="mt-2 text-sm text-muted">Start everything with scripts/demo-local.sh (anvil + deploy + keeper + settler + bots + app).</div>
          </>
        ) : (
          'Loading chain state…'
        )}
      </div>
    );
  }

  const x = s.status;
  const cfg = s.config;
  const sellLbl = `sell ${s.pair.token0}`;
  const buyLbl = `buy ${s.pair.token0}`;
  const arbFee = x.arbZeroForOne === null ? null : x.arbZeroForOne ? x.feeZeroForOne : x.feeOneForZero;
  const modelLbl = x.modelName ?? short(x.modelNode);
  const quote = s.pair.quote;
  const thr = x.arbThresholdPips ?? 0;
  // v4: with k = 0 (the model said "no profitable arbitrage", or no trusted model) the arb direction pays exactly base.
  const kZero = x.kBps === 0;
  const feeSub = (f: typeof x.feeZeroForOne) =>
    f.stale
      ? 'stale mid'
      : f.arbDir
        ? f.gapPips <= thr
          ? 'below arb threshold → base fee'
          : kZero || f.feePips <= cfg.baseFee
            ? 'arb dir, k = 0 → base fee'
            : 'regime fee (arb dir)'
        : 'base fee';
  const feeTone = (f: typeof x.feeZeroForOne) => (f.arbDir && f.gapPips > thr && f.feePips > cfg.baseFee ? ('warn' as const) : undefined);
  const kSub = x.demoted
    ? `model demoted → kDefault ${kFmt(cfg.kDefaultBps)}${cfg.kDefaultBps === 0 ? ' (base fee)' : ''}`
    : x.unseasoned
      ? `unseasoned → kDefault ${kFmt(cfg.kDefaultBps)}${cfg.kDefaultBps === 0 ? ' (base fee)' : ''}`
      : kZero
        ? 'model: no profitable arb → base fee'
        : `range ${kFmt(cfg.kMinBps)}–${kFmt(cfg.kMaxBps)}`;
  const mix = x.attestMix;
  const mixPct = (n: number) => (mix && mix.total ? `${Math.round((100 * n) / mix.total)}%` : '—');
  // v5 second knob: the JIT penalty window the model sets alongside k (jitWindowDefault while demoted / unseasoned / stale).
  const j = x.jit;
  const jitDef = cfg.jitWindowDefault ?? '—';
  const jitRange = `${cfg.jitWindowMin ?? '—'}–${cfg.jitWindowMax ?? '—'}`;
  const jitSub = !j.supported
    ? 'pre-v5 hook: fixed wall'
    : x.stale
      ? `stale mid → default ${jitDef} blk`
      : j.demoted
        ? `p_jit ${prob(j.pJitBps)} · JIT head demoted → default ${jitDef}`
        : j.unseasoned
          ? `p_jit ${prob(j.pJitBps)} · unseasoned → default ${jitDef}`
          : `p_jit ${prob(j.pJitBps)} · range ${jitRange} blk`;

  // v6: the model's one malicious score + the attack type that allocated it onto k / the JIT window (keeper verdicts file).
  const v = vd.data?.[0] ?? null;
  const vTop = v?.attack && v.attackProbs ? v.attackProbs[v.attack] : null;
  const vTitle = v
    ? [
        `block ${v.block} → attested ${v.target} · ${v.model}${v.k != null ? ` · k ${kFmt(v.k)}` : ''}${v.jitWindow != null ? ` · JIT window ${v.jitWindow} blk` : ''}`,
        `p_toxic ${prob(v.pToxicBps)} · p_jit ${prob(v.pJitBps)}`,
        ...(v.attackProbs ? ['type distribution:', ...ATTACK_TYPES.map((t) => `  ${attackLabel(t)}: ${v.attackProbs![t].toFixed(2)}`)] : ['no v6 attack head for this model']),
      ].join('\n')
    : 'no verdict yet: the keeper writes .runtime/verdicts.<chainId>.jsonl once it posts (v6 prompt)';

  const pts = h?.points ?? [];
  const series = [
    ...(pts.some((p) => p.van) ? [{ name: 'Vanilla v4', color: 'var(--vanilla)', values: pts.filter((p) => p.van).map((p) => ({ x: p.block, y: p.van!.lp - p.van!.hodl })) }] : []),
    { name: 'Oniblock', color: 'var(--oni)', values: pts.map((p) => ({ x: p.block, y: p.oni.lp - p.oni.hodl })) },
  ];

  return (
    <div className="space-y-4">
      {(st.error || hi.error) && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{st.error ?? hi.error}</div>}

      {/* Status strip */}
      <div className="card grid grid-cols-10 divide-x divide-line">
        <Stat label="Last block" value={s.chain.block} sub={`${s.chain.name} · chain ${s.chain.chainId}`} />
        <Stat label={`CEX mid (attested)`} value={price(x.oracleMid)} sub={quote} />
        <Stat label="p_toxic" value={prob(x.pToxicBps)} sub={`confidence ${prob(x.confidenceBps)}`} />
        <Stat
          label="Attested k"
          value={kFmt(x.kBps)}
          sub={kSub}
          tone={x.demoted ? 'bad' : x.unseasoned && cfg.kDefaultBps !== 0 ? 'warn' : undefined}
        />
        <Stat
          label="JIT window"
          value={j.jitWindowEffective == null ? '—' : `${j.jitWindowEffective} blk`}
          sub={jitSub}
          tone={!j.supported ? undefined : j.demoted ? 'bad' : j.unseasoned || x.stale ? 'warn' : undefined}
        />
        <Stat
          label="Model verdict"
          value={v && v.pMalicious != null ? `malicious ${v.pMalicious.toFixed(2)}` : '—'}
          sub={v ? (v.attack ? `most likely: ${attackLabel(v.attack)}${vTop != null ? ` (${vTop.toFixed(2)})` : ''}` : `${v.model}: no attack head`) : 'no verdict yet'}
          tone={v && v.pMalicious != null && v.pMalicious >= 0.5 ? 'warn' : undefined}
          title={vTitle}
        />
        <Stat label={`Fee · ${sellLbl}`} value={pct(x.feeZeroForOne.feePips)} sub={feeSub(x.feeZeroForOne)} tone={feeTone(x.feeZeroForOne)} />
        <Stat label={`Fee · ${buyLbl}`} value={pct(x.feeOneForZero.feePips)} sub={feeSub(x.feeOneForZero)} tone={feeTone(x.feeOneForZero)} />
        <Stat
          label="Attestation age"
          value={x.attestAge == null ? '—' : `${x.attestAge} blk`}
          sub={x.stale ? `STALE (> ${cfg.staleBlocks}) → ${pct(cfg.conservativeFee)}` : `stale after ${cfg.staleBlocks}`}
          tone={x.stale ? 'bad' : 'good'}
        />
        <Stat
          label="Model node"
          value={<span className="text-base">{modelLbl.split('.')[0]}</span>}
          sub={
            <>
              {x.demoted ? <span className="text-bad">demoted</span> : <span className="text-good">not demoted</span>}
              {' · '}
              {x.calibration && x.calibration.n > 0 ? `score ${(x.calibration.brierBps / 10_000).toFixed(3)} (n=${x.calibration.n})` : 'no calibration yet'}
            </>
          }
        />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-xs text-ink-2">
        {j.supported ? (
          <span>
            Model decides two knobs every block: <b className="text-ink">k = {kFmt(x.kBps)}</b> (kMax · p_toxic {prob(x.pToxicBps)} · confidence {prob(x.confidenceBps)}) and{' '}
            <b className="text-ink">JIT window = {j.jitWindow == null ? '—' : `${j.jitWindow} blocks`}</b> ({cfg.jitWindowMin ?? '—'} + ({cfg.jitWindowMax ?? '—'} − {cfg.jitWindowMin ?? '—'}) · p_jit {prob(j.pJitBps)} · confidence): liquidity removed within that many blocks of being added forfeits its fees to standing LPs. Demoted or unseasoned JIT head, or a stale mid → default {jitDef} blocks.
          </span>
        ) : null}
        {x.belowThreshold ? (
          <span className="text-good">
            Below arb threshold: gap {gapBps(x.gapPips)} ≤ {gapBps(thr)} → base fee {pct(cfg.baseFee)} both ways (same as a vanilla pool{mix && mix.rule > 0 ? '; keeper posts rule-v1, no model call' : ''}).
          </span>
        ) : null}
        {!x.stale && kZero ? (
          <span className="text-good">
            k = 0 → base fee {pct(cfg.baseFee)} both ways (same as a vanilla pool): {x.demoted || x.unseasoned ? 'no trusted model (kDefault = 0)' : 'the model sees no profitable arbitrage'}.
          </span>
        ) : null}
        <span>
          {thr > 0 ? (
            <>
              Fee law: arb direction pays <b className="text-ink">min(base + k·max(0, gap − threshold), feeMax)</b> = {pct(cfg.baseFee)} + {kFmt(x.kBps)} × max(0, {gapBps(x.gapPips)} − {gapBps(thr)})
              {arbFee ? ` = ${pct(arbFee.feePips)}` : ''}; the other direction pays base {pct(cfg.baseFee)}; arb threshold {gapBps(thr)}; cap {pct(cfg.feeMax)}.
            </>
          ) : (
            <>
              Fee law: arb direction pays <b className="text-ink">min(base + k·gap, feeMax)</b> = {pct(cfg.baseFee)} + {kFmt(x.kBps)} × {gapBps(x.gapPips)}
              {arbFee ? ` = ${pct(arbFee.feePips)}` : ''}; the other direction pays base {pct(cfg.baseFee)}; no gap threshold — the model decides k every block (k = kMax·p·c); cap {pct(cfg.feeMax)}.
            </>
          )}
        </span>
        {mix ? (
          <span>
            Keeper model calls: <b className="text-ink">{mixPct(mix.jev + mix.heuristic + mix.oniblock1 + mix.kev)}</b> of the last {mix.total} attestations ({mix.oniblock1 > 0 ? `oniblock1 ${mixPct(mix.oniblock1)}, ` : ''}{mix.kev > 0 ? `kev-v1 ${mixPct(mix.kev)}, ` : ''}Jev {mixPct(mix.jev)}, heuristic {mixPct(mix.heuristic)}{mix.rule > 0 ? `, rule-v1 ${mixPct(mix.rule)}` : ''}; last {mix.window} blocks)
          </span>
        ) : null}
        <span>
          Quoter <PrimaryName name={s.roles.quoterName} address={s.roles.quoter} className="text-ink" />{' '}
          {s.roles.quoterActive ? <span className="text-good">active</span> : <span className="text-bad">revoked</span>}
          {s.roles.backupActive ? <span className="text-good"> · backup active</span> : null}
          {x.lastQuoter ? (
            <>
              {' '}
              · last post by <PrimaryName name={x.lastQuoterName} address={x.lastQuoter} className="text-ink" />
            </>
          ) : null}
        </span>
        <span>
          Settler <PrimaryName name={s.roles.settlerName} address={s.roles.settler} className="text-ink" />{' '}
          {s.roles.settlerActive == null ? null : s.roles.settlerActive ? <span className="text-good">active</span> : <span className="text-bad">revoked</span>}
          {s.roles.quoterName || s.roles.settlerName ? <span className="text-muted"> · primary names via UR.reverse (ENSIP-19)</span> : null}
        </span>
        {s.flags.degraded && <span className="text-bad">Keeper in degraded-model mode</span>}
      </div>

      {/* Split screen */}
      <div className="grid grid-cols-2 gap-4">
        <PoolPanel
          title={`Vanilla v4 (${pct(s.pools.vanilla?.staticFee ?? null)})`}
          accent="var(--vanilla)"
          poolMid={s.pools.vanilla?.poolMid}
          cexMid={x.oracleMid}
          totals={h?.totals.van}
          feeLine={`static fee ${pct(s.pools.vanilla?.staticFee ?? null)} both directions`}
          quote={quote}
        />
        <PoolPanel
          title="Oniblock"
          accent="var(--oni)"
          poolMid={s.pools.oniblock.poolMid}
          cexMid={x.oracleMid}
          totals={h?.totals.oni}
          feeLine={`regime fee ${arbFee ? pct(arbFee.feePips) : pct(cfg.baseFee)} arb dir · ${pct(cfg.baseFee)} other`}
          quote={quote}
        />
      </div>

      <div className="card p-4">
        <div className="mb-1 flex items-baseline gap-3">
          <h3 className="font-semibold">LP value minus HODL ({quote})</h3>
          <span className="text-xs text-muted">
            same liquidity, same bots, same CEX mid · since block {h?.baselineBlock ?? '—'} · valued at the attested CEX mid
          </span>
        </div>
        <LineChart series={series} height={230} yFormat={(v) => money(v, Math.abs(v) < 100 ? 2 : 0)} xFormat={(v) => `#${v}`} />
      </div>

      <div className="card p-4">
        <div className="mb-3 flex items-baseline gap-3">
          <h3 className="font-semibold">Regime map</h3>
          <span className="text-xs text-muted">one cell per block, colored by the attested k in force (a block regime — never a per-transaction score)</span>
        </div>
        {h ? <RegimeMap cells={h.regime} cfg={cfg} /> : <div className="text-sm text-muted">Loading…</div>}
      </div>

      <EnsNamespaceCard data={en.data} error={en.error} />

      <div className="grid grid-cols-[1fr_minmax(420px,0.8fr)] gap-4">
        <div className="space-y-4">
        <div className="card p-4">
          <h3 className="mb-2 font-semibold">Latest Oniblock receipts</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-normal">block</th>
                <th className="font-normal">direction</th>
                <th className="font-normal">gap</th>
                <th className="font-normal">k</th>
                <th className="font-normal">fee</th>
                <th className="font-normal">tx</th>
              </tr>
            </thead>
            <tbody>
              {(h?.receipts ?? []).map((r) => (
                <tr key={r.tx + r.block + r.zeroForOne} className="border-t border-line">
                  <td className="py-1.5">{r.block}</td>
                  <td>
                    {r.stale ? <span className="text-bad">stale mid</span> : r.arbDir ? <span className="text-warn">arb dir</span> : <span className="text-ink-2">reverse</span>}
                    <span className="text-muted"> · {r.zeroForOne ? sellLbl : buyLbl}</span>
                  </td>
                  <td>{gapBps(r.gapPips)}</td>
                  <td>{kFmt(r.kBps)}</td>
                  <td className="font-medium">{pct(r.feePips)}</td>
                  <td>
                    <Link className="mono text-oni underline" href={`/receipt/${r.tx}`}>
                      {short(r.tx, 4)}
                    </Link>
                  </td>
                </tr>
              ))}
              {h && h.receipts.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 text-muted">
                    No swaps on the Oniblock pool yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <JitPenaltyTable rows={h?.jitPenalties ?? []} totals={h?.jitTotals} quote={quote} token0={s.pair.token0} token1={s.pair.token1} loaded={!!h} />
        </div>
        {s.chain.isDev ? <DevPanel s={s} onDone={() => { st.reload(); hi.reload(); }} /> : <div className="card p-4 text-sm text-muted">Dev controls are available only on local anvil or an anvil fork.</div>}
      </div>
    </div>
  );
}
