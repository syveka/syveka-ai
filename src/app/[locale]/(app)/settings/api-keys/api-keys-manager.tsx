"use client";

import { useState, useTransition } from "react";
import { Copy, Trash2 } from "lucide-react";
import { createApiKeyAction, revokeApiKeyAction } from "@/actions/api-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

const SCOPES = [
  "crm:read",
  "crm:write",
  "chat:write",
  "kb:read",
  "kb:write",
  "calendar:read",
  "calendar:write",
  "analytics:read",
];

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
};

export function ApiKeysManager({ keys }: { keys: KeyRow[] }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["crm:read"]);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const create = () =>
    startTransition(async () => {
      setError(null);
      const res = await createApiKeyAction({ name, scopes });
      if (res.error) setError(res.error);
      else {
        setPlaintext(res.plaintext ?? null);
        setName("");
      }
    });

  return (
    <div className="space-y-4">
      {plaintext ? (
        <Card className="border-warning/50">
          <CardContent className="space-y-2 pt-6">
            <p className="text-sm font-medium">Copy your key now. It will not be shown again:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">{plaintext}</code>
              <Button
                size="icon"
                variant="outline"
                onClick={() => void navigator.clipboard.writeText(plaintext)}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Key name (e.g. ERP integration)"
              className="max-w-xs"
            />
            <Button onClick={create} disabled={pending || !name || scopes.length === 0}>
              Create key
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={(e) =>
                    setScopes((prev) =>
                      e.target.checked ? [...prev, s] : prev.filter((x) => x !== s),
                    )
                  }
                  className="size-4"
                />
                <code className="text-xs">{s}</code>
              </label>
            ))}
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="divide-y p-0">
          {keys.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No API keys.</p>
          ) : (
            keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{k.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {k.prefix}... · {k.scopes.join(", ")} ·{" "}
                    {k.lastUsedAt ? `last used ${k.lastUsedAt.slice(0, 10)}` : "never used"}
                  </p>
                </div>
                <form action={revokeApiKeyAction.bind(null, k.id)}>
                  <Button variant="ghost" size="icon" type="submit" className="text-destructive">
                    <Trash2 className="size-4" />
                  </Button>
                </form>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
