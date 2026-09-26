import { handle } from '@/lib/server/http';
import { getState } from '@/lib/server/live';

export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(getState);
}
