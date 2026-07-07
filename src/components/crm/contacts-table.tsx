"use client";

import { useTranslations } from "next-intl";
import { useRouter, usePathname } from "@/i18n/routing";
import { useSearchParams } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Link } from "@/i18n/routing";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { deleteContactAction } from "@/actions/contacts";
import { cn } from "@/lib/utils";

type Row = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  company: string | null;
  tags: Array<{ name: string; color: string }>;
};

const STATUS_STYLE: Record<string, string> = {
  LEAD: "bg-primary/10 text-primary",
  PROSPECT: "bg-warning/15 text-warning",
  CUSTOMER: "bg-success/15 text-success",
  CHURNED: "bg-destructive/15 text-destructive",
  ARCHIVED: "bg-muted text-muted-foreground",
};

export function ContactsTable({
  contacts,
  nextCursor,
  canDelete,
}: {
  contacts: Row[];
  nextCursor?: string;
  canDelete: boolean;
}) {
  const t = useTranslations("crm");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const setParam = (key: string, value?: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("cursor");
    router.replace(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          placeholder={t("searchPlaceholder")}
          defaultValue={params.get("q") ?? ""}
          className="max-w-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") setParam("q", e.currentTarget.value || undefined);
          }}
        />
        <select
          defaultValue={params.get("status") ?? ""}
          onChange={(e) => setParam("status", e.target.value || undefined)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
        >
          <option value="">{t("allStatuses")}</option>
          {Object.keys(STATUS_STYLE).map((s) => (
            <option key={s} value={s}>
              {t(`statuses.${s}` as never)}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <CardContent className="divide-y p-0">
          {contacts.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{t("noContacts")}</p>
          ) : (
            contacts.map((c) => (
              <div key={c.id} className="flex items-center gap-3 p-4">
                <Link href={`/crm/contacts/${c.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium hover:underline">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[c.company, c.email, c.phone].filter(Boolean).join(" · ")}
                  </p>
                </Link>
                <div className="hidden gap-1 sm:flex">
                  {c.tags.map((tag) => (
                    <span
                      key={tag.name}
                      className="rounded-full px-2 py-0.5 text-xs"
                      style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
                <span
                  className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLE[c.status])}
                >
                  {t(`statuses.${c.status}` as never)}
                </span>
                {canDelete ? (
                  <form action={deleteContactAction.bind(null, c.id)}>
                    <Button variant="ghost" size="icon" type="submit" className="text-destructive">
                      <Trash2 className="size-4" />
                    </Button>
                  </form>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setParamRaw(router, pathname, params, nextCursor)}>
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function setParamRaw(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  params: URLSearchParams,
  cursor: string,
) {
  const next = new URLSearchParams(params.toString());
  next.set("cursor", cursor);
  router.replace(`${pathname}?${next.toString()}`);
}
