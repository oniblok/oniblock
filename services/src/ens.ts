/**
 * ENS calibration text records (settler-only EAC per-key roles on our PermissionedResolver).
 * Mechanism per docs/ENS_INTEGRATION.md §4/§6:
 *   resolver.multicall([setText(dns(name), "calibration.brier", "1830"), ... hitRate, n, epoch])
 * from the settler key. v5: the JIT head's record goes through the same path under calibration.jit.* (head 'jit'). Values are decimal ASCII in bps (brier, hitRate), count (n), and a
 * monotonically increasing epoch (we use the settled block number).
 *
 * The ENS deployment comes from deployments/<chainId>.ens.json (or ENS_DEPLOYMENT_FILE, e.g.
 * deployments/11155111.anvil-fork.ens.json). If absent, the settler uses NoopCalibrationWriter
 * (logs only) — the hook's setCalibration (what drives the gate) is unaffected.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  concat,
  encodeFunctionData,
  parseAbi,
  stringToBytes,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { DEPLOYMENTS_DIR, env, log } from './config.js';
import type { TxSender } from './chain.js';

export interface CalibrationRecord {
  brierBps: number;
  hitRateBps: number;
  n: number;
  /** Monotonic epoch (settled block number). */
  epoch: number;
  /** Optional detail records (need their own per-key settler grants; EnsSetup grants them). */
  rawBrierBps?: number;
  skillBps?: number;
  baseRateBps?: number;
}

/** Keys the settler writes beyond the four base calibration.* keys. */
export const CALIBRATION_DETAIL_KEYS = ['calibration.brierRaw', 'calibration.skill', 'calibration.baseRate'] as const;

/**
 * v5: which head a record belongs to. 'arb' = the k head (`calibration.*`, the original records); 'jit' = the JIT
 * head (`calibration.jit.*` on the same model name; on-chain key = hook.jitCalibrationKey(modelNode)).
 */
export type CalibrationHead = 'arb' | 'jit';
export const CALIBRATION_PREFIX: Record<CalibrationHead, string> = { arb: 'calibration', jit: 'calibration.jit' };
/** The seven calibration.jit.* keys EnsSetup grants the settler (mirror of the arb keys). */
export const JIT_CALIBRATION_KEYS = ['brier', 'hitRate', 'n', 'epoch', 'brierRaw', 'skill', 'baseRate'].map((k) => `calibration.jit.${k}`);

export interface CalibrationRecordWriter {
  readonly kind: string;
  write(modelNode: Hex, rec: CalibrationRecord, head?: CalibrationHead): Promise<boolean>;
}

export const resolverAbi = parseAbi([
  'function setText(bytes name, string key, string value)',
  'function multicall(bytes[] calls) returns (bytes[])',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
]);

/** DNS wire-format name (same as EnsV2Lib.dnsEncode): "a.b.eth" -> 0x01 61 01 62 03 657468 00 */
export function dnsEncode(name: string): Hex {
  return concat([
    ...name.split('.').map((l) => {
      const b = stringToBytes(l);
      return concat([toHex(b.length, { size: 1 }), toHex(b)]);
    }),
    '0x00',
  ]);
}

/**
 * Text-record key/value pairs (decimal ASCII, bps units). `calibration.brier` is the value the settler posted
 * to hook.setCalibration (the gate value, same unit as hook.brierDemoteBps — skill-normalised by default, see
 * settler.ts); `calibration.brierRaw` is the absolute Brier, `calibration.skill` the Brier skill vs the
 * base-rate predictor (signed; 10000 = perfect, 0 = no better than the base rate).
 */
export function calibrationTextRecords(rec: CalibrationRecord, detail = true, head: CalibrationHead = 'arb'): [string, string][] {
  const p = CALIBRATION_PREFIX[head];
  const out: [string, string][] = [
    [`${p}.brier`, String(rec.brierBps)],
    [`${p}.hitRate`, String(rec.hitRateBps)],
    [`${p}.n`, String(rec.n)],
    [`${p}.epoch`, String(rec.epoch)],
  ];
  if (detail) {
    if (rec.rawBrierBps !== undefined) out.push([`${p}.brierRaw`, String(rec.rawBrierBps)]);
    if (rec.skillBps !== undefined) out.push([`${p}.skill`, String(rec.skillBps)]);
    if (rec.baseRateBps !== undefined) out.push([`${p}.baseRate`, String(rec.baseRateBps)]);
  }
  return out;
}

