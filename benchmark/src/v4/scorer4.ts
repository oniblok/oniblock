/**
 * v4 model scorer ("the AI decides the fee"): Jev is asked EVERY step with the v4 question + k-free v4 state
 * (services/src/model/jev.ts JEV_QUESTIONS_V4, services/src/features.ts format 'v4'). Policy as v2/v3:
 * quantized state -> on-disk Jev cache (v4 keys are namespaced by the prompt, so v1-v3 answers are never reused) ->
 * paced live Jev call (hard-capped budget per run; a failed call is retried once, then the heuristic is used and
 * COUNTED as fallback; after 4 consecutive failures live calls pause for 100 steps — the network here is slow and
 * flaky) -> nearest cached v4 Jev answer (same side of the mid, same base fee, same sign of the edge, same asset
 * preferred; |gap - gap'| <= 200 pips within 0.10% of the base fee, else <= 1000) -> heuristic fallback (k-free
 * features). Every score's source is counted; the cache is saved every 300 steps.
 *
 * Quantization (v4): gaps within +-0.10% of the base fee are bucketed at 0.01% (the decision boundary: profitable
 * arbitrage iff gap > base fee); elsewhere as v3. The other features use v3's buckets.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { featuresToState, type Features } from '../../../services/src/features.js';
import { JevCache, scoreHeuristic, scoreWithJev, degrade, jevCacheKey, type ModelScore } from '../../../services/src/model/index.js';
import { DATA_DIR } from '../util.js';

export type SourceV4 = 'jev' | 'jev-cache' | 'jev-nearest' | 'heuristic' | 'heuristic-paced' | 'heuristic-jev-failed';
const PREFIX = jevCacheKey('', 'v4');

const bucket = (x: number, step: number) => Math.round(x / step) * step;

export function quantizeV4(f: Features): Features {
  const g = f.gapPips;
  const b = f.baseFee;
  const gapQ =
    Math.abs(g - b) <= 1000 ? bucket(g, 100) : g < 1000 ? bucket(g, 250) : g < 5000 ? bucket(g, 500) : g < 15000 ? bucket(g, 2500) : bucket(g, 5000);
  return {
    ...f,
    kBps: undefined,
    arbFeePips: undefined,
    arbThresholdPips: undefined,
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

/** Heuristic on k-free features (edge vs the base fee), the same information the v4 Jev state carries. */
export function heuristicV4(f: Features): ModelScore {
  return scoreHeuristic({ ...f, kBps: undefined, arbFeePips: undefined, arbThresholdPips: undefined });
}

export class ScorerV4 {
  readonly cache: JevCache;
  calls = 0;
  failures = 0;
  retries = 0;
  private consecutiveFails = 0;
  private pausedUntilStep = -1;
  latencies: number[] = [];
  counts: Record<SourceV4, number> = { jev: 0, 'jev-cache': 0, 'jev-nearest': 0, heuristic: 0, 'heuristic-paced': 0, 'heuristic-jev-failed': 0 };
  private nearest: { side: string; pips: number; base: number; asset: string; s: ModelScore }[] = [];

  constructor(
    readonly mode: 'jev' | 'heuristic',
    readonly budget: number,
    readonly totalSteps: number,
    readonly baseIsToken0: boolean,
    readonly assetTag: 'ETH' | 'BTC',
    readonly cacheFile = resolve(DATA_DIR, 'jev-cache.json'),
  ) {
    this.cache = new JevCache(cacheFile);
    try {
      const raw = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, ModelScore>;
      for (const [k, v] of Object.entries(raw)) if (k.startsWith(PREFIX)) this.addNearest(k.slice(PREFIX.length), v);
    } catch {
      /* no cache yet */
    }
  }

  text(q: Features): string {
    const s = featuresToState(q, { baseIsToken0: this.baseIsToken0, format: 'v4' });
    return this.assetTag === 'ETH' ? s : s.replaceAll('ETH/USDC', 'BTC/USDC').replaceAll('(ETH)', '(BTC)');
  }

  private addNearest(state: string, s: ModelScore) {
    const m = /pool price is (above|below|equal to) the Binance mid by [\d.]+% \((\d+) pips\)/.exec(state);
    const b = /base_fee: ([\d.]+)%/.exec(state);
    const asset = state.includes('BTC/USDC') ? 'BTC' : 'ETH';
    if (m && b && s.model === 'jev') this.nearest.push({ side: m[1]!, pips: Number(m[2]), base: Math.round(Number(b[1]) * 1e4), asset, s });
  }

  private lookupNearest(q: Features): ModelScore | null {
    const side = q.gapSign > 0 ? 'above' : q.gapSign < 0 ? 'below' : 'equal to';
    const tol = Math.abs(q.gapPips - q.baseFee) <= 1000 ? 200 : 1000;
    let best: { d: number; s: ModelScore } | null = null;
    for (const e of this.nearest) {
      if (e.side !== side || e.base !== q.baseFee) continue;
      // never cross the decision boundary (gap vs base fee) when borrowing a neighbour's answer
      if (e.pips - e.base > 0 !== q.gapPips - q.baseFee > 0) continue;
      const d = Math.abs(e.pips - q.gapPips) + (e.asset === this.assetTag ? 0 : 1);
      if (d <= tol && (!best || d < best.d)) best = { d, s: e.s };
    }
    return best?.s ?? null;
  }

  async score(f: Features, step: number, degraded: boolean): Promise<{ s: ModelScore; source: SourceV4 }> {
    let s: ModelScore | null = null;
    let source: SourceV4 = 'heuristic';
    if (this.mode === 'jev') {
      const q = quantizeV4(f);
      const state = this.text(q);
      const hit = this.cache.get(jevCacheKey(state, 'v4'));
      if (hit) {
        s = hit;
        source = 'jev-cache';
      } else if (step >= this.pausedUntilStep && this.calls < this.budget && this.calls < Math.max(40, (this.budget * (step + 1)) / this.totalSteps)) {
        this.calls++;
        const t0 = performance.now();
        s = await scoreWithJev(state, { prompt: 'v4', cache: this.cache, timeoutMs: 3000 });
        if (!s) {
          this.retries++;
          s = await scoreWithJev(state, { prompt: 'v4', cache: this.cache, timeoutMs: 3000 }); // one retry
        }
        if (s) {
          source = 'jev';
          this.consecutiveFails = 0;
          this.addNearest(state, s);
          this.latencies.push(performance.now() - t0);
        } else {
          this.failures++;
          if (++this.consecutiveFails >= 4) {
            this.pausedUntilStep = step + 100; // circuit breaker: the gateway is unreachable, stop burning time
            this.consecutiveFails = 0;
          }
          s = this.lookupNearest(q);
          source = s ? 'jev-nearest' : 'heuristic-jev-failed';
        }
      } else {
        s = this.lookupNearest(q);
        source = s ? 'jev-nearest' : 'heuristic-paced';
      }
    }
    if (!s) s = heuristicV4(f);
    this.counts[source]++;
    return { s: degraded ? degrade(s) : s, source };
  }

  save() {
    if (this.mode === 'jev') this.cache.save();
  }
}
