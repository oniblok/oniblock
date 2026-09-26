'use client';
import { short } from '@/lib/format';
import type { EnsLiveName, EnsNamespaceJson, EnsPrimary } from '@/lib/types';

/** ENSIP-19 primary name of a service key, falling back to the raw address. */
export function PrimaryName({ name, address, className }: { name?: string | null; address?: string | null; className?: string }) {
  if (name) {
    return (
      <span className={className} title={address ?? undefined}>
        {name}
      </span>
    );
  }
  return <span className={`mono ${className ?? ''}`}>{short(address)}</span>;
}

const KIND: Record<EnsLiveName['kind'], string> = { model: 'model', current: 'alias of the model in force', pool: 'pool' };

function Records({ n }: { n: EnsLiveName }) {
  if (!n.records) return <div className="text-muted">—</div>;
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {n.keys.map((k) => {
        const v = n.records![k];
        return (
          <div key={k} className="contents">
            <span className="text-muted">{k}</span>
            <span className="truncate" title={v || undefined}>
              {v ? v : <span className="text-muted">—</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Primary({ p }: { p: EnsPrimary }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-muted">{p.role}</span>
      <PrimaryName name={p.name} address={p.address} className="font-medium" />
      {p.name && p.address ? <span className="mono text-muted">{short(p.address)}</span> : null}
      {p.name ? (
        <span className="text-good">primary name (ENSIP-19)</span>
      ) : (
        <span className="text-muted">no primary name yet{p.address ? ` — pnpm -C services ens:primary sets ${p.expected}` : ''}</span>
      )}
      {p.matches === false && (
        <span className="text-bad">
          addr({p.expected}) = {short(p.forward)} ≠ this key
        </span>
      )}
    </div>
  );
}

/**
 * ENS namespace card: the ENSIP-10 wildcard names under live.<root> (raw records straight from UniversalResolverV2)
 * and the ENSIP-19 primary names of the quoter and settler. Renders "—" wherever resolution fails (e.g. the live
 * resolver is not deployed on this chain, or the chain has no ENS at all).
 */
export function EnsNamespaceCard({ data, error, title = 'ENS namespace' }: { data: EnsNamespaceJson | null; error?: string | null; title?: string }) {
  if (!data) {
    return <div className="card p-4 text-sm text-muted">{error ? `ENS namespace: ${error}` : 'Loading ENS namespace…'}</div>;
  }
  const ch = data.chain;
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <h3 className="font-semibold">{title}</h3>
        <span className="text-xs text-ink-2">
          <span className="mono">live.{data.root}</span> · ENSIP-10 wildcard resolver{' '}
          {ch.liveResolver && !/^0x0{40}$/i.test(ch.liveResolver) ? <span className="mono">{short(ch.liveResolver)}</span> : <span className="text-muted">not deployed on this chain</span>}
          {ch.universalResolver ? (
            <>
              {' '}
              · read through UniversalResolverV2 <span className="mono">{short(ch.universalResolver)}</span>
            </>
          ) : (
            ' · no ENS on this chain'
          )}
        </span>
        <span className="ml-auto text-xs text-muted">{ch.ens ? `ENS: ${ch.ensName}` : 'no ENS on local anvil'}</span>
      </div>
      <div className="px-4 py-2 text-xs text-ink-2">
        These subnames are not registered; the parent&apos;s resolver answers (ENSIP-10 wildcard). Every value below is the raw text record the
        resolver computes from hook state at the block of the read; nothing is stored under these names.
      </div>
      <div className="grid grid-cols-5 divide-x divide-line border-t border-line text-xs">
        {data.live.map((n) => (
          <div key={n.name} className="min-w-0 px-4 py-3">
            <div className="mb-1 truncate font-medium" title={n.name}>
              {n.name}
            </div>
            <div className="label mb-1.5">{KIND[n.kind]}</div>
            <Records n={n} />
          </div>
        ))}
      </div>
      <div className="space-y-1 border-t border-line px-4 py-3 text-xs">
        <div className="label">Primary names (ENSIP-19 · UR.reverse(addr, {data.coinType}) · forward-verified)</div>
        {data.primary.map((p) => (
          <Primary key={p.role} p={p} />
        ))}
      </div>
    </div>
  );
}
