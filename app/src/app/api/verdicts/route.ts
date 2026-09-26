import type { NextRequest } from 'next/server';
import { handle } from '@/lib/server/http';
import { readVerdicts } from '@/lib/server/verdicts';

export const dynamic = 'force-dynamic';

/** GET /api/verdicts?limit=N — latest N (default 50, max 5000) v6 model verdicts, newest first; [] when the keeper has not written any. */
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 50);
  return handle(async () => readVerdicts(Number.isFinite(limit) ? limit : 50));
}
