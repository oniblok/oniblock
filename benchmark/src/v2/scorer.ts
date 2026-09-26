/**
 * v2 model scorer. Same policy as v1 (src/model.ts): quantized fee-aware state -> on-disk Jev cache -> paced Jev
 * call (bounded budget per window) -> nearest cached Jev answer (same side, gap within 5 bps, same k bucket) ->
 * heuristic fallback. Differences: the asset name is substituted into the state text (BTC windows say BTC/USDC),
 * and every score's source is counted so the report can state the fallback share.
 * mode 'heuristic' = heuristic only (the separate "mheur" arm, so the model comparison is not confounded by fallback).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { featuresToState, type Features } from '../../../services/src/features.js';
import { JevCache, scoreHeuristic, scoreWithJev, degrade, type ModelScore } from '../../../services/src/model/index.js';
import { quantize } from '../model.js';
import { DATA_DIR } from '../util.js';

export type SourceV2 = 'jev' | 'jev-cache' | 'jev-nearest' | 'heuristic' | 'heuristic-paced' | 'heuristic-jev-failed';

function stateFormat(state: string): string {
  const m = /k = ([\d.]+)\)/.exec(state);
  return m ? `fee-aware:k=${m[1]}` : 'base-fee';
}

export class ScorerV2 {
  readonly cache: JevCache;
  calls = 0;
  failures = 0;
  latencies: number[] = [];
  counts: Record<SourceV2, number> = { jev: 0, 'jev-cache': 0, 'jev-nearest': 0, heuristic: 0, 'heuristic-paced': 0, 'heuristic-jev-failed': 0 };
  private nearest: { side: string; pips: number; fmt: string; asset: string; s: ModelScore }[] = [];

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
      for (const [k, v] of Object.entries(raw)) this.addNearest(k, v);
    } catch {
      /* no cache yet */
    }
  }

  private text(f: Features): string {
    const s = featuresToState(f, { baseIsToken0: this.baseIsToken0 });
    return this.assetTag === 'ETH' ? s : s.replaceAll('ETH/USDC', 'BTC/USDC').replaceAll('(ETH)', '(BTC)');
  }

  private addNearest(state: string, s: ModelScore) {
    const m = /pool price is (above|below|equal to) the Binance mid by [\d.]+% \((\d+) pips\)/.exec(state);
    const asset = state.includes('BTC/USDC') ? 'BTC' : 'ETH';
    if (m && s.model === 'jev') this.nearest.push({ side: m[1]!, pips: Number(m[2]), fmt: stateFormat(state), asset, s });
  }

  private lookupNearest(q: Features, state: string): ModelScore | null {
    const side = q.gapSign > 0 ? 'above' : q.gapSign < 0 ? 'below' : 'equal to';
    const fmt = stateFormat(state);
    let best: { d: number; s: ModelScore } | null = null;
    for (const e of this.nearest) {
      if (e.side !== side || e.fmt !== fmt) continue;
      const d = Math.abs(e.pips - q.gapPips) + (e.asset === this.assetTag ? 0 : 1); // prefer same asset on ties
      if (d <= 500 && (!best || d < best.d)) best = { d, s: e.s };
    }
    return best?.s ?? null;
  }

  async score(f: Features, step: number, degraded: boolean): Promise<{ s: ModelScore; source: SourceV2 }> {
    let s: ModelScore | null = null;
    let source: SourceV2 = 'heuristic';
    if (this.mode === 'jev') {
      const q = quantize(f);
      const state = this.text(q);
      const hit = this.cache.get(state);
      if (hit) {
        s = hit;
        source = 'jev-cache';
      } else if (this.calls < this.budget && this.calls < Math.max(20, (this.budget * (step + 1)) / this.totalSteps)) {
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
        s = this.lookupNearest(q, state);
        source = s ? 'jev-nearest' : 'heuristic-paced';
      }
    }
    if (!s) s = scoreHeuristic(f);
    this.counts[source]++;
    return { s: degraded ? degrade(s) : s, source };
  }

  save() {
    if (this.mode === 'jev') this.cache.save();
  }
}
