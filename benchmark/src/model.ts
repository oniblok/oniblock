/**
 * Model scoring for pools 4/5 with a bounded Jev budget.
 *
 *  - Features are computed exactly as the keeper does (services/src/features.ts), then QUANTIZED into coarse
 *    buckets before being rendered into Jev's natural-language state, so repeated regimes hit the on-disk cache
 *    (data/jev-cache.json, keyed by the exact state text).
 *  - Cache miss: call Jev (/v1/evaluate) only while the paced budget allows (calls <= budget * progress), so the
 *    budget is spread over the whole window instead of exhausted in the first minutes. When paced out, reuse the
 *    closest cached Jev answer on the same side of the mid (gap within 5 bps; the gap dominates Jev's answer, see
 *    docs/JEV_NOTES.md); otherwise, or on any Jev failure, fall back to the deterministic heuristic.
 *    The source of every score is recorded.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { featuresToState, type Features } from '../../services/src/features.js';
import { JevCache, scoreHeuristic, scoreWithJev, degrade, type ModelScore } from '../../services/src/model/index.js';
import { DATA_DIR } from './util.js';

export type Source = 'jev' | 'jev-cache' | 'jev-nearest' | 'heuristic' | 'heuristic-paced' | 'heuristic-jev-failed';

const bucket = (x: number, step: number) => Math.round(x / step) * step;

export function quantize(f: Features): Features {
  const g = f.gapPips;
  const gapQ = g < 1000 ? bucket(g, 250) : g < 5000 ? bucket(g, 500) : g < 15000 ? bucket(g, 2500) : bucket(g, 5000);
  // Fee-aware state: re-derive the regime fee from the quantized gap and k so the text (cache key) is stable.
  // feeMax is not a Features field; it is recovered from a capped arbFeePips (else treated as no cap).
  let feeQ: Partial<Features> = {};
  if (f.kBps !== undefined && f.arbFeePips !== undefined) {
    const kQ = bucket(f.kBps, 500);
    // v3 threshold law: only the gap above arbThresholdPips is priced (undefined/0 = v1/v2 law, keys unchanged)
    const thr = (f as Features & { arbThresholdPips?: number }).arbThresholdPips ?? 0;
    const ex = (g: number) => Math.max(0, g - thr);
    const uncapped = f.baseFee + Math.floor((ex(f.gapPips) * f.kBps) / 10_000);
    const feeMax = f.arbFeePips < uncapped ? f.arbFeePips : Number.MAX_SAFE_INTEGER;
    feeQ = { kBps: kQ, arbFeePips: Math.min(f.baseFee + Math.floor((ex(gapQ) * kQ) / 10_000), feeMax) };
  }
  return {
    ...f,
    ...feeQ,
    gapPips: gapQ,
    gapSign: gapQ === 0 ? 0 : f.gapSign,
    imbalance: bucket(f.imbalance, 0.5),
    sizeToDepth: f.sizeToDepth < 1e-5 ? 0 : f.sizeToDepth < 1e-4 ? 5e-5 : f.sizeToDepth < 1e-3 ? 5e-4 : 2e-3,
    realizedVolBps: f.realizedVolBps < 1 ? bucket(f.realizedVolBps, 0.5) : f.realizedVolBps < 5 ? bucket(f.realizedVolBps, 1) : bucket(f.realizedVolBps, 5),
    nSwaps: f.nSwaps === 0 ? 0 : f.nSwaps <= 3 ? 2 : f.nSwaps <= 8 ? 5 : 10,
    arbShare: bucket(f.arbShare, 0.5),
    attestationAge: Math.min(f.attestationAge, 2),
  };
}

/** Nearest-neighbour reuse only within the same state wording (base-fee vs fee-aware) and the same k bucket. */
function stateFormat(state: string): string {
  const m = /k = ([\d.]+)\)/.exec(state);
  return m ? `fee-aware:k=${m[1]}` : 'base-fee';
}

export class Scorer {
  readonly cache: JevCache;
  calls = 0;
  failures = 0;
  latencies: number[] = [];
  counts: Record<Source, number> = { jev: 0, 'jev-cache': 0, 'jev-nearest': 0, heuristic: 0, 'heuristic-paced': 0, 'heuristic-jev-failed': 0 };

  constructor(
    readonly mode: 'jev' | 'heuristic',
    readonly budget: number,
    readonly totalSteps: number,
    readonly baseIsToken0: boolean,
    cacheFile = resolve(DATA_DIR, 'jev-cache.json'),
  ) {
    this.cache = new JevCache(cacheFile);
    this.cacheFile = cacheFile;
    this.indexCache();
  }

  private readonly cacheFile: string;
  /** (side, gap pips) -> Jev score, parsed back out of the cached state texts. */
  private nearest: { side: string; pips: number; fmt: string; s: ModelScore }[] = [];
  private indexCache() {
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Record<string, ModelScore>;
      for (const [k, v] of Object.entries(raw)) this.addNearest(k, v);
    } catch {
      /* no cache yet */
    }
  }
  private addNearest(state: string, s: ModelScore) {
    const m = /pool price is (above|below|equal to) the Binance mid by [\d.]+% \((\d+) pips\)/.exec(state);
    if (m && s.model === 'jev') this.nearest.push({ side: m[1]!, pips: Number(m[2]), fmt: stateFormat(state), s });
  }
  /** Closest cached Jev answer on the same side of the mid (gap within 5 bps), used when the budget is paced out. */
  private lookupNearest(f: Features): ModelScore | null {
    const q = quantize(f);
    const side = q.gapSign > 0 ? 'above' : q.gapSign < 0 ? 'below' : 'equal to';
    const fmt = stateFormat(featuresToState(q, { baseIsToken0: this.baseIsToken0 }));
    let best: { d: number; s: ModelScore } | null = null;
    for (const e of this.nearest) {
      if (e.side !== side || e.fmt !== fmt) continue;
      const d = Math.abs(e.pips - q.gapPips);
      if (d <= 500 && (!best || d < best.d)) best = { d, s: e.s };
    }
    return best?.s ?? null;
  }

  async score(f: Features, step: number, degraded: boolean): Promise<{ s: ModelScore; source: Source }> {
    let s: ModelScore | null = null;
    let source: Source = 'heuristic';
    if (this.mode === 'jev') {
      const state = featuresToState(quantize(f), { baseIsToken0: this.baseIsToken0 });
      const hit = this.cache.get(state);
      if (hit) {
        s = hit;
        source = 'jev-cache';
      } else if (this.calls < Math.max(20, (this.budget * (step + 1)) / this.totalSteps) && this.calls < this.budget) {
        this.calls++;
        const t0 = performance.now();
        s = await scoreWithJev(state, { cache: this.cache, timeoutMs: 4000 });
        if (s) {
          source = 'jev';
          this.addNearest(state, s);
          this.latencies.push(performance.now() - t0);
        } else {
          this.failures++;
          source = 'heuristic-jev-failed';
        }
      } else {
        s = this.lookupNearest(f);
        source = s ? 'jev-nearest' : 'heuristic-paced';
      }
    }
    if (!s) s = scoreHeuristic(f);
    this.counts[source]++;
    return { s: degraded ? degrade(s) : s, source };
  }

  save() {
    this.cache.save();
  }
}
