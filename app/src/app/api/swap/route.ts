import type { NextRequest } from 'next/server';
import { handle } from '@/lib/server/http';
import { publicSwap, SwapError } from '@/lib/server/swap';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return handle(async () => {
    let b: { pay?: unknown; amount?: unknown };
    try {
      b = (await req.json()) as { pay?: unknown; amount?: unknown };
    } catch {
      throw new SwapError('invalid JSON body');
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SwapError('body must be a JSON object');
    if (b.pay !== 'base' && b.pay !== 'quote') throw new SwapError("pay must be 'base' or 'quote'");
    const client = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
    return publicSwap({ pay: b.pay, amount: Number(b.amount), client });
  });
}
