import type { Hex } from 'viem';
import { handle } from '@/lib/server/http';
import { getReceiptPage } from '@/lib/server/receipt';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ tx: string }> }) {
  const { tx } = await ctx.params;
  return handle(async () => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error('invalid tx hash');
    return getReceiptPage(tx as Hex);
  });
}
