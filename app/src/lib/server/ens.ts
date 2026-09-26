/**
 * /api/ens: the ENSv2 namespace as the UniversalResolverV2 sees it.
 *  - live.<root> wildcard names (ENSIP-10): <model>.live, current.live, <pool>.live. None of these subnames is
 *    registered; the resolver set on live.<root> (OniblockLiveResolver, EnsSetup `add-live`) answers for the whole
 *    subtree from hook state. Records are shown raw; an unresolvable name (resolver not deployed on this chain) is null.
 *  - ENSIP-19 primary names of the quoter and settler keys through UR.reverse(addr, 60) (forward-verified by the UR),
 *    next to the forward addr(<role>.<root>) so a mismatch is visible.
 */
import 'server-only';
import type { Address } from 'viem';
import type { EnsLiveName, EnsNamespaceJson, EnsPrimary } from '../types';
import { ctx, ensAddr, ensAvailable, ensReverse, ensTexts, REVERSE_COIN_TYPE, type Ctx } from './chain';

/** Text keys OniblockLiveResolver serves on <model>.live.<root> and current.live.<root>. */
export const LIVE_MODEL_KEYS = ['calibration.brier', 'calibration.n', 'calibration.jit.brier', 'demoted', 'jit.demoted', 'allowed', 'status', 'model-node'];
/** Text keys it serves on <pool>.live.<root>. */
export const LIVE_POOL_KEYS = ['k', 'jit-window', 'p-toxic', 'p-jit', 'model', 'stale', 'fee-zero-for-one', 'fee-one-for-zero', 'hook', 'pool-id'];
/** Text keys of the current.live.<root> alias (the model in force: anchor model, or the last accepted one while stale). */
export const LIVE_CURRENT_KEYS = ['model-node', 'label', 'models-name', 'k', 'status', 'jit.status', 'stale'];
export const LIVE_MODELS = ['oniblock1', 'jev-v1', 'kev-v1', 'heuristic-v1'];

export function liveNames(root: string, pool: string): Omit<EnsLiveName, 'records'>[] {
  return [
    ...LIVE_MODELS.map((m) => ({ name: `${m}.live.${root}`, kind: 'model' as const, keys: LIVE_MODEL_KEYS })),
    { name: `current.live.${root}`, kind: 'current' as const, keys: LIVE_CURRENT_KEYS },
    { name: `${pool}.live.${root}`, kind: 'pool' as const, keys: LIVE_POOL_KEYS },
  ];
}

/** The pool label EnsSetup registered under pools.<root> (weth-usdc), from the ENS deployment's namehashes. */
function poolLabel(c: Ctx): string {
  const n = Object.keys(c.ens?.namehashes ?? {}).find((k) => /\.pools\./.test(k));
  return n?.split('.')[0] || 'weth-usdc';
}

export async function getEnsNamespace(): Promise<EnsNamespaceJson> {
  const c = await ctx();
  const ens = await ensAvailable(c);
  const root = (c.ens?.name ?? process.env.ENS_NAME ?? 'oniblock.eth').toLowerCase();
  const names = liveNames(root, poolLabel(c));
  const roles: { role: EnsPrimary['role']; address: Address | undefined }[] = [
    { role: 'quoter', address: c.d.quoter },
    { role: 'settler', address: c.d.settler },
  ];
  const [live, primary] = await Promise.all([
    Promise.all(names.map(async (n): Promise<EnsLiveName> => ({ ...n, records: ens ? ((await ensTexts(c, n.name, n.keys)) ?? null) : null }))),
    Promise.all(
      roles.map(async ({ role, address }): Promise<EnsPrimary> => {
        const expected = `${role}.${root}`;
        const [name, forward] = ens ? await Promise.all([ensReverse(c, address), ensAddr(c, expected)]) : [null, undefined];
        return {
          role,
          address: address ?? null,
          expected,
          name,
          forward: forward ?? null,
          matches: forward && address ? forward.toLowerCase() === address.toLowerCase() : null,
        };
      }),
    ),
  ]);
  // EnsSetup writes liveResolver = 0x0 (older runs) when `live` is still on the placeholder resolver: not deployed.
  const lr = c.ens?.liveResolver;
  const liveResolver = lr && !/^0x0{40}$/i.test(lr) ? lr : null;
  const liveNode = c.ens?.liveNode ?? c.ens?.namehashes?.[`live.${root}`] ?? null;
  return {
    chain: {
      name: c.sel.name,
      chainId: c.d.chainId,
      ens,
      ensName: c.ens?.name ?? null,
      universalResolver: c.ens?.universalResolver ?? null,
      liveResolver,
      liveNode,
    },
    root,
    coinType: Number(REVERSE_COIN_TYPE),
    live,
    primary,
  };
}
