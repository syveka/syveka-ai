export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { getContact } from "@/server/services/contacts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents, formatDate } from "@/lib/utils";
import { Link } from "@/i18n/routing";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const locale = await getLocale();

  const contact = await getContact(ctx, contactId);
  if (!contact) notFound();

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");

  return (
    <div className="space-y-6">
      <div>
        <Link href="/crm/contacts" className="text-sm text-muted-foreground hover:underline">
          ← {t("contacts")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{name}</h1>
        <p className="text-sm text-muted-foreground">
          {[contact.title, contact.company?.name, contact.email, contact.phone]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("deals")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {contact.deals.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              contact.deals.map((d) => (
                <div key={d.id} className="flex items-center justify-between text-sm">
                  <span>{d.title}</span>
                  <span className="text-muted-foreground">
                    {d.stage.name} · {formatCents(d.valueCents, locale)}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("timeline")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {contact.activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              contact.activities.map((a) => (
                <div key={a.id} className="border-s-2 border-border ps-3">
                  <p className="text-sm font-medium">{a.subject}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.type} ·{" "}
                    {formatDate(a.createdAt, locale, { dateStyle: "medium", timeStyle: "short" })}
                  </p>
                  {a.body ? <p className="mt-1 text-sm text-muted-foreground">{a.body}</p> : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
