import { handle } from '@/lib/server/http';
import { getEnsNamespace } from '@/lib/server/ens';

export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(getEnsNamespace);
}
