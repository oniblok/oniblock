/** v4 prompt probe (temporary dev tool): p / c for a sweep of gaps under the v4 question + state. Never prints keys. */
import '../config.js';
import { computeFeatures, featuresToState, type SwapObs } from '../features.js';
import { Q96 } from '../price.js';
import { scoreWithJev, type JevPrompt } from './jev.js';
const o = 2600n * Q96;
const E18 = 10n ** 18n;
const prompt = (process.argv[2] ?? 'v4') as JevPrompt;
for (const gapBps of [0, 5, 15, 25, 29, 33, 40, 60, 120]) {
  for (const volHi of [false, true]) {
    const swaps: SwapObs[] = Array.from({ length: 3 }, (_, j) => ({ block: 100 - j, zeroForOne: j % 2 === 0, amount0: (j % 2 ? 1n : -1n) * E18, amount1: 0n, fee: 3000, arbDir: j === 0 }));
    const vol = volHi ? [2600, 2606, 2597, 2609, 2601] : [2600, 2600.1, 2600.05, 2600.12, 2600.08];
    const f = computeFeatures({ swaps, oracleX96: o, poolX96: o + (o * BigInt(gapBps)) / 10_000n, depth0: 5000n * E18, recentMids: vol, currentBlock: 100, lastAttestBlock: 99, baseFee: 3000 });
    const st = featuresToState(f, { format: prompt === 'v4' ? 'v4' : 'auto' });
    const r = await scoreWithJev(st, { prompt, timeoutMs: 8000 });
    console.log(JSON.stringify({ gapBps, volHi, p: r?.pToxicBps, c: r?.confidenceBps, pc: r ? Math.round((r.pToxicBps * r.confidenceBps) / 1e4) : null, cls: r?.cls, ms: r?.latencyMs }));
  }
}
