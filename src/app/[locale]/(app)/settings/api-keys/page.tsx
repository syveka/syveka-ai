import { requirePermission } from "@/server/auth/guard";
import { listApiKeys } from "@/server/services/api-keys";
import { ApiKeysManager } from "./api-keys-manager";

export default async function ApiKeysPage() {
  const ctx = await requirePermission("api-keys:manage");
  const keys = await listApiKeys(ctx);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Server-to-server access to the Syveka API. Keys are shown once — store them securely.
        </p>
      </div>
      <ApiKeysManager
        keys={keys.map((k) => ({
          ...k,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
