export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";

/**
 * API keys are not offered to customers yet: no public Syveka API accepts
 * them (`resolveApiKey` in src/server/services/api-keys.ts has no callers),
 * so the page would promise access that doesn't exist. The page is not found
 * for every user; it isn't linked anywhere (see settings-nav-items.ts).
 *
 * Kept intact for when the public API ships: the ApiKey model and any stored
 * (hashed) keys, the service, the `api-keys:manage` permission, and
 * ./api-keys-manager.tsx with src/actions/api-keys.ts (unreferenced while
 * this page is disabled). Restore the page body from git history then.
 */
export default function ApiKeysPage(): never {
  notFound();
}
