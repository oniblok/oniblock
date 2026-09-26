import { assertDevRequest, devJson, devQuoter, DevError, type QuoterAction } from '@/lib/server/dev';
import { handle } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(async () => {
    assertDevRequest(req, { write: true });
    const b = await devJson<{ action?: QuoterAction }>(req);
    if (!b.action || !['revoke', 'grant-backup', 'restore'].includes(b.action)) throw new DevError('action must be revoke | grant-backup | restore');
    return devQuoter(b.action);
  });
}
