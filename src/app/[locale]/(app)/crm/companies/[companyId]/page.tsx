export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getCompany } from "@/server/services/companies";
import {
  addCompanyNoteAction,
  archiveCompanyAction,
  deleteCompanyAction,
  restoreCompanyAction,
} from "@/actions/companies";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyDialog } from "@/components/crm/company-dialog";
import { EntityActions } from "@/components/crm/entity-actions";
import { NoteComposer } from "@/components/crm/note-composer";
import { formatCents, formatDate } from "@/lib/utils";
import { Link } from "@/i18n/routing";

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const locale = await getLocale();
  const canWrite = can(ctx.role, "crm:write");
  const canDelete = can(ctx.role, "crm:delete");

  const company = await getCompany(ctx, companyId);
  if (!company) notFound();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/crm/companies" className="text-sm text-muted-foreground hover:underline">
            ← {t("companies")}
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{company.name}</h1>
            {company.archivedAt ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t("archivedBadge")}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {[company.domain, company.industry, company.size].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite ? (
            <CompanyDialog
              mode="edit"
              company={{
                id: company.id,
                name: company.name,
                domain: company.domain,
                industry: company.industry,
                size: company.size,
                website: company.website,
                businessId: company.businessId,
              }}
            />
          ) : null}
          <EntityActions
            archived={company.archivedAt !== null}
            canWrite={canWrite}
            canDelete={canDelete}
            archiveAction={archiveCompanyAction.bind(null, company.id)}
            restoreAction={restoreCompanyAction.bind(null, company.id)}
            deleteAction={deleteCompanyAction.bind(null, company.id)}
            afterDeleteHref="/crm/companies"
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("about")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("companyFields.website")}</span>
                {company.website ? (
                  <a
                    href={company.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate hover:underline"
                  >
                    {company.website}
                  </a>
                ) : (
                  <span>—</span>
                )}
              </div>
              <InfoRow label={t("companyFields.domain")} value={company.domain} />
              <InfoRow label={t("companyFields.industry")} value={company.industry} />
              <InfoRow label={t("companyFields.size")} value={company.size} />
              <InfoRow label={t("companyFields.businessId")} value={company.businessId} />
              <InfoRow
                label={t("createdLabel")}
                value={formatDate(company.createdAt, locale, { dateStyle: "medium" })}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("contacts")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {company.contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noContacts")}</p>
              ) : (
                company.contacts.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <Link
                      href={`/crm/contacts/${c.id}`}
                      className="min-w-0 truncate hover:underline"
                    >
                      {[c.firstName, c.lastName].filter(Boolean).join(" ")}
                    </Link>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {[c.title, c.email].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("deals")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {company.deals.length === 0 ? (
                <p className="text-sm text-muted-foreground">—</p>
              ) : (
                company.deals.map((d) => (
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
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("timeline")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canWrite ? (
              <NoteComposer action={addCompanyNoteAction.bind(null, company.id)} />
            ) : null}
            {company.activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noActivities")}</p>
            ) : (
              <div className="space-y-3">
                {company.activities.map((a) => (
                  <div key={a.id} className="border-s-2 border-border ps-3">
                    <p className="text-sm font-medium">{a.subject}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(`activityTypes.${a.type}` as never)} ·{" "}
                      {formatDate(a.createdAt, locale, { dateStyle: "medium", timeStyle: "short" })}
                      {a.user?.fullName ? <> · {a.user.fullName}</> : null}
                      {a.contact ? (
                        <>
                          {" · "}
                          <Link href={`/crm/contacts/${a.contact.id}`} className="hover:underline">
                            {[a.contact.firstName, a.contact.lastName].filter(Boolean).join(" ")}
                          </Link>
                        </>
                      ) : null}
                    </p>
                    {a.body && a.body !== a.subject ? (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                        {a.body}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-end">{value || "—"}</span>
    </div>
  );
}
