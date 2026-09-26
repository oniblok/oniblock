import type { NextRequest } from 'next/server';
import { handle } from '@/lib/server/http';
import { getHistory } from '@/lib/server/live';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const int = (k: string) => (q.get(k) ? Math.max(1, Math.min(5000, Number(q.get(k)))) : undefined);
  return handle(() => getHistory({ blocks: int('blocks'), regimeBlocks: int('regime'), points: int('points') }));
}
