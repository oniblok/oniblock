import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import { parseArgs } from '../src/config.js';
import {
  assertDistinctAddresses,
  assertExplicitKeys,
  defaultReverseRegistrarAbi,
  parseOnly,
  PRIMARY_KEY_ENV,
  normaliseRoot,
  planPrimaryNames,
  primaryNameTargets,
  REVERSE_COIN_TYPE,
  reverseRegistrarFor,
  SEPOLIA_DEFAULT_REVERSE_REGISTRAR,
  setNameCalldata,
  type PrimaryReader,
} from '../src/ens-primary.js';

const Q = '0x05116e2EB4B3F816cBa8149F00850EC0fAF49D8b' as Address; // quoter of deployments/11155111.json
const S = '0xc9020f349b989c43bEb416bC5C97f4e044957A3B' as Address; // settler

describe('ens:primary (ENSIP-19 primary names)', () => {
  it('names the quoter and settler keys after the root name', () => {
    expect(primaryNameTargets('oniblock.eth')).toEqual([
      { role: 'quoter', name: 'quoter.oniblock.eth' },
      { role: 'settler', name: 'settler.oniblock.eth' },
    ]);
    expect(primaryNameTargets(' Oni-Block.eth. ', ['settler'])).toEqual([{ role: 'settler', name: 'settler.oni-block.eth' }]);
    expect(normaliseRoot('.OniBlock.eth')).toBe('oniblock.eth');
    expect(() => normaliseRoot('oniblock')).toThrow(/full name/);
  });

  it('uses the documented Sepolia DefaultReverseRegistrar unless ENS_DEFAULT_REVERSE_REGISTRAR overrides it', () => {
    expect(SEPOLIA_DEFAULT_REVERSE_REGISTRAR).toBe('0x4F382928805ba0e23B30cFB75fC9E848e82DFD47');
    expect(reverseRegistrarFor(11155111)).toEqual({ address: SEPOLIA_DEFAULT_REVERSE_REGISTRAR, source: 'sepolia-default' });
    expect(reverseRegistrarFor(11155111, '0x4f32a1c62e202922d4d6307126f43218db9da6f5')).toEqual({ address: '0x4F32A1c62E202922d4d6307126F43218DB9dA6f5', source: 'env' });
    expect(() => reverseRegistrarFor(31337)).toThrow(/ENS_DEFAULT_REVERSE_REGISTRAR/);
    expect(() => reverseRegistrarFor(11155111, 'not-an-address')).toThrow(/not an address/);
    expect(REVERSE_COIN_TYPE).toBe(60n);
  });

  it('encodes setName(string) with the verified selector', () => {
    const data = setNameCalldata('quoter.oniblock.eth');
    expect(data.slice(0, 10)).toBe('0xc47f0027');
    expect(decodeFunctionData({ abi: defaultReverseRegistrarAbi, data })).toEqual({ functionName: 'setName', args: ['quoter.oniblock.eth'] });
  });

  it('skips a key whose nameForAddr already matches and re-sets one that differs; forward mismatch is flagged, UR errors are tolerated', async () => {
    const calls: string[] = [];
    const reader: PrimaryReader = {
      nameForAddr: async (a) => {
        calls.push(`nameForAddr ${a}`);
        return a === Q ? 'Quoter.oniblock.eth' : 'settler.oldname.eth';
      },
      forwardAddr: async (name) => (name === 'quoter.oniblock.eth' ? Q : ('0x000000000000000000000000000000000000dEaD' as Address)),
      urReverse: async (a) => {
        if (a === S) throw new Error('ReverseAddressMismatch');
        return 'quoter.oniblock.eth';
      },
    };
    const plans = await planPrimaryNames(
      [
        { role: 'quoter', name: 'quoter.oniblock.eth', address: Q },
        { role: 'settler', name: 'settler.oniblock.eth', address: S },
      ],
      reader,
    );
    expect(plans[0]).toMatchObject({ role: 'quoter', action: 'skip', current: 'Quoter.oniblock.eth', forwardMatch: true, urReverse: 'quoter.oniblock.eth' });
    expect(plans[1]).toMatchObject({ role: 'settler', action: 'set', current: 'settler.oldname.eth', forwardMatch: false, urReverse: undefined });
    expect(calls).toEqual([`nameForAddr ${Q}`, `nameForAddr ${S}`]);
  });

  it('treats an unset record as "set" and an unreadable forward record as unverified (undefined), never as a mismatch', async () => {
    const reader: PrimaryReader = {
      nameForAddr: async () => '',
      forwardAddr: async () => {
        throw new Error('ResolverNotFound');
      },
      urReverse: async () => '',
    };
    const [p] = await planPrimaryNames([{ role: 'quoter', name: 'quoter.oniblock.eth', address: Q }], reader);
    expect(p).toMatchObject({ action: 'set', current: '', forward: undefined, forwardMatch: undefined, urReverse: '' });
  });
});

