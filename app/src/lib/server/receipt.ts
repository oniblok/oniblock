/**
 * /receipt/[tx]: decode the hook's Receipt(s) (or an AttestationPosted) from a tx, find the attestation in
 * force for that block, re-verify its EIP-712 signature from the setAttestation calldata, and attach the
 * model's running calibration (hook + ENS text records when the chain has our ENS deployment).
 */
import 'server-only';
import { decodeEventLog, decodeFunctionData, namehash, type Address, type Hex } from 'viem';
import { CALIBRATION_KEYS, ctx, ensAddr, ensAvailable, ensTexts, nameOf, tryRead, type Ctx } from './chain';
import { modelKind, order, readConfig } from './live';
import { priceX96ToMid, recoverAttestor } from './shared';

type Args = Record<string, unknown>;
const n = (x: unknown) => (typeof x === 'bigint' ? Number(x) : Number(x ?? 0));

export interface AttestationView {
  tx: Hex;
  minedBlock: number;
  attBlock: number;
  oracleMid: number;
  oracleMidX96: string;
  pToxicBps: number;
  confidenceBps: number;
  kBps: number;
  modelNode: Hex;
  modelName?: string;
  model: string | null;
  quoter: Address;
  quoterEns?: { name: string; resolved?: Address; matches?: boolean };
  signature?: Hex;
  sig?: { r: Hex; s: Hex; v: number };
  domain?: { name: string; version: string; chainId: number; verifyingContract: Address };
  recovered?: Address;
  attestorAtPost?: Address;
  attestorNow?: Address;
  verified: boolean | null;
  verifyNote?: string;
}

export interface ReceiptView {
  logIndex: number;
  block: number;
  sender: Address;
  zeroForOne: boolean;
  arbDir: boolean;
  gapPips: number;
  kBps: number;
  feePips: number;
  amount0: string;
  amount1: string;
  amount0Human: number;
  amount1Human: number;
  modelNode: Hex;
  modelName?: string;
  stale: boolean;
  /** swapper markout at the next attested CEX mid, quote units (positive = swapper beat the CEX mid) */
  markout?: number;
}

export interface ReceiptPage {
  tx: Hex;
  status: string;
  block: number;
  from: Address;
  to?: Address | null;
  chain: { name: string; chainId: number; ens: boolean; ensName?: string };
  pair: { token0: string; token1: string; base: string; quote: string };
  config: Record<string, unknown>;
  receipts: ReceiptView[];
  attestation?: AttestationView;
  postedInTx?: AttestationView;
  calibration?: {
    modelNode: Hex;
    modelName?: string;
    hook?: { brierBps: number; hitRateBps: number; n: number; updatedBlock: number };
    demotedNow?: boolean;
    /** on probation: calibration n < poolConfig.minSamples (the hook caps k at kDefault) */
    unseasoned?: boolean;
    minSamples?: number;
    history: { block: number; brierBps: number; hitRateBps: number; n: number }[];
    ens?: Record<string, string>;
    ensNamehash?: Hex;
  };
  notes: string[];
}