export function calibrationMulticallData(name: string, rec: CalibrationRecord, detail = true, head: CalibrationHead = 'arb'): Hex[] {
  const dns = dnsEncode(name);
  return calibrationTextRecords(rec, detail, head).map(([k, v]) => encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns, k, v] }));
}

export interface EnsDeployment {
  resolver: Address;
  universalResolver?: Address;
  registry?: Address;
  roleOracle?: Address;
  /** The root name the setup registered (e.g. oniblock.eth). */
  name?: string;
  /** ENSIP-10 wildcard resolver of live.<name> (EnsSetup `add-live`), when deployed. */
  liveResolver?: Address;
  /** name -> namehash (includes live.<name> once `add-live` ran) */
  namehashes: Record<string, Hex>;
  file: string;
}

export function loadEnsDeployment(chainId: number): EnsDeployment | undefined {
  const candidates = [env('ENS_DEPLOYMENT_FILE'), resolve(DEPLOYMENTS_DIR, `${chainId}.ens.json`)].filter(Boolean) as string[];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!j.resolver || !j.namehashes) continue;
    return { resolver: j.resolver, universalResolver: j.universalResolver, registry: j.registry, roleOracle: j.roleOracle, name: j.name, liveResolver: j.liveResolver, namehashes: j.namehashes, file: f };
  }
  return undefined;
}

export class NoopCalibrationWriter implements CalibrationRecordWriter {
  readonly kind = 'noop';
  async write(modelNode: Hex, rec: CalibrationRecord, head: CalibrationHead = 'arb'): Promise<boolean> {
    log('ens', 'would_write_text_records', { modelNode, head, records: Object.fromEntries(calibrationTextRecords(rec, true, head)) });
    return false;
  }
}

/** Writes calibration.* on the model's ENS name through our PermissionedResolver (one tx). */
export class EnsV2CalibrationWriter implements CalibrationRecordWriter {
  readonly kind = 'ensv2';
  private readonly nameOf = new Map<string, string>();
  /** false once the resolver rejected the detail keys of a head (an EnsSetup run from before they were granted). */
  private readonly detail: Record<CalibrationHead, boolean> = { arb: true, jit: true };
  /** `sender` must be the settler's TxSender (shared so nonces stay consistent). */
  constructor(
    private readonly sender: TxSender,
    private readonly ens: EnsDeployment,
  ) {
    for (const [name, node] of Object.entries(ens.namehashes)) this.nameOf.set(node.toLowerCase(), name);
  }
  /** `head` 'jit' writes calibration.jit.* (needs the EnsSetup grant-jit grants; otherwise the multicall reverts and this returns false). */
  async write(modelNode: Hex, rec: CalibrationRecord, head: CalibrationHead = 'arb'): Promise<boolean> {
    const name = this.nameOf.get(modelNode.toLowerCase());
    if (!name) {
      log('ens', 'unknown_model_node', { modelNode, head });
      return false;
    }
    const send = (detail: boolean) =>
      this.sender.send({
        address: this.ens.resolver,
        abi: resolverAbi,
        functionName: 'multicall',
        args: [calibrationMulticallData(name, rec, detail, head)],
        label: `ens ${CALIBRATION_PREFIX[head]} ${name}`,
      });
    let rc = await send(this.detail[head]);
    if (!rc && this.detail[head]) {
      // Most likely EACUnauthorizedAccountRoles on a detail key: fall back to the four base keys from now on.
      this.detail[head] = false;
      log('ens', 'detail_keys_unauthorized', { name, head, keys: calibrationTextRecords(rec, true, head).slice(4).map(([k]) => k) });
      rc = await send(false);
    }
    const ok = rc?.status === 'success';
    log('ens', ok ? 'text_records_written' : 'text_records_failed', { name, head, ...rec, detail: this.detail[head], tx: rc?.hash });
    return ok;
  }
}
