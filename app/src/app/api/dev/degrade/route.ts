import { devCtx, devDegrade } from '@/lib/server/dev';
import { readFlags } from '@/lib/server/flags';
import { handle } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => {
    await devCtx();
    return readFlags();
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const b = (await req.json()) as { degraded?: boolean };
    return devDegrade(!!b.degraded);
  });
}
