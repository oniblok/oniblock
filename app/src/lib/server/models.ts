/** /models: per model node — on-chain calibration (arb head + v5 JIT head), demotion, history, ENS text records. */
import 'server-only';
import type { Hex } from 'viem';
import { ctx, ensAvailable, ensTexts, JIT_CALIBRATION_KEYS, jitCalibrationKey, jitHeadSupported, MODEL_KEYS, nameOf, tryRead, type Ctx } from './chain';
import { modelKind, readConfig } from './live';

type Args = Record<string, unknown>;
const n = (x: unknown) => (typeof x === 'bigint' ? Number(x) : Number(x ?? 0));

export interface CalibrationPoint {
  block: number;
  brierBps: number;
  hitRateBps: number;
  n: number;
}

/**
 * v5 JIT head: the same model's second prediction ("will liquidity added next block be short-lived fee capture?"),
 * scored by the settler under calibration(jitCalibrationKey(modelNode)) and gated by isJitDemoted (parent allowlist +
 * own n / Brier). ENS mirrors it as calibration.jit.* on the model name.
 */
export interface JitHeadRow {
  calibrationKey: Hex;
  brierBps: number | null;
  hitRateBps: number | null;
  n: number;
  updatedBlock: number | null;
  /** demoted for bad JIT calibration (window forced to jitWindowDefault) */
  demoted: boolean | null;
  /** on probation: n < minSamples (window = jitWindowDefault) */
  unseasoned: boolean;
  history: CalibrationPoint[];
  ens?: Record<string, string>;
}

export interface ModelRow {
  modelNode: Hex;
  name?: string;
  kind: string | null;
  brierBps: number | null;
  hitRateBps: number | null;
  n: number;
  updatedBlock: number | null;
  /** demoted for bad calibration (Brier above threshold) */
  demoted: boolean | null;
  /** on probation: n < minSamples (hook caps k at kDefault) */
  unseasoned: boolean;
  allowed: boolean | null;
  attestations: number;
  lastAttestBlock: number | null;
  history: CalibrationPoint[];
  ens?: Record<string, string>;
  /** absent when the deployed ABI has no JIT head (pre-v5 hook) */
  jit?: JitHeadRow;
}

export interface ModelsPage {
  head: number;
  chain: { name: string; chainId: number; ens: boolean; ensName?: string };
  brierDemoteBps: number;
  kDefaultBps: number;
  minSamples: number;
  currentModelNode?: Hex;
  /** the deployed ABI carries the v5 JIT head */
  jitHead: boolean;
  /** v5 JIT window bounds and the window in force now (fields null when the hook/config does not expose them) */
  jitWindow: { min: number | null; max: number | null; default: number | null; now: number | null };
  models: ModelRow[];
}

/** Model allowlist view, if the deployed hook has one (name differs across versions). */
async function allowed(c: Ctx, node: Hex): Promise<boolean | null> {
  for (const fn of ['isModelAllowed', 'modelAllowed', 'allowedModel']) {
    const r = await tryRead<boolean>(c, fn, [c.d.oniblock.poolId, node]);
    if (r !== undefined) return r;
  }
  return null;
}

const optNum = (x: unknown): number | null => (x == null ? null : n(x));

