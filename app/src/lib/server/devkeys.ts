/**
 * Anvil default dev accounts (mnemonic "test test ... junk"): PUBLIC, well-known keys, valid only on
 * local anvil / anvil forks. Used exclusively by server-side /api/dev/* routes when the selected chain is a
 * dev chain; never shipped to the browser. Roles match services/src/config.ts + DeployLocal.s.sol:
 * 0 deployer/owner, 1 quoter, 2 settler, 3 attestor, 4 arb bot, 5 retail bot, 6 backup quoter, 7 demo swapper.
 */
import 'server-only';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
];

export type DevRole = 'owner' | 'quoter' | 'settler' | 'attestor' | 'arb' | 'retail' | 'backupQuoter' | 'swapper';
const IDX: Record<DevRole, number> = { owner: 0, quoter: 1, settler: 2, attestor: 3, arb: 4, retail: 5, backupQuoter: 6, swapper: 7 };

export function devAccount(role: DevRole) {
  return privateKeyToAccount(ANVIL_KEYS[IDX[role]]!);
}

/** Address of the backup quoter (anvil #6 unless BACKUP_QUOTER overrides) — must match the keeper. */
export function backupQuoterAddress() {
  return (process.env.BACKUP_QUOTER as Hex | undefined) ?? devAccount('backupQuoter').address;
}
