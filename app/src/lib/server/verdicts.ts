/**
 * v6 model verdicts: the keeper appends one JSON line per posted attestation to
 * VERDICTS_FILE, else <ONIBLOCK_ROOT>/.runtime/verdicts.<chainId>.jsonl (services/src/keeper.ts VerdictLog, capped to
 * the last ~5000 lines). Read at request time; a missing file is simply "no verdicts yet" ([]).
 */
import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ATTACK_TYPES, type VerdictJson } from '../types';
import { loadDeployment } from './deployment';
import { chainSel, RUNTIME_DIR } from './env';

export const VERDICTS_MAX_LIMIT = 5000;

export function verdictsFile(): string {
  if (process.env.VERDICTS_FILE) return process.env.VERDICTS_FILE;
  const sel = chainSel();
  let chainId = sel.name === 'local' ? 31337 : sel.chain.id;
  try {
    chainId = loadDeployment(chainId).chainId;
  } catch {
    /* no deployment yet: use the selected chain id */
  }
  return path.join(RUNTIME_DIR, `verdicts.${chainId}.jsonl`);
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Validate one parsed line (the file is written by our keeper, but never trust a partial / torn line). */
function toVerdict(x: unknown): VerdictJson | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (!isNum(o.block) || !isNum(o.target) || !isNum(o.pToxicBps) || !isNum(o.pJitBps) || typeof o.txHash !== 'string') return null;
  const attack = typeof o.attack === 'string' && (ATTACK_TYPES as readonly string[]).includes(o.attack) ? (o.attack as VerdictJson['attack']) : null;
  let attackProbs: VerdictJson['attackProbs'] = null;
  if (o.attackProbs && typeof o.attackProbs === 'object') {
    const src = o.attackProbs as Record<string, unknown>;
    attackProbs = {} as NonNullable<VerdictJson['attackProbs']>;
    for (const k of ATTACK_TYPES) attackProbs[k] = isNum(src[k]) ? src[k] : 0;
  }
  return {
    block: o.block,
    target: o.target,
    pMalicious: isNum(o.pMalicious) ? o.pMalicious : null,
    attack,
    attackProbs,
    pToxicBps: o.pToxicBps,
    pJitBps: o.pJitBps,
    ...(isNum(o.k) ? { k: o.k } : {}),
    ...(isNum(o.jitWindow) ? { jitWindow: o.jitWindow } : {}),
    model: typeof o.model === 'string' ? o.model : 'unknown',
    txHash: o.txHash,
  };
}

/** Latest `limit` verdicts, newest first. Missing/unreadable file => []. */
export function readVerdicts(limit = 50): VerdictJson[] {
  const n = Math.max(1, Math.min(VERDICTS_MAX_LIMIT, Math.floor(limit) || 50));
  const f = verdictsFile();
  let text: string;
  try {
    // runtime file outside the app tree (same opt-out as deployment.ts): not a build-time asset
    if (!existsSync(/*turbopackIgnore: true*/ f)) return [];
    text = readFileSync(/*turbopackIgnore: true*/ f, 'utf8');
  } catch {
    return [];
  }
  const out: VerdictJson[] = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const l = lines[i]!.trim();
    if (!l) continue;
    try {
      const v = toVerdict(JSON.parse(l));
      if (v) out.push(v);
    } catch {
      /* torn line (keeper mid-write): skip */
    }
  }
  return out;
}

/**
 * The verdict behind a given tx or block: by attestation tx first, then the attestation that targeted `block`
 * (the one in force for swaps in that block), then the one observed at `block`. undefined if none.
 */
export function findVerdict(q: { tx?: string; block?: number }): VerdictJson | undefined {
  const all = readVerdicts(VERDICTS_MAX_LIMIT);
  const tx = q.tx?.toLowerCase();
  if (tx) {
    const byTx = all.find((v) => v.txHash.toLowerCase() === tx);
    if (byTx) return byTx;
  }
  if (q.block !== undefined) return all.find((v) => v.target === q.block) ?? all.find((v) => v.block === q.block);
  return undefined;
}
