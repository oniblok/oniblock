import { describe, expect, it } from 'vitest';
import { parseJev, scoreWithJev, JevCache } from '../src/model/jev.js';
import { computeFeatures, featuresToState } from '../src/features.js';
import { Q96 } from '../src/price.js';

const sample = {
  answers: {
    toxic: { type: 'boolean', probability: 0.7 },
    regime: { type: 'choice', choice: 'dump', probabilities: { dump: 0.71, unknown: 0.03, informed: 0.26 }, confidence: 0.57 },
  },
  model: 'typesafe-ai/jev',
};

describe('jev parsing (offline)', () => {
  it('parses the evaluate response', () => {
    expect(parseJev(sample, 123.4)).toEqual({ pToxicBps: 7000, confidenceBps: 5700, cls: 'dump', latencyMs: 123, model: 'jev' });
  });
  it('rejects malformed / out of range answers', () => {
    expect(parseJev(null, 1)).toBeNull();
    expect(parseJev({ answers: {} }, 1)).toBeNull();
    expect(parseJev({ answers: { toxic: { probability: 1.5 } } }, 1)).toBeNull();
    expect(parseJev({ answers: { toxic: { probability: 'x' } } }, 1)).toBeNull();
  });
  it('falls back to decisiveness when confidence missing; unknown class', () => {
    expect(parseJev({ answers: { toxic: { probability: 0.9 }, regime: { choice: 'weird' } } }, 1)).toMatchObject({ confidenceBps: 8000, cls: 'unknown' });
  });
  it('never throws: HTTP error, network error, timeout -> null', async () => {
    const err = (async () => new Response('{"error":"x"}', { status: 500 })) as unknown as typeof fetch;
    expect(await scoreWithJev('s', { apiKey: 'k', fetchImpl: err })).toBeNull();
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    expect(await scoreWithJev('s', { apiKey: 'k', fetchImpl: boom })).toBeNull();
    const slow = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('abort'))))) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await scoreWithJev('s', { apiKey: 'k', fetchImpl: slow, timeoutMs: 100 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await scoreWithJev('s', { apiKey: '', fetchImpl: err })).toBeNull();
  });
  it('caches by state', async () => {
    let n = 0;
    const ok = (async () => { n++; return new Response(JSON.stringify(sample), { status: 200 }); }) as unknown as typeof fetch;
    const cache = new JevCache();
    await scoreWithJev('same', { apiKey: 'k', fetchImpl: ok, cache });
    const again = await scoreWithJev('same', { apiKey: 'k', fetchImpl: ok, cache });
    expect(n).toBe(1);
    expect(again?.pToxicBps).toBe(7000);
  });
});

const live = process.env.OFFLINE === '1' || process.env.JEV_LIVE === '0' || !process.env.AI_GATEWAY_API_KEY ? describe.skip : describe;
// config.ts loads ../.env; import it so AI_GATEWAY_API_KEY is present for the gate above when run via vitest
await import('../src/config.js');

live('jev live (Vercel AI Gateway; OFFLINE=1 or JEV_LIVE=0 to skip)', () => {
  it('scores a toxic-looking state higher than a calm one', async () => {
    const o = 2600n * Q96;
    const mk = (pool: bigint, vol: number[]) =>
      featuresToState(computeFeatures({ swaps: [], oracleX96: o, poolX96: pool, depth0: 10n ** 21n, recentMids: vol, currentBlock: 10, lastAttestBlock: 9 }));
    const toxic = await scoreWithJev(mk((o * 1015n) / 1000n, [2600, 2610, 2595, 2620]), { timeoutMs: 5000 });
    const calm = await scoreWithJev(mk(o, [2600, 2600, 2600, 2600]), { timeoutMs: 5000 });
    expect(toxic).not.toBeNull();
    expect(calm).not.toBeNull();
    console.log('jev toxic', toxic, 'calm', calm);
    expect(toxic!.model).toBe('jev');
    expect(toxic!.pToxicBps).toBeGreaterThan(calm!.pToxicBps);
  }, 20_000);
});
