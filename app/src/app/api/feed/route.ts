import type { NextRequest } from 'next/server';
import { getFeed } from '@/lib/server/feed';
import { handle } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const rows = Number(req.nextUrl.searchParams.get('rows') ?? 60);
  return handle(() => getFeed({ rows: Math.max(1, Math.min(200, rows || 60)) }));
}
