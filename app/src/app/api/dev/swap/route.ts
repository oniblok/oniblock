import { assertDevRequest, devJson, devSwap, type SwapReq } from '@/lib/server/dev';
import { handle } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(async () => {
    assertDevRequest(req, { write: true });
    const b = await devJson<Partial<SwapReq>>(req);
    return devSwap({
      direction: b.direction === 'reverse' ? 'reverse' : 'arb',
      size: Number(b.size),
      target: b.target === 'oniblock' || b.target === 'vanilla' ? b.target : 'both',
    });
  });
}
