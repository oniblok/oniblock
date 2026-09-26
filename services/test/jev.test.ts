import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJev, scoreWithJev, JevCache, jevCacheKey, defaultJevPrompt, jevQuestions, JEV_QUESTIONS, JEV_QUESTIONS_V1, JEV_QUESTIONS_V4, JEV_QUESTIONS_V5, JEV_QUESTIONS_V6 } from '../src/model/jev.js';
import { stateFormatFor } from '../src/model/index.js';
import { ATTACK_TYPES, attackProbabilities, mapV6, type AttackType } from '../src/model/types.js';
import { computeFeatures, featuresToState } from '../src/features.js';
import { Q96 } from '../src/price.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const sample = {
  answers: {
    toxic: { type: 'boolean', probability: 0.7 },
    regime: { type: 'choice', choice: 'dump', probabilities: { dump: 0.71, unknown: 0.03, informed: 0.26 }, confidence: 0.57 },
  },
  model: 'typesafe-ai/jev',
};

describe('jev parsing (offline)', () => {
  it('parses the evaluate response', () => {
    expect(parseJev(sample, 123.4)).toEqual({ pToxicBps: 7000, confidenceBps: 5700, pJitBps: 0, cls: 'dump', latencyMs: 123, model: 'jev' });
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

describe('v4 prompt (offline)', () => {
  it('the v4 question set carries the v4 toxic question and namespaces the cache (v1 keys unchanged)', async () => {
    expect(JEV_QUESTIONS).toBe(JEV_QUESTIONS_V6);
    expect(JEV_QUESTIONS_V4.toxic.instructions).toContain('probability must be near 0');
    expect(jevCacheKey('s', 'v1')).toBe('s');
    expect(jevCacheKey('s', 'v4')).not.toBe('s');
    const bodies: string[] = [];
    const ok = (async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify(sample), { status: 200 });
    }) as unknown as typeof fetch;
    const cache = new JevCache();
    await scoreWithJev('x', { apiKey: 'k', fetchImpl: ok, cache, prompt: 'v4' });
    await scoreWithJev('x', { apiKey: 'k', fetchImpl: ok, cache, prompt: 'v1' }); // different key => second call
    expect(bodies.length).toBe(2);
    expect(JSON.parse(bodies[0]!).questions.toxic.instructions).toBe(JEV_QUESTIONS_V4.toxic.instructions);
    expect(JSON.parse(bodies[1]!).questions.toxic.instructions).toBe(JEV_QUESTIONS_V1.toxic.instructions);
  });
});

describe('v5 prompt: the JIT head (offline)', () => {
  const withJit = { ...sample, answers: { ...sample.answers, jit: { type: 'boolean', probability: 0.35 } } };
  it('parseJev reads answers.jit.probability -> pJitBps; a missing or malformed jit answer is never a failure (0)', () => {
    expect(parseJev(withJit, 10)).toMatchObject({ pToxicBps: 7000, pJitBps: 3500, model: 'jev' });
    expect(parseJev(sample, 10)!.pJitBps).toBe(0);
    expect(parseJev({ answers: { toxic: { probability: 0.2 }, jit: { probability: 1.5 } } }, 1)).toMatchObject({ pToxicBps: 2000, pJitBps: 0 });
    expect(parseJev({ answers: { toxic: { probability: 0.2 }, jit: { probability: 'x' } } }, 1)).toMatchObject({ pJitBps: 0 });
    expect(parseJev({ answers: { toxic: { probability: 0.2 }, jit: { probability: 1 } } }, 1)!.pJitBps).toBe(10000);
    // the arb head still gates parsing
    expect(parseJev({ answers: { jit: { probability: 0.9 } } }, 1)).toBeNull();
  });
  it('V5 = V4 questions byte-identical + the typed boolean jit question of the spec', () => {
    expect(JEV_QUESTIONS_V5.toxic).toBe(JEV_QUESTIONS_V4.toxic);
    expect(JEV_QUESTIONS_V5.regime).toBe(JEV_QUESTIONS_V1.regime);
    expect(Object.keys(JEV_QUESTIONS_V5)).toEqual(['toxic', 'regime', 'jit']);
    expect(JEV_QUESTIONS_V5.jit.type).toBe('boolean');
    expect(JEV_QUESTIONS_V5.jit.instructions).toBe(
      'Will liquidity added to this pool in the next block be opportunistic just-in-time liquidity: placed tightly around the current price to capture the fee of a large expected swap and removed again within about 100 blocks, rather than liquidity that stays? Answer with the probability that new liquidity in the next block is short-lived fee capture. Use liquidity_recent as the base rate: when most positions added recently were removed again within the window, the probability must be high (above 0.7); when recent liquidity stayed, it must be low.',
    );
    // the base-rate sentence names the state line it refers to (featuresToState v5 emits `liquidity_recent:`)
    expect(JEV_QUESTIONS_V5.jit.instructions).toContain('Use liquidity_recent as the base rate');
    expect(JEV_QUESTIONS_V5.jit.criteria).toEqual({
      true: 'short-lived fee capture around a large swap (mint, swap, burn within ~100 blocks)',
      false: 'liquidity that stays, routine rebalancing, or no liquidity change expected',
    });
  });
  it('JEV_QUESTIONS_V1 / V4 / V5 are byte-identical to the frozen caches (pinned hashes)', () => {
    expect(sha256(JSON.stringify(JEV_QUESTIONS_V1))).toBe('150b460084f2195d8b7b0f6262a0172b74f1c061a4ef6d503cf07a92322b471a');
    expect(sha256(JSON.stringify(JEV_QUESTIONS_V4))).toBe('f8014b0b4ec480fe56b6ed2d21e3166cac74ac644d118e0ffda88486914c4a10');
    expect(sha256(JSON.stringify(JEV_QUESTIONS_V5))).toBe('f03d1f4d45b551771d029c5094a55a834adb76be5a7922781c5acb57a17e4869');
    expect(jevQuestions('v1')).toBe(JEV_QUESTIONS_V1);
    expect(jevQuestions('v4')).toBe(JEV_QUESTIONS_V4);
    expect(jevQuestions('v5')).toBe(JEV_QUESTIONS_V5);
    expect(jevQuestions('v6')).toBe(JEV_QUESTIONS_V6);
  });
  it('JEV_PROMPT=v5 restores v5 (v4|v1 the older ones), cache key namespaced [jev-prompt:v5], state format per prompt', () => {
    const prev = process.env.JEV_PROMPT;
    try {
      process.env.JEV_PROMPT = 'v5';
      expect(defaultJevPrompt()).toBe('v5');
      process.env.JEV_PROMPT = 'v4';
      expect(defaultJevPrompt()).toBe('v4');
      process.env.JEV_PROMPT = 'v1';
      expect(defaultJevPrompt()).toBe('v1');
    } finally {
      if (prev === undefined) delete process.env.JEV_PROMPT;
      else process.env.JEV_PROMPT = prev;
    }
    expect(jevCacheKey('s', 'v5')).toBe('[jev-prompt:v5]\ns');
    expect(jevCacheKey('s', 'v5')).not.toBe(jevCacheKey('s', 'v4'));
    expect(jevCacheKey('s', 'v1')).toBe('s');
    expect([stateFormatFor('v1'), stateFormatFor('v4'), stateFormatFor('v5')]).toEqual(['auto', 'v4', 'v5']);
  });
  it('sends the jit question under v5 only, and parses its answer', async () => {
    const bodies: string[] = [];
    const ok = (async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify(withJit), { status: 200 });
    }) as unknown as typeof fetch;
    const v5 = await scoreWithJev('x', { apiKey: 'k', fetchImpl: ok, prompt: 'v5' });
    const v4 = await scoreWithJev('x', { apiKey: 'k', fetchImpl: ok, prompt: 'v4' });
    expect(JSON.parse(bodies[0]!).questions).toEqual(JEV_QUESTIONS_V5);
    expect(JSON.parse(bodies[1]!).questions.jit).toBeUndefined();
    expect(v5?.pJitBps).toBe(3500);
    expect(v4?.pJitBps).toBe(3500); // the parser is prompt-agnostic; a v4 answer simply has no jit key (=> 0)
  });
  it('JevCache: pre-v5 entries (no pJitBps) load with pJitBps = 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-cache-'));
    try {
      const f = join(dir, 'c.json');
      writeFileSync(f, JSON.stringify({ old: { pToxicBps: 7000, confidenceBps: 5700, cls: 'dump', latencyMs: 1, model: 'jev' } }));
      expect(new JevCache(f).get('old')).toEqual({ pToxicBps: 7000, confidenceBps: 5700, cls: 'dump', latencyMs: 1, model: 'jev', pJitBps: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('v6 prompt: one malicious score + one attack type (offline)', () => {
  const probs = (o: Partial<Record<AttackType, number>>) => ({ ...attackProbabilities(undefined), ...o });
  const v6 = (p: number, attack?: unknown) => ({ answers: { malicious: { type: 'boolean', probability: p }, ...(attack === undefined ? {} : { attack }) }, model: 'typesafe-ai/jev' });

  it('question structure: exactly malicious (boolean) + attack (choice with the 7 types, in order)', () => {
    expect(Object.keys(JEV_QUESTIONS_V6)).toEqual(['malicious', 'attack']);
    expect(JEV_QUESTIONS_V6.malicious.type).toBe('boolean');
    expect(Object.keys(JEV_QUESTIONS_V6.malicious.criteria)).toEqual(['true', 'false']);
    expect(JEV_QUESTIONS_V6.attack.type).toBe('choice');
    expect(Object.keys(JEV_QUESTIONS_V6.attack.criteria)).toEqual([...ATTACK_TYPES]);
    expect(ATTACK_TYPES).toEqual(['none', 'cex_dex_arbitrage', 'split_arbitrage', 'backrun', 'jit_liquidity', 'sandwich', 'unknown']);
    expect(JEV_QUESTIONS).toBe(JEV_QUESTIONS_V6);
  });
  it('exact texts pinned', () => {
    expect(JEV_QUESTIONS_V6.malicious.instructions).toBe(
      "Will the next block bring flow that costs this pool's liquidity providers money? That means either profitable informed arbitrage toward the Binance mid at the base fee (arb_edge_at_base_fee positive, including split arbitrage and backruns after a large move), or opportunistic just-in-time liquidity placed around a large swap and removed again within the window. Answer with the probability that the next block contains such an exploit. If arb_edge_at_base_fee is zero or negative AND recent liquidity stayed, the probability must be near 0.",
    );
    expect(JEV_QUESTIONS_V6.malicious.criteria).toEqual({
      true: 'LP-costly flow: profitable informed arbitrage toward the Binance mid at the base fee (arb_edge_at_base_fee positive; plain, split or backrun), or opportunistic just-in-time liquidity placed around a large swap and removed again within the window',
      false: 'no exploit: arb_edge_at_base_fee zero or negative and recent liquidity stayed; ordinary uninformed flow or routine rebalancing, charge only the base fee',
    });
    expect(JEV_QUESTIONS_V6.attack.instructions).toBe(
      'Which kind of flow is most likely in the next block? Use liquidity_recent/liquidity_shape for jit_liquidity, arb_edge_at_base_fee and cex_volatility for the arbitrage types, recent_swaps for split_arbitrage/backrun.',
    );
    expect(JEV_QUESTIONS_V6.attack.criteria).toEqual({
      none: 'no LP-costly flow: no profitable gap at the base fee and recent liquidity stayed',
      cex_dex_arbitrage: 'informed arb against a stale price',
      split_arbitrage: 'the same arbitrage split into many sub-swaps in one block',
      backrun: 're-alignment right after a large displacing swap',
      jit_liquidity: 'mint→swap→burn fee capture',
      sandwich: 'front+back-run around a victim swap (not defended by this hook, label only)',
      unknown: 'no clear signal',
    });
    // the state lines the instructions refer to exist in the v5 text (featuresToState format 'v5', reused by v6)
    for (const key of ['liquidity_recent', 'liquidity_shape', 'arb_edge_at_base_fee', 'cex_volatility', 'recent_swaps']) expect(JEV_QUESTIONS_V6.attack.instructions).toContain(key);
  });
  it('default prompt v6 (JEV_PROMPT=v5 restores), cache key [jev-prompt:v6], v6 state = the v5 text', () => {
    const prev = process.env.JEV_PROMPT;
    try {
      delete process.env.JEV_PROMPT;
      expect(defaultJevPrompt()).toBe('v6');
      process.env.JEV_PROMPT = 'v5';
      expect(defaultJevPrompt()).toBe('v5');
      process.env.JEV_PROMPT = 'v6';
      expect(defaultJevPrompt()).toBe('v6');
      process.env.JEV_PROMPT = 'nonsense';
      expect(defaultJevPrompt()).toBe('v6');
    } finally {
      if (prev === undefined) delete process.env.JEV_PROMPT;
      else process.env.JEV_PROMPT = prev;
    }
    expect(jevCacheKey('s', 'v6')).toBe('[jev-prompt:v6]\ns');
    expect(jevCacheKey('s', 'v6')).not.toBe(jevCacheKey('s', 'v5'));
    expect(stateFormatFor('v6')).toBe('v5');
  });

  describe('mapV6: one score is the magnitude, the type allocates it', () => {
    it('single dominant type: price type -> all of p goes to k, jit -> all to the JIT window', () => {
      const a = mapV6(0.8, probs({ split_arbitrage: 0.9, none: 0.05, unknown: 0.05 }));
      expect(a).toEqual({ pToxicBps: 8000, pJitBps: 0, pPriceShare: 1, pJitShare: 0 }); // 0.9 / max(1 - 0.1, 0.05) = 1
      const j = mapV6(0.6, probs({ jit_liquidity: 0.7, none: 0.2, unknown: 0.1 }));
      expect(j).toEqual({ pToxicBps: 0, pJitBps: 6000, pPriceShare: 0, pJitShare: 1 }); // 0.7 / 0.7 = 1
      const c = mapV6(1, probs({ cex_dex_arbitrage: 1 }));
      expect(c).toEqual({ pToxicBps: 10000, pJitBps: 0, pPriceShare: 1, pJitShare: 0 });
    });
    it('both types split: the shares partition the named-attack mass (sandwich goes to neither knob)', () => {
      const m = mapV6(0.9, probs({ cex_dex_arbitrage: 0.3, backrun: 0.1, jit_liquidity: 0.4, sandwich: 0.1, none: 0.1 }));
      // denom = 1 - 0.1 = 0.9; price = 0.4 / 0.9, jit = 0.4 / 0.9
      expect(m.pPriceShare).toBeCloseTo(0.4444, 3);
      expect(m.pJitShare).toBeCloseTo(0.4444, 3);
      expect(m.pToxicBps).toBe(4000);
      expect(m.pJitBps).toBe(4000);
      const s = mapV6(0.5, probs({ sandwich: 1 }));
      expect(s).toEqual({ pToxicBps: 0, pJitBps: 0, pPriceShare: 0, pJitShare: 0 });
    });
    it('none-dominant: the small named mass is renormalised, never inflated past p', () => {
      const m = mapV6(0.2, probs({ none: 0.9, cex_dex_arbitrage: 0.1 }));
      expect(m.pPriceShare).toBeCloseTo(1, 6); // 0.1 / max(0.1, 0.05) = 1
      expect(m.pToxicBps).toBe(2000);
      expect(m.pJitBps).toBe(0);
      // denominator floor 0.05: a tiny named mass cannot blow up (share is capped at 1)
      const t = mapV6(0.5, probs({ none: 0.99, jit_liquidity: 0.01 }));
      expect(t.pJitShare).toBeCloseTo(0.2, 6); // 0.01 / 0.05
      expect(t.pJitBps).toBe(1000);
      expect(mapV6(0.5, probs({ none: 1 }))).toEqual({ pToxicBps: 0, pJitBps: 0, pPriceShare: 0, pJitShare: 0 });
    });
    it('unknown-dominant: unknown mass is excluded from the denominator like none', () => {
      const m = mapV6(0.7, probs({ unknown: 0.8, backrun: 0.15, jit_liquidity: 0.05 }));
      expect(m.pPriceShare).toBeCloseTo(0.75, 6); // 0.15 / 0.2
      expect(m.pJitShare).toBeCloseTo(0.25, 6);
      expect(m.pToxicBps).toBe(5250);
      expect(m.pJitBps).toBe(1750);
      expect(mapV6(0.7, probs({ unknown: 1 }))).toEqual({ pToxicBps: 0, pJitBps: 0, pPriceShare: 0, pJitShare: 0 });
    });
    it('missing keys / malformed values read as 0; p is clamped to [0,1]; undefined probs => nothing allocated', () => {
      expect(mapV6(0.5, { cex_dex_arbitrage: 0.5 })).toEqual({ pToxicBps: 2500, pJitBps: 0, pPriceShare: 0.5, pJitShare: 0 });
      expect(mapV6(0.5, { jit_liquidity: Number.NaN, backrun: 'x' as unknown as number, split_arbitrage: 2 })).toEqual({ pToxicBps: 5000, pJitBps: 0, pPriceShare: 1, pJitShare: 0 });
      expect(mapV6(0.5, undefined)).toEqual({ pToxicBps: 0, pJitBps: 0, pPriceShare: 0, pJitShare: 0 });
      expect(mapV6(7, probs({ jit_liquidity: 1 }))).toEqual({ pToxicBps: 0, pJitBps: 10000, pPriceShare: 0, pJitShare: 1 });
      expect(mapV6(-1, probs({ jit_liquidity: 1 })).pJitBps).toBe(0);
      expect(Object.keys(attackProbabilities({ jit_liquidity: 0.3, bogus: 1 }))).toEqual([...ATTACK_TYPES]);
    });
  });

  it('parseJev v6 with attack: pMaliciousBps, attack head (7 keys, choice, confidence), mapped pToxic/pJit, cls from the type', () => {
    const s = parseJev(v6(0.83, { type: 'choice', choice: 'split_arbitrage', probabilities: { split_arbitrage: 0.71, cex_dex_arbitrage: 0.1, jit_liquidity: 0.09, none: 0.1 }, confidence: 0.64 }), 88.6)!;
    expect(s).not.toBeNull();
    expect(s.model).toBe('jev');
    expect(s.latencyMs).toBe(89);
    expect(s.pMaliciousBps).toBe(8300);
    expect(s.confidenceBps).toBe(6400);
    expect(s.cls).toBe('informed');
    expect(s.attack).toEqual({ choice: 'split_arbitrage', probabilities: probs({ split_arbitrage: 0.71, cex_dex_arbitrage: 0.1, jit_liquidity: 0.09, none: 0.1 }), confidence: 0.64 });
    // denom 0.9: price share 0.81/0.9 = 0.9, jit share 0.09/0.9 = 0.1
    expect(s.pPriceShare).toBeCloseTo(0.9, 6);
    expect(s.pJitShare).toBeCloseTo(0.1, 6);
    expect(s.pToxicBps).toBe(7470);
    expect(s.pJitBps).toBe(830);
    // a jit choice is not 'informed'; none/unknown/sandwich neither
    expect(parseJev(v6(0.5, { choice: 'jit_liquidity', probabilities: { jit_liquidity: 0.9 }, confidence: 0.5 }), 1)!).toMatchObject({ cls: 'unknown', pToxicBps: 0, pJitBps: 4500 });
    expect(parseJev(v6(0.5, { choice: 'sandwich', probabilities: { sandwich: 0.9 }, confidence: 0.5 }), 1)!).toMatchObject({ cls: 'unknown', pToxicBps: 0, pJitBps: 0 });
    expect(parseJev(v6(0.9, { choice: 'backrun', probabilities: { backrun: 1 }, confidence: 0.9 }), 1)!.cls).toBe('informed');
  });
  it('parseJev v6: confidence falls back to |2p-1| (also read from providerMetadata), probabilities default to 0 for missing keys', () => {
    const s = parseJev(v6(0.9, { choice: 'cex_dex_arbitrage', probabilities: { cex_dex_arbitrage: 1 } }), 1)!;
    expect(s.confidenceBps).toBe(8000);
    expect(s.attack!.confidence).toBeCloseTo(0.8, 6);
    expect(s.attack!.probabilities).toEqual(probs({ cex_dex_arbitrage: 1 }));
    const meta = { ...v6(0.9, { choice: 'cex_dex_arbitrage', probabilities: { cex_dex_arbitrage: 1 } }), providerMetadata: { typesafe: { confidence: { attack: 0.33 } } } };
    expect(parseJev(meta, 1)!.confidenceBps).toBe(3300);
    // a valid choice without probabilities reads as one-hot on the choice
    expect(parseJev(v6(0.6, { choice: 'jit_liquidity' }), 1)!).toMatchObject({ pToxicBps: 0, pJitBps: 6000, attack: { choice: 'jit_liquidity', probabilities: probs({ jit_liquidity: 1 }) } });
    // probabilities without a valid choice: argmax
    expect(parseJev(v6(0.6, { choice: 'weird', probabilities: { backrun: 0.6, none: 0.4 } }), 1)!.attack!.choice).toBe('backrun');
  });
  it('parseJev v6 without attack: v5-style fallback (pToxic = p, pJit = 0, choice unknown); missing malicious => legacy path / null', () => {
    const s = parseJev(v6(0.42), 1)!;
    expect(s).toMatchObject({ pToxicBps: 4200, pJitBps: 0, pMaliciousBps: 4200, cls: 'unknown', model: 'jev', pPriceShare: 1, pJitShare: 0 });
    expect(s.attack).toEqual({ choice: 'unknown', probabilities: attackProbabilities(undefined), confidence: expect.closeTo(0.16, 6) });
    expect(s.confidenceBps).toBe(1600);
    // attack present but unusable (no valid choice, no finite probabilities) = missing
    expect(parseJev(v6(0.42, { choice: 'bogus', probabilities: { none: 'x' } }), 1)!).toMatchObject({ pToxicBps: 4200, pJitBps: 0, attack: { choice: 'unknown' } });
    // no malicious answer: the v1-v5 path (toxic), else null => heuristic fallback in score()
    expect(parseJev({ answers: { attack: { choice: 'backrun', probabilities: { backrun: 1 }, confidence: 0.9 } } }, 1)).toBeNull();
    expect(parseJev({ answers: { malicious: { probability: 1.5 }, toxic: { probability: 0.2 } } }, 1)).toMatchObject({ pToxicBps: 2000 });
    expect(parseJev({ answers: { malicious: { probability: 'x' } } }, 1)).toBeNull();
    // v1-v5 answers still parse exactly as before (no v6 fields)
    const legacy = parseJev(sample, 1)!;
    expect(legacy.pMaliciousBps).toBeUndefined();
    expect(legacy.attack).toBeUndefined();
  });
  it('sends the v6 questions under the default prompt and parses the v6 answer; v5 still sends the two booleans', async () => {
    const bodies: string[] = [];
    const ans = v6(0.83, { type: 'choice', choice: 'split_arbitrage', probabilities: { split_arbitrage: 0.71, cex_dex_arbitrage: 0.1, jit_liquidity: 0.09, none: 0.1 }, confidence: 0.64 });
    const ok = (async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify(ans), { status: 200 });
    }) as unknown as typeof fetch;
    const prev = process.env.JEV_PROMPT;
    delete process.env.JEV_PROMPT;
    try {
      const cache = new JevCache();
      const s = await scoreWithJev('x', { apiKey: 'k', fetchImpl: ok, cache });
      expect(JSON.parse(bodies[0]!).questions).toEqual(JEV_QUESTIONS_V6);
      expect(s?.attack?.choice).toBe('split_arbitrage');
      expect(s?.pToxicBps).toBe(7470);
      // cached under the v6 namespace, attack head included
      expect(cache.get(jevCacheKey('x', 'v6'))?.attack?.choice).toBe('split_arbitrage');
      await scoreWithJev('x', { apiKey: 'k', fetchImpl: ok, prompt: 'v5' });
      expect(JSON.parse(bodies[1]!).questions).toEqual(JEV_QUESTIONS_V5);
    } finally {
      if (prev === undefined) delete process.env.JEV_PROMPT;
      else process.env.JEV_PROMPT = prev;
    }
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
