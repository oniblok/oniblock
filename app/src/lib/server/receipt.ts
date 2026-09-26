/**
 * /receipt/[tx]: decode the hook's Receipt(s) (or an AttestationPosted) from a tx, find the attestation in
 * force for that block, re-verify its EIP-712 signature from the setAttestation calldata, and attach the
 * model's running calibration (hook + ENS text records when the chain has our ENS deployment).
 */
import 'server-only';
import { decodeEventLog, decodeFunctionData, namehash, type Address, type Hex } from 'viem';
import { LEGACY_JIT_WALL, type JitPenaltyJson, type VerdictJson } from '../types';
import { CALIBRATION_KEYS, ctx, ensAddr, ensAvailable, ensTexts, JIT_CALIBRATION_KEYS, jitCalibrationKey, jitHeadSupported, nameOf, tryRead, type Ctx } from './chain';
import { modelKind, order, readConfig, readConfigAt } from './live';
import { ATTESTATION_TYPE_STRING, priceX96ToMid, recoverAttestor } from './shared';
import { findVerdict } from './verdicts';

type Args = Record<string, unknown>;
const n = (x: unknown) => (typeof x === 'bigint' ? Number(x) : Number(x ?? 0));
const optNum = (x: unknown): number | null => (x == null ? null : n(x));

