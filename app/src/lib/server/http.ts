import 'server-only';
import { NextResponse } from 'next/server';
import { DevError } from './dev';

/** Wrap a handler: JSON result, errors as {error} with a status (never a stack trace). */
export async function handle(fn: () => Promise<unknown>) {
  try {
    return NextResponse.json(await fn(), { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const status = e instanceof DevError ? e.status : 500;
    const msg = ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).split('\n')[0];
    return NextResponse.json({ error: msg }, { status });
  }
}
