import { handle } from '@/lib/server/http';
import { getModels } from '@/lib/server/models';

export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(getModels);
}