export interface AttestationView {
  tx: Hex;
  minedBlock: number;
  attBlock: number;
  oracleMid: number;
  oracleMidX96: string;
  pToxicBps: number;
  confidenceBps: number;
  kBps: number;
  /** v5 JIT head (null on pre-v5 events) */
  pJitBps: number | null;
  jitWindow: number | null;
  /** EIP-712 type string as the hook defines it (ATTESTATION_TYPE), else the services constant */
  typeString: string;
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

interface HookCalibration {
  brierBps: number;
  hitRateBps: number;
  n: number;
  updatedBlock: number;
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
  /** v5: JitPenalty events in this tx (a removeLiquidity inside the position's window) */
  jitPenalties: JitPenaltyJson[];
  attestation?: AttestationView;
  postedInTx?: AttestationView;
  /** v6: the keeper's verdict behind this tx (attestation tx) or behind the attestation that targeted this block (swap tx), if the verdicts file has it */
  verdict?: VerdictJson;
  calibration?: {
    modelNode: Hex;
    modelName?: string;
    hook?: HookCalibration;
    /** hook.isDemoted now: not allowlisted, or Brier above brierDemoteBps (no record yet => active) */
    demotedNow?: boolean;
    history: { block: number; brierBps: number; hitRateBps: number; n: number }[];
    ens?: Record<string, string>;
    ensNamehash?: Hex;
    /** v5 JIT head of the same model (calibration(jitCalibrationKey(modelNode)), isJitDemoted, calibration.jit.* records) */
    jit?: {
      calibrationKey: Hex;
      hook?: HookCalibration;
      demotedNow?: boolean;
      history: { block: number; brierBps: number; hitRateBps: number; n: number }[];
      ens?: Record<string, string>;
    };
  };
  notes: string[];
  /** the chain head has not yet reached block + 2, so the next attestation (markout) may still be missing */
  pending?: boolean;
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
    pJitBps: optNum(a.pJitBps),
    jitWindow: optNum(a.jitWindow),
    typeString: (await tryRead<string>(c, 'ATTESTATION_TYPE', [])) ?? ATTESTATION_TYPE_STRING,
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
    // v5 struct order: blockNumber, oracleMidX96, pToxicBps, confidenceBps, pJitBps, modelNode, signature (pJitBps is
    // part of the EIP-712 digest; a pre-v5 calldata decodes wrongly here and ends in verifyNote).
    const fields = {
      poolId: c.d.oniblock.poolId,
      blockNumber: BigInt(n(att.blockNumber)),
      oracleMidX96: att.oracleMidX96 as bigint,
      pToxicBps: n(att.pToxicBps),
      confidenceBps: n(att.confidenceBps),
      pJitBps: n(att.pJitBps),
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
  const [rc, tx, ens, cfg, headBn] = await Promise.all([
    c.pc.getTransactionReceipt({ hash: txHash }),
    c.pc.getTransaction({ hash: txHash }),
    ensAvailable(c),
    readConfig(c),
    c.pc.getBlockNumber(),
  ]);
  const block = Number(rc.blockNumber);
  // Fee checks use the config in force at the receipt's block (a later updatePoolConfig must not break old receipts).
  const cfgAt = await readConfigAt(c, block);
  const cfgChanged = JSON.stringify(cfgAt.cfg) !== JSON.stringify(cfg);
  if (cfgAt.atBlock !== null && cfgChanged)
    notes.push(`Pool config changed after this swap: fees below are checked against the config in force at block ${block} (set at block ${cfgAt.atBlock}), not today's.`);
  const d0 = 10 ** c.d.token0.decimals;
  const d1 = 10 ** c.d.token1.decimals;
  const receipts: ReceiptView[] = [];
  const jitPenalties: JitPenaltyJson[] = [];
  let postedLog: { args: Args; blockNumber: bigint; transactionHash: Hex } | undefined;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== c.d.hook.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: c.hookAbi, data: l.data, topics: l.topics });
      const a = ev.args as unknown as Args;
      if (ev.eventName === 'JitPenalty' && a.id === c.d.oniblock.poolId) {
        const p0 = BigInt((a.penalty0 as bigint | undefined) ?? 0n);
        const p1 = BigInt((a.penalty1 as bigint | undefined) ?? 0n);
        const held = block - n(a.addedBlock);
        jitPenalties.push({
          tx: txHash,
          block,
          addedBlock: n(a.addedBlock),
          held,
          window: n(a.window),
          sender: a.sender as Address,
          positionKey: a.positionKey as Hex,
          penalty0: p0.toString(),
          penalty1: p1.toString(),
          penalty0Human: Number(p0) / d0,
          penalty1Human: Number(p1) / d1,
          penaltyQuote: null, // filled below once the attestation in force is known
          caughtByAdaptiveWindow: held >= LEGACY_JIT_WALL,
        });
      } else if (ev.eventName === 'Receipt' && a.id === c.d.oniblock.poolId) {
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
  if (!receipts.length && !postedLog && !jitPenalties.length) notes.push('This transaction emitted no Oniblock Receipt, AttestationPosted or JitPenalty event.');

  // Attestation in force at the swap = latest AttestationPosted at (blockNumber, logIndex) before the swap's.
  // The range end is clamped to the RPC head: public RPCs reject log ranges past their head block, and a freshly
  // mined swap has no block + 2 yet (the next attestation / markout is then simply pending).
  const head = Math.max(block, Number(headBn));
  const toBlock = Math.min(block + 2, head);
  const pending = block + 2 > head;
  const look = BigInt(Math.max(0, block - Math.max(64, n(cfg.staleBlocks) * 4)));
  const atts = await c.pc.getContractEvents({
    address: c.d.hook,
    abi: c.hookAbi,
    eventName: 'AttestationPosted',
    args: { id: c.d.oniblock.poolId },
    fromBlock: look,
    toBlock: BigInt(toBlock),
  });
  type L = { args: Args; blockNumber: bigint; transactionHash: Hex; logIndex: number };
  const list = (atts as unknown as L[]).slice().sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  const firstSwapLog = receipts[0]?.logIndex ?? Infinity;
  const before = (l: L) => Number(l.blockNumber) < block || (Number(l.blockNumber) === block && l.logIndex < firstSwapLog);
  const inForce = list.filter(before).at(-1);
  // markout at the first attestation posted after the swap (same convention as the live feed)
  const next = list.find((l) => !before(l));
  if (next) {
    const px = next.args.oracleMidX96 as bigint;
    const mid = priceX96ToMid(px, o);
    for (const r of receipts) r.markout = c.d.baseIsToken0 ? r.amount0Human * mid + r.amount1Human : r.amount1Human * mid + r.amount0Human;
  }
  // JIT penalties valued at the attested mid in force at the removal block (same convention as the live page).
  const midAtBlock = list.filter((l) => Number(l.blockNumber) <= block).at(-1);
  if (midAtBlock) {
    const mid = priceX96ToMid(midAtBlock.args.oracleMidX96 as bigint, o);
    for (const j of jitPenalties) j.penaltyQuote = c.d.baseIsToken0 ? j.penalty0Human * mid + j.penalty1Human : j.penalty1Human * mid + j.penalty0Human;
  }
  const attestation = receipts.length && inForce ? await attestationView(c, inForce, ens) : undefined;
  if (receipts.length && !inForce) notes.push('No attestation found before this swap (pool was in its conservative-fee state).');
  const postedInTx = postedLog ? await attestationView(c, postedLog, ens) : undefined;

  // Running calibration for the model referenced by this receipt/attestation.
  const node = (receipts[0]?.modelNode ?? postedInTx?.modelNode ?? attestation?.modelNode) as Hex | undefined;
  let calibration: ReceiptPage['calibration'];
  if (node && !/^0x0+$/.test(node)) {
    const name = nameOf(c, node);
    const jitKey = jitHeadSupported(c) ? jitCalibrationKey(node) : undefined;
    const calEvents = (key: Hex) =>
      c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'CalibrationUpdated', args: { modelNode: key }, fromBlock: BigInt(c.d.deployBlock), toBlock: 'latest' });
    const toHist = (ls: unknown) => (ls as L[]).map((l) => ({ block: Number(l.blockNumber), brierBps: n(l.args.brierBps), hitRateBps: n(l.args.hitRateBps), n: n(l.args.n) }));
    const toCal = (r: Args | undefined): HookCalibration | undefined =>
      r ? { brierBps: n(r.brierBps), hitRateBps: n(r.hitRateBps), n: n(r.n), updatedBlock: n(r.updatedBlock) } : undefined;
    const [hookCal, demoted, hist, texts, jitCal, jitDemoted, jitHist, jitTexts] = await Promise.all([
      tryRead<Args>(c, 'calibration', [node]),
      tryRead<boolean>(c, 'isDemoted', [c.d.oniblock.poolId, node]),
      calEvents(node),
      ens && name ? ensTexts(c, name, CALIBRATION_KEYS) : Promise.resolve(undefined),
      jitKey ? tryRead<Args>(c, 'calibration', [jitKey]) : Promise.resolve(undefined),
      jitKey ? tryRead<boolean>(c, 'isJitDemoted', [c.d.oniblock.poolId, node]) : Promise.resolve(undefined),
      jitKey ? calEvents(jitKey).catch(() => []) : Promise.resolve([]),
      jitKey && ens && name ? ensTexts(c, name, JIT_CALIBRATION_KEYS) : Promise.resolve(undefined),
    ]);
    calibration = {
      modelNode: node,
      modelName: name,
      hook: toCal(hookCal),
      demotedNow: demoted,
      history: toHist(hist),
      ens: texts,
      ensNamehash: name ? namehash(name) : undefined,
      jit: jitKey
        ? {
            calibrationKey: jitKey,
            hook: toCal(jitCal),
            demotedNow: jitDemoted,
            history: toHist(jitHist),
            ens: jitTexts,
          }
        : undefined,
    };
    if (!ens) notes.push('No ENS on this chain (local anvil): names shown are labels from deployments matched by namehash.');
  }

  // v6 verdict: by attestation tx (this tx if it posted one), else the verdict behind the attestation in force for
  // this tx's swaps (by that attestation's tx, then its target block), never the next block's.
  let verdict: VerdictJson | undefined;
  try {
    if (postedInTx) verdict = findVerdict({ tx: txHash, block: postedInTx.attBlock });
    else if (attestation) verdict = findVerdict({ tx: attestation.tx, block: attestation.attBlock });
    else verdict = findVerdict({ tx: txHash });
  } catch {
    verdict = undefined;
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
        config: cfgAt.cfg,
        receipts,
        jitPenalties,
        attestation,
        postedInTx,
        verdict,
        calibration,
        notes,
        pending,
      } satisfies ReceiptPage,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ),
  );
}