async function attestationView(c: Ctx, log: { args: Args; blockNumber: bigint; transactionHash: Hex }, ens: boolean): Promise<AttestationView> {
  const a = log.args;
  const node = a.modelNode as Hex;
  const name = nameOf(c, node);
  const view: AttestationView = {
    tx: log.transactionHash,
    minedBlock: Number(log.blockNumber),
    attBlock: n(a.blockNumber),
    oracleMidX96: String(a.oracleMidX96),
    oracleMid: priceX96ToMid(a.oracleMidX96 as bigint, order(c)),
    pToxicBps: n(a.pToxicBps),
    confidenceBps: n(a.confidenceBps),
    kBps: n(a.kBps),
    modelNode: node,
    modelName: name,
    model: modelKind(name),
    quoter: a.quoter as Address,
    verified: null,
  };
  // quoter identity via ENS (fork / Sepolia)
  const qName = c.ens?.name ? `quoter.${c.ens.name}` : undefined;
  if (ens && qName) {
    const resolved = await ensAddr(c, qName);
    view.quoterEns = { name: qName, resolved, matches: resolved ? resolved.toLowerCase() === view.quoter.toLowerCase() : undefined };
  }
  // Re-verify: decode setAttestation calldata -> signature -> recover EIP-712 signer -> compare to hook.attestor().
  try {
    const tx = await c.pc.getTransaction({ hash: log.transactionHash });
    const dec = decodeFunctionData({ abi: c.hookAbi, data: tx.input });
    if (dec.functionName !== 'setAttestation') throw new Error(`tx calls ${dec.functionName}, not setAttestation`);
    const att = (dec.args as readonly unknown[])[1] as Args;
    const sig = att.signature as Hex;
    view.signature = sig;
    view.sig = { r: `0x${sig.slice(2, 66)}` as Hex, s: `0x${sig.slice(66, 130)}` as Hex, v: parseInt(sig.slice(130, 132), 16) };
    let dom = { name: 'Oniblock', version: '1' };
    try {
      const d = await c.pc.getEip712Domain({ address: c.d.hook });
      dom = { name: d.domain.name ?? dom.name, version: d.domain.version ?? dom.version };
    } catch {
      const e = c.d.raw.eip712 as { name?: string; version?: string } | undefined;
      if (e?.name) dom = { name: e.name, version: e.version ?? '1' };
    }
    view.domain = { ...dom, chainId: c.d.chainId, verifyingContract: c.d.hook };
    const fields = {
      poolId: c.d.oniblock.poolId,
      blockNumber: BigInt(n(att.blockNumber)),
      oracleMidX96: att.oracleMidX96 as bigint,
      pToxicBps: n(att.pToxicBps),
      confidenceBps: n(att.confidenceBps),
      modelNode: att.modelNode as Hex,
    };
    view.recovered = await recoverAttestor(c.d.chainId, c.d.hook, fields, sig, dom);
    view.attestorAtPost = await tryRead<Address>(c, 'attestor', [], log.blockNumber);
    view.attestorNow = await tryRead<Address>(c, 'attestor', []);
    view.verified = !!view.attestorAtPost && view.recovered.toLowerCase() === view.attestorAtPost.toLowerCase();
  } catch (e) {
    view.verifyNote = `could not re-verify from calldata: ${(e as Error).message.split('\n')[0]}`;
  }
  return view;
}

