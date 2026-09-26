import type { NextRequest } from 'next/server';
import { handle } from '@/lib/server/http';
import { publicSwap } from '@/lib/server/swap';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return handle(async () => {
    const b = (await req.json()) as { pay?: string; amount?: unknown };
    const client = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
    return publicSwap({ pay: b.pay === 'quote' ? 'quote' : 'base', amount: Number(b.amount), client });
  });
}
