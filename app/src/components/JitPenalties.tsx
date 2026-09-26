'use client';
import Link from 'next/link';
import { money, short } from '@/lib/format';
import { LEGACY_JIT_WALL, type JitPenaltyJson } from '@/lib/types';

/**
 * JitPenalty events (v5): liquidity removed inside the window in force when it was added forfeited its fees to
 * standing LPs. A position held for >= LEGACY_JIT_WALL blocks would have escaped the fixed 10-block wall: only the
 * model-set adaptive window caught it.
 */
export function JitPenaltyTable({
  rows,
  totals,
  quote,
  token0,
  token1,
  loaded,
}: {
  rows: JitPenaltyJson[];
  totals?: { count: number; caughtByAdaptiveWindow: number; penaltyQuote: number };
  quote: string;
  token0: string;
  token1: string;
  loaded: boolean;
}) {
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="font-semibold">JIT penalties</h3>
        <span className="text-xs text-muted">
          liquidity removed inside its window forfeits its fees to standing LPs
          {totals && totals.count > 0 ? (
            <>
              {' '}
              · {totals.count} penalt{totals.count === 1 ? 'y' : 'ies'} · <span className="text-good">{totals.caughtByAdaptiveWindow} caught only by the adaptive window</span> · {money(totals.penaltyQuote)} {quote} donated
            </>
          ) : null}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 font-normal">removed</th>
            <th className="font-normal">added</th>
            <th className="font-normal">held</th>
            <th className="font-normal">window</th>
            <th className="font-normal">penalty</th>
            <th className="font-normal">outcome</th>
            <th className="font-normal">sender</th>
            <th className="font-normal">tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((j) => (
            <tr key={j.tx + j.positionKey + j.addedBlock} className="border-t border-line align-top">
              <td className="py-1.5">{j.block}</td>
              <td className="py-1.5">{j.addedBlock}</td>
              <td className="py-1.5">{j.held} blk</td>
              <td className="py-1.5">{j.window} blk</td>
              <td className="py-1.5">
                <div className="font-medium">{j.penaltyQuote == null ? '—' : `${money(j.penaltyQuote)} ${quote}`}</div>
                <div className="text-xs text-muted">
                  {j.penalty0Human.toLocaleString('en-US', { maximumFractionDigits: 6 })} {token0} + {j.penalty1Human.toLocaleString('en-US', { maximumFractionDigits: 6 })} {token1}
                </div>
              </td>
              <td className="py-1.5">
                {j.caughtByAdaptiveWindow ? (
                  <>
                    <span className="rounded bg-good/15 px-2 py-0.5 text-xs text-good">caught by adaptive window</span>
                    <div className="mt-0.5 text-xs text-muted">would have escaped a {LEGACY_JIT_WALL}-block wall</div>
                  </>
                ) : (
                  <>
                    <span className="rounded bg-surface-2 px-2 py-0.5 text-xs text-ink-2">caught</span>
                    <div className="mt-0.5 text-xs text-muted">inside a {LEGACY_JIT_WALL}-block wall too</div>
                  </>
                )}
              </td>
              <td className="mono py-1.5 text-xs">{short(j.sender, 4)}</td>
              <td className="py-1.5">
                <Link className="mono text-oni underline" href={`/receipt/${j.tx}`}>
                  {short(j.tx, 4)}
                </Link>
              </td>
            </tr>
          ))}
          {loaded && rows.length === 0 && (
            <tr>
              <td colSpan={8} className="py-3 text-muted">
                No JIT penalty yet: nobody removed liquidity inside its window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
