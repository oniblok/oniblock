import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/config.js';
import { compactProbs, VerdictLog, verdictsPath, VERDICTS_KEEP, VERDICTS_REWRITE_AT, type Verdict } from '../src/keeper.js';
import { attackProbabilities } from '../src/model/types.js';

const mk = (i: number): Verdict => ({
  block: i,
  target: i + 1,
  pMalicious: 0.83,
  attack: 'split_arbitrage',
  attackProbs: compactProbs({ ...attackProbabilities(undefined), split_arbitrage: 0.71, cex_dex_arbitrage: 0.1, jit_liquidity: 0.09, none: 0.1 }),
  pToxicBps: 7470,
  pJitBps: 830,
  k: 4200,
  jitWindow: 37,
  model: 'jev',
  txHash: `0x${i.toString(16).padStart(64, '0')}`,
});

describe('v6 verdicts file (one JSON line per posted attestation)', () => {
  it('path: VERDICTS_FILE overrides, else <DEMO_RUNTIME_DIR | .runtime>/verdicts.<chainId>.jsonl', () => {
    const prev = { f: process.env.VERDICTS_FILE, d: process.env.DEMO_RUNTIME_DIR };
    try {
      delete process.env.VERDICTS_FILE;
      delete process.env.DEMO_RUNTIME_DIR;
      expect(verdictsPath(31337)).toBe(resolve(ROOT, '.runtime', 'verdicts.31337.jsonl'));
      process.env.DEMO_RUNTIME_DIR = '/tmp/x';
      expect(verdictsPath(11155111)).toBe('/tmp/x/verdicts.11155111.jsonl');
      process.env.VERDICTS_FILE = '/tmp/y/v.jsonl';
      expect(verdictsPath(31337)).toBe('/tmp/y/v.jsonl');
    } finally {
      if (prev.f === undefined) delete process.env.VERDICTS_FILE;
      else process.env.VERDICTS_FILE = prev.f;
      if (prev.d === undefined) delete process.env.DEMO_RUNTIME_DIR;
      else process.env.DEMO_RUNTIME_DIR = prev.d;
    }
  });
  it('appends JSON lines (creating the directory), keeps only the fields of the spec, and caps: rewrite to the last `keep` when over `rewriteAt`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verdicts-'));
    try {
      const f = join(dir, 'nested', 'verdicts.31337.jsonl');
      const log = new VerdictLog(f, 5, 8);
      for (let i = 1; i <= 8; i++) expect(log.append(mk(i))).toBe(true);
      let lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBe(8);
      expect(JSON.parse(lines[0]!)).toEqual(mk(1));
      expect(Object.keys(JSON.parse(lines[0]!))).toEqual(['block', 'target', 'pMalicious', 'attack', 'attackProbs', 'pToxicBps', 'pJitBps', 'k', 'jitWindow', 'model', 'txHash']);
      // the 9th append crosses rewriteAt = 8: file is rewritten with the last 5 (blocks 5..9)
      log.append(mk(9));
      lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
      expect(lines.map((l) => (JSON.parse(l) as Verdict).block)).toEqual([5, 6, 7, 8, 9]);
      expect(log.size()).toBe(5);
      for (let i = 10; i <= 12; i++) log.append(mk(i));
      expect(log.size()).toBe(8);
      log.append(mk(13));
      lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
      expect(lines.map((l) => (JSON.parse(l) as Verdict).block)).toEqual([9, 10, 11, 12, 13]);
      // a fresh instance counts the existing file
      expect(new VerdictLog(f, 5, 8).size()).toBe(5);
      expect(VERDICTS_KEEP).toBe(5000);
      expect(VERDICTS_REWRITE_AT).toBe(6000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('never throws on an unwritable path', () => {
    const log = new VerdictLog('/dev/null/not-a-dir/verdicts.jsonl', 5, 8);
    expect(log.append(mk(1))).toBe(false);
    expect(log.append(mk(2))).toBe(false);
  });
  it('compactProbs rounds every type to 2 decimals and keeps all 7 keys', () => {
    const c = compactProbs({ ...attackProbabilities(undefined), split_arbitrage: 0.714285, jit_liquidity: 0.005 });
    expect(c.split_arbitrage).toBe(0.71);
    expect(c.jit_liquidity).toBe(0.01);
    expect(Object.keys(c).length).toBe(7);
  });
});