describe('ens:primary guards', () => {
  it('parses --only: absent = both roles, a list is filtered in canonical order, bare / empty / unknown values throw', () => {
    expect(parseOnly(undefined)).toEqual(['quoter', 'settler']);
    expect(parseOnly('settler')).toEqual(['settler']);
    expect(parseOnly(' settler , quoter ')).toEqual(['quoter', 'settler']);
    expect(() => parseOnly(true)).toThrow(/--only needs a value/);
    expect(() => parseOnly('')).toThrow(/--only needs a value/);
    expect(() => parseOnly(',')).toThrow(/--only needs a value/);
    expect(() => parseOnly('quoter,keeper')).toThrow(/quoter and\/or settler/);
  });

  it('a bare --only (end of argv or followed by another flag) reaches parseOnly as `true`', () => {
    expect(parseArgs(['--only']).only).toBe(true);
    expect(parseArgs(['--only', '--dry-run']).only).toBe(true);
    expect(() => parseOnly(parseArgs(['--only']).only)).toThrow(/--only needs a value/);
    expect(() => parseOnly(parseArgs(['--only', '--dry-run']).only)).toThrow(/--only needs a value/);
    expect(parseOnly(parseArgs(['--only', 'quoter']).only)).toEqual(['quoter']);
  });

  it('refuses two roles on one address (never two primary names from one key)', () => {
    expect(() =>
      assertDistinctAddresses([
        { role: 'quoter', name: 'quoter.oniblock.eth', address: Q },
        { role: 'settler', name: 'settler.oniblock.eth', address: Q.toLowerCase() as Address },
      ]),
    ).toThrow(/quoter and settler resolve to the same address/);
    expect(() =>
      assertDistinctAddresses([
        { role: 'quoter', name: 'quoter.oniblock.eth', address: Q },
        { role: 'settler', name: 'settler.oniblock.eth', address: S },
      ]),
    ).not.toThrow();
  });

  it('on sepolia requires QUOTER_PK / SETTLER_PK explicitly (no DEPLOYER_PK fallback); dev chains are exempt', () => {
    const only = (vars: Record<string, string>) => (name: string) => vars[name];
    expect(() => assertExplicitKeys(['quoter', 'settler'], false, only({ DEPLOYER_PK: 'x' }))).toThrow(/QUOTER_PK and SETTLER_PK/);
    expect(() => assertExplicitKeys(['quoter', 'settler'], false, only({ QUOTER_PK: 'x', DEPLOYER_PK: 'x' }))).toThrow(/set SETTLER_PK explicitly/);
    expect(() => assertExplicitKeys(['quoter'], false, only({ QUOTER_PK: 'x' }))).not.toThrow();
    expect(() => assertExplicitKeys(['quoter', 'settler'], false, only({ QUOTER_PK: 'x', SETTLER_PK: 'y' }))).not.toThrow();
    expect(() => assertExplicitKeys(['quoter', 'settler'], true, only({}))).not.toThrow();
    expect(PRIMARY_KEY_ENV).toEqual({ quoter: 'QUOTER_PK', settler: 'SETTLER_PK' });
  });
});