export async function getModels(): Promise<ModelsPage> {
  const c = await ctx();
  const head = Number(await c.pc.getBlockNumber());
  const [cfg, ens, cals, atts, ps] = await Promise.all([
    readConfig(c),
    ensAvailable(c),
    c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'CalibrationUpdated', fromBlock: BigInt(c.d.deployBlock), toBlock: BigInt(head) }),
    c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'AttestationPosted', args: { id: c.d.oniblock.poolId }, fromBlock: BigInt(c.d.deployBlock), toBlock: BigInt(head) }),
    tryRead<readonly [Args, Args, boolean]>(c, 'poolState', [c.d.oniblock.poolId]),
  ]);
  type L = { args: Args; blockNumber: bigint };
  const minSamples = Number(cfg.minSamples ?? 0);
  const jitHead = jitHeadSupported(c);
  // c.names maps namehash -> name; models = known *.models.* names + every node seen on-chain
  const modelHashes = new Set<Hex>();
  for (const [h, name] of c.names) if (/\.models\./.test(name)) modelHashes.add(h as Hex);
  for (const l of cals as unknown as L[]) modelHashes.add((l.args.modelNode as Hex).toLowerCase() as Hex);
  for (const l of atts as unknown as L[]) modelHashes.add((l.args.modelNode as Hex).toLowerCase() as Hex);
  // v5: the settler posts the JIT head under jitCalibrationKey(modelNode), so CalibrationUpdated also carries those
  // derived keys. They belong to their parent model's row, never to a row of their own.
  if (jitHead) {
    const derived = [...modelHashes].map((node) => jitCalibrationKey(node).toLowerCase() as Hex);
    for (const k of derived) modelHashes.delete(k);
  }

  const histOf = (key: Hex): CalibrationPoint[] =>
    (cals as unknown as L[])
      .filter((l) => (l.args.modelNode as string).toLowerCase() === key)
      .map((l) => ({ block: Number(l.blockNumber), brierBps: n(l.args.brierBps), hitRateBps: n(l.args.hitRateBps), n: n(l.args.n) }));
  const pick = (t: Record<string, string> | undefined, keys: string[]) => (t ? Object.fromEntries(keys.filter((k) => k in t).map((k) => [k, t[k]!])) : undefined);

  const models: ModelRow[] = [];
  for (const node of modelHashes) {
    const name = nameOf(c, node);
    const myAtts = (atts as unknown as L[]).filter((l) => (l.args.modelNode as string).toLowerCase() === node);
    const jitKey = jitHead ? (jitCalibrationKey(node).toLowerCase() as Hex) : undefined;
    const textKeys = jitKey ? [...MODEL_KEYS, ...JIT_CALIBRATION_KEYS] : MODEL_KEYS;
    const [cal, demoted, allow, texts, jitCal, jitDemoted] = await Promise.all([
      tryRead<Args>(c, 'calibration', [node]),
      tryRead<boolean>(c, 'isDemoted', [c.d.oniblock.poolId, node]),
      allowed(c, node),
      ens && name ? ensTexts(c, name, textKeys) : Promise.resolve(undefined),
      jitKey ? tryRead<Args>(c, 'calibration', [jitKey]) : Promise.resolve(undefined),
      jitKey ? tryRead<boolean>(c, 'isJitDemoted', [c.d.oniblock.poolId, node]) : Promise.resolve(undefined),
    ]);
    const nn = cal ? n(cal.n) : 0;
    let jit: JitHeadRow | undefined;
    if (jitKey) {
      const jn = jitCal ? n(jitCal.n) : 0;
      const jitUnseasoned = allow !== false && jn < minSamples;
      jit = {
        calibrationKey: jitKey,
        brierBps: jitCal && jn > 0 ? n(jitCal.brierBps) : null,
        hitRateBps: jitCal && jn > 0 ? n(jitCal.hitRateBps) : null,
        n: jn,
        updatedBlock: jitCal && jn > 0 ? n(jitCal.updatedBlock) : null,
        demoted: jitDemoted == null ? null : jitDemoted && allow !== false && !jitUnseasoned,
        unseasoned: jitUnseasoned,
        history: histOf(jitKey),
        ens: pick(texts, JIT_CALIBRATION_KEYS),
      };
    }
    models.push({
      modelNode: node,
      name,
      kind: modelKind(name),
      brierBps: cal && nn > 0 ? n(cal.brierBps) : null,
      hitRateBps: cal && nn > 0 ? n(cal.hitRateBps) : null,
      n: nn,
      updatedBlock: cal && nn > 0 ? n(cal.updatedBlock) : null,
      unseasoned: allow !== false && nn < minSamples,
      demoted: demoted == null ? null : demoted && allow !== false && !(nn < minSamples),
      allowed: allow,
      attestations: myAtts.length,
      lastAttestBlock: myAtts.length ? Number(myAtts.at(-1)!.blockNumber) : null,
      history: histOf(node),
      ens: pick(texts, MODEL_KEYS),
      jit,
    });
  }
  models.sort((a, b) => b.attestations - a.attestations || (a.name ?? '').localeCompare(b.name ?? ''));
  return JSON.parse(
    JSON.stringify({
      head,
      chain: { name: c.sel.name, chainId: c.d.chainId, ens, ensName: c.ens?.name },
      brierDemoteBps: cfg.brierDemoteBps,
      kDefaultBps: cfg.kDefaultBps,
      minSamples,
      currentModelNode: (ps?.[0]?.modelNode as Hex | undefined)?.toLowerCase() as Hex | undefined,
      jitHead,
      jitWindow: { min: optNum(cfg.jitWindowMin), max: optNum(cfg.jitWindowMax), default: optNum(cfg.jitWindowDefault), now: optNum(ps?.[0]?.jitWindow) },
      models,
    } satisfies ModelsPage),
  );
}
