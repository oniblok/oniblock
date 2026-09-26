/** /models: per model node — on-chain calibration, demotion, history, ENS text records. */
import 'server-only';
import type { Hex } from 'viem';
import { ctx, ensAvailable, ensTexts, MODEL_KEYS, nameOf, tryRead, type Ctx } from './chain';
import { modelKind, readConfig } from './live';

type Args = Record<string, unknown>;
const n = (x: unknown) => (typeof x === 'bigint' ? Number(x) : Number(x ?? 0));

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
  history: { block: number; brierBps: number; hitRateBps: number; n: number }[];
  ens?: Record<string, string>;
}

export interface ModelsPage {
  head: number;
  chain: { name: string; chainId: number; ens: boolean; ensName?: string };
  brierDemoteBps: number;
  kDefaultBps: number;
  minSamples: number;
  currentModelNode?: Hex;
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
  // c.names maps namehash -> name; models = known *.models.* names + every node seen on-chain
  const modelHashes = new Set<Hex>();
  for (const [h, name] of c.names) if (/\.models\./.test(name)) modelHashes.add(h as Hex);
  for (const l of cals as unknown as L[]) modelHashes.add((l.args.modelNode as Hex).toLowerCase() as Hex);
  for (const l of atts as unknown as L[]) modelHashes.add((l.args.modelNode as Hex).toLowerCase() as Hex);

  const models: ModelRow[] = [];
  for (const node of modelHashes) {
    const name = nameOf(c, node);
    const myAtts = (atts as unknown as L[]).filter((l) => (l.args.modelNode as string).toLowerCase() === node);
    const hist = (cals as unknown as L[])
      .filter((l) => (l.args.modelNode as string).toLowerCase() === node)
      .map((l) => ({ block: Number(l.blockNumber), brierBps: n(l.args.brierBps), hitRateBps: n(l.args.hitRateBps), n: n(l.args.n) }));
    const [cal, demoted, allow, texts] = await Promise.all([
      tryRead<Args>(c, 'calibration', [node]),
      tryRead<boolean>(c, 'isDemoted', [c.d.oniblock.poolId, node]),
      allowed(c, node),
      ens && name ? ensTexts(c, name, MODEL_KEYS) : Promise.resolve(undefined),
    ]);
    const nn = cal ? n(cal.n) : 0;
    models.push({
      modelNode: node,
      name,
      kind: modelKind(name),
      brierBps: cal && nn > 0 ? n(cal.brierBps) : null,
      hitRateBps: cal && nn > 0 ? n(cal.hitRateBps) : null,
      n: nn,
      updatedBlock: cal && nn > 0 ? n(cal.updatedBlock) : null,
      unseasoned: allow !== false && nn < Number(cfg.minSamples ?? 0),
      demoted: demoted == null ? null : demoted && allow !== false && !(nn < Number(cfg.minSamples ?? 0)),
      allowed: allow,
      attestations: myAtts.length,
      lastAttestBlock: myAtts.length ? Number(myAtts.at(-1)!.blockNumber) : null,
      history: hist,
      ens: texts,
    });
  }
  models.sort((a, b) => b.attestations - a.attestations || (a.name ?? '').localeCompare(b.name ?? ''));
  return JSON.parse(
    JSON.stringify({
      head,
      chain: { name: c.sel.name, chainId: c.d.chainId, ens, ensName: c.ens?.name },
      brierDemoteBps: cfg.brierDemoteBps,
      kDefaultBps: cfg.kDefaultBps,
      minSamples: Number(cfg.minSamples ?? 0),
      currentModelNode: (ps?.[0]?.modelNode as Hex | undefined)?.toLowerCase() as Hex | undefined,
      models,
    } satisfies ModelsPage),
  );
}
