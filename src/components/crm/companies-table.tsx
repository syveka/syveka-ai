"use client";

import { useTranslations } from "next-intl";
import { useRouter, usePathname } from "@/i18n/routing";
import { useSearchParams } from "next/navigation";
import { Building2, Trash2 } from "lucide-react";
import { Link } from "@/i18n/routing";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { deleteCompanyAction } from "@/actions/companies";

type Row = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  contactCount: number;
  dealCount: number;
  archived: boolean;
};

const ARCHIVED_FILTERS = ["active", "archived", "all"] as const;

export function CompaniesTable({
  companies,
  nextCursor,
  canDelete,
}: {
  companies: Row[];
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

  const loadMore = (cursor: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("cursor", cursor);
    router.replace(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder={t("searchCompaniesPlaceholder")}
          defaultValue={params.get("q") ?? ""}
          className="max-w-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") setParam("q", e.currentTarget.value || undefined);
          }}
        />
        <select
          defaultValue={params.get("archived") ?? "active"}
          onChange={(e) =>
            setParam("archived", e.target.value === "active" ? undefined : e.target.value)
          }
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {ARCHIVED_FILTERS.map((f) => (
            <option key={f} value={f}>
              {t(`archivedFilter.${f}` as never)}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <CardContent className="divide-y p-0">
          {companies.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{t("noCompanies")}</p>
          ) : (
            companies.map((c) => (
              <div key={c.id} className="flex items-center gap-3 p-4">
                <Building2 className="size-4 shrink-0 text-muted-foreground" />
                <Link href={`/crm/companies/${c.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium hover:underline">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[c.domain, c.industry].filter(Boolean).join(" · ")}
                  </p>
                </Link>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {t("contactCount", { count: c.contactCount })}
                </span>
                <span className="hidden text-xs text-muted-foreground md:inline">
                  {t("dealCount", { count: c.dealCount })}
                </span>
                {c.archived ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {t("archivedBadge")}
                  </span>
                ) : null}
                {canDelete ? (
                  <form action={deleteCompanyAction.bind(null, c.id)}>
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
          <Button variant="outline" onClick={() => loadMore(nextCursor)}>
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
