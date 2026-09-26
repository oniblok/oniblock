/** Keeper live flags file (read by services/src/keeper.ts every tick). */
import 'server-only';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KEEPER_FLAGS_FILE } from './env';

export interface KeeperFlags {
  degraded?: boolean;
  useBackupQuoter?: boolean;
}

export function readFlags(): KeeperFlags {
  try {
    return existsSync(KEEPER_FLAGS_FILE) ? (JSON.parse(readFileSync(KEEPER_FLAGS_FILE, 'utf8')) as KeeperFlags) : {};
  } catch {
    return {};
  }
}

export function writeFlags(patch: KeeperFlags): KeeperFlags {
  const next = { ...readFlags(), ...patch };
  mkdirSync(path.dirname(KEEPER_FLAGS_FILE), { recursive: true });
  writeFileSync(KEEPER_FLAGS_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}
