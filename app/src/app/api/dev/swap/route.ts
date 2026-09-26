import { devSwap, type SwapReq } from '@/lib/server/dev';
import { handle } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(async () => {
    const b = (await req.json()) as Partial<SwapReq>;
    return devSwap({
      direction: b.direction === 'reverse' ? 'reverse' : 'arb',
      size: Number(b.size),
      target: b.target === 'oniblock' || b.target === 'vanilla' ? b.target : 'both',
    });
  });
}