export async function getReceiptPage(txHash: Hex): Promise<ReceiptPage> {
  const c = await ctx();
  const o = order(c);
  const notes: string[] = [];
  const [rc, tx, ens, cfg] = await Promise.all([
    c.pc.getTransactionReceipt({ hash: txHash }),
    c.pc.getTransaction({ hash: txHash }),
    ensAvailable(c),
    readConfig(c),
  ]);
  const block = Number(rc.blockNumber);
  const d0 = 10 ** c.d.token0.decimals;
  const d1 = 10 ** c.d.token1.decimals;
  const receipts: ReceiptView[] = [];
  let postedLog: { args: Args; blockNumber: bigint; transactionHash: Hex } | undefined;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== c.d.hook.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: c.hookAbi, data: l.data, topics: l.topics });
      const a = ev.args as unknown as Args;
      if (ev.eventName === 'Receipt' && a.id === c.d.oniblock.poolId) {
        receipts.push({
          logIndex: l.logIndex,
          block: n(a.blockNumber),
          sender: a.sender as Address,
          zeroForOne: !!a.zeroForOne,
          arbDir: !!a.arbDir,
          gapPips: n(a.gapPips),
          kBps: n(a.kBps),
          feePips: n(a.feePips),
          amount0: String(a.amount0),
          amount1: String(a.amount1),
          amount0Human: Number(a.amount0 as bigint) / d0,
          amount1Human: Number(a.amount1 as bigint) / d1,
          modelNode: a.modelNode as Hex,
          modelName: nameOf(c, a.modelNode as Hex),
          stale: !!a.stale,
        });
      } else if (ev.eventName === 'AttestationPosted') {
        postedLog = { args: a, blockNumber: rc.blockNumber, transactionHash: txHash };
      }
    } catch {
      /* not a hook event we know */
    }
  }
  if (!receipts.length && !postedLog) notes.push('This transaction emitted no Oniblock Receipt or AttestationPosted event.');

  // Attestation in force at the swap block (latest AttestationPosted mined at or before it).
  const look = BigInt(Math.max(0, block - Math.max(64, n(cfg.staleBlocks) * 4)));
  const atts = await c.pc.getContractEvents({
    address: c.d.hook,
    abi: c.hookAbi,
    eventName: 'AttestationPosted',
    args: { id: c.d.oniblock.poolId },
    fromBlock: look,
    toBlock: BigInt(block + 2),
  });
  type L = { args: Args; blockNumber: bigint; transactionHash: Hex; logIndex: number };
  const list = atts as unknown as L[];
  const firstSwapLog = receipts[0]?.logIndex ?? Infinity;
  const inForce = list.filter((l) => Number(l.blockNumber) < block || (Number(l.blockNumber) === block && l.logIndex < firstSwapLog)).at(-1);
  const next = list.find((l) => Number(l.blockNumber) > block);
  if (next) {
    const px = next.args.oracleMidX96 as bigint;
    const mid = priceX96ToMid(px, o);
    for (const r of receipts) r.markout = c.d.baseIsToken0 ? r.amount0Human * mid + r.amount1Human : r.amount1Human * mid + r.amount0Human;
  }
  const attestation = receipts.length && inForce ? await attestationView(c, inForce, ens) : undefined;
  if (receipts.length && !inForce) notes.push('No attestation found before this swap (pool was in its conservative-fee state).');
  const postedInTx = postedLog ? await attestationView(c, postedLog, ens) : undefined;

  // Running calibration for the model referenced by this receipt/attestation.
  const node = (receipts[0]?.modelNode ?? postedInTx?.modelNode ?? attestation?.modelNode) as Hex | undefined;
  let calibration: ReceiptPage['calibration'];
  if (node && !/^0x0+$/.test(node)) {
    const name = nameOf(c, node);
    const [hookCal, demoted, hist, texts] = await Promise.all([
      tryRead<Args>(c, 'calibration', [node]),
      tryRead<boolean>(c, 'isDemoted', [c.d.oniblock.poolId, node]),
      c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'CalibrationUpdated', args: { modelNode: node }, fromBlock: BigInt(c.d.deployBlock), toBlock: 'latest' }),
      ens && name ? ensTexts(c, name, CALIBRATION_KEYS) : Promise.resolve(undefined),
    ]);
    calibration = {
      modelNode: node,
      modelName: name,
      hook: hookCal ? { brierBps: n(hookCal.brierBps), hitRateBps: n(hookCal.hitRateBps), n: n(hookCal.n), updatedBlock: n(hookCal.updatedBlock) } : undefined,
      demotedNow: demoted,
      unseasoned: !!demoted && (hookCal ? n(hookCal.n) : 0) < n(cfg.minSamples),
      minSamples: n(cfg.minSamples),
      history: (hist as unknown as L[]).map((l) => ({ block: Number(l.blockNumber), brierBps: n(l.args.brierBps), hitRateBps: n(l.args.hitRateBps), n: n(l.args.n) })),
      ens: texts,
      ensNamehash: name ? namehash(name) : undefined,
    };
    if (!ens) notes.push('No ENS on this chain (local anvil): names shown are labels from deployments matched by namehash.');
  }

  return JSON.parse(
    JSON.stringify(
      {
        tx: txHash,
        status: rc.status,
        block,
        from: tx.from,
        to: tx.to,
        chain: { name: c.sel.name, chainId: c.d.chainId, ens, ensName: c.ens?.name },
        pair: {
          token0: c.d.token0.symbol,
          token1: c.d.token1.symbol,
          base: c.d.baseIsToken0 ? c.d.token0.symbol : c.d.token1.symbol,
          quote: c.d.baseIsToken0 ? c.d.token1.symbol : c.d.token0.symbol,
        },
        config: cfg,
        receipts,
        attestation,
        postedInTx,
        calibration,
        notes,
      } satisfies ReceiptPage,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ),
  );
}
