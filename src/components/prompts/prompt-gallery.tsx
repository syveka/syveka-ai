"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2, Play, Globe } from "lucide-react";
import { useRouter, usePathname } from "@/i18n/routing";
import {
  createPromptAction,
  deletePromptAction,
  renderPromptAction,
  type PromptActionState,
} from "@/actions/prompts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  "sales",
  "support",
  "marketing",
  "finance",
  "hr",
  "productivity",
  "general",
] as const;

type PromptItem = {
  id: string;
  title: string;
  description: string | null;
  content: string;
  category: string;
  isGlobal: boolean;
  usageCount: number;
  variables: Array<{ name: string; label: string }>;
};

export function PromptGallery({
  prompts,
  canWrite,
  activeCategory,
}: {
  prompts: PromptItem[];
  canWrite: boolean;
  activeCategory?: string;
}) {
  const t = useTranslations("prompts");
  const router = useRouter();
  const pathname = usePathname();
  const [using, setUsing] = useState<PromptItem | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {["", ...CATEGORIES].map((c) => (
          <button
            key={c || "all"}
            onClick={() => router.replace(c ? `${pathname}?category=${c}` : pathname)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm",
              (activeCategory ?? "") === c
                ? "border-primary bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {c ? t(`categories.${c}` as never) : t("all")}
          </button>
        ))}
        {canWrite ? (
          <Button size="sm" className="ms-auto gap-1" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t("newPrompt")}
          </Button>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {prompts.map((p) => (
          <Card key={p.id} className="flex flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-start justify-between gap-2 text-base">
                <span>{p.title}</span>
                {p.isGlobal ? <Globe className="size-4 shrink-0 text-muted-foreground" /> : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <p className="flex-1 text-sm text-muted-foreground">{p.description}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t(`categories.${p.category}` as never)} · {p.usageCount}×
                </span>
                <div className="flex gap-1">
                  {!p.isGlobal && canWrite ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() => void deletePromptAction(p.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" className="gap-1" onClick={() => setUsing(p)}>
                    <Play className="size-3" />
                    {t("use")}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {using ? <UseDialog prompt={using} onClose={() => setUsing(null)} /> : null}
      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function UseDialog({ prompt, onClose }: { prompt: PromptItem; onClose: () => void }) {
  const t = useTranslations("prompts");
  const tc = useTranslations("common");
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const { rendered } = await renderPromptAction(prompt.id, values);
      sessionStorage.setItem("chat:draft", rendered);
      router.push("/chat");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{prompt.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {prompt.variables.map((v) => (
            <div key={v.name} className="space-y-1.5">
              <Label htmlFor={v.name}>{v.label}</Label>
              <Input
                id={v.name}
                value={values[v.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
              />
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button onClick={() => void run()} disabled={busy}>
              {busy ? tc("loading") : t("openInChat")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </Overlay>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("prompts");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<PromptActionState, FormData>(async (prev, fd) => {
    const result = await createPromptAction(prev, fd);
    if (result.message === "created") onClose();
    return result;
  }, {});

  return (
    <Overlay onClose={onClose}>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t("newPrompt")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="title">{t("fields.title")}</Label>
              <Input id="title" name="title" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="description">{t("fields.description")}</Label>
              <Input id="description" name="description" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="category">{t("fields.category")}</Label>
              <select
                id="category"
                name="category"
                defaultValue="general"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`categories.${c}` as never)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="content">{t("fields.content")}</Label>
              <textarea
                id="content"
                name="content"
                rows={6}
                required
                placeholder={t("contentPlaceholder")}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">{t("variableHint")}</p>
            </div>
            {state.error ? <p className="text-sm text-destructive">{tc("error")}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? tc("loading") : tc("create")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
    >
      {children}
    </div>
  );
}
