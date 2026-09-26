import { assertDevRequest, devCtx, devDegrade, devJson } from '@/lib/server/dev';
import { readFlags } from '@/lib/server/flags';
import { handle } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(async () => {
    assertDevRequest(req, { write: false });
    await devCtx();
    return readFlags();
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    assertDevRequest(req, { write: true });
    const b = await devJson<{ degraded?: boolean }>(req);
    return devDegrade(!!b.degraded);
  });
}
