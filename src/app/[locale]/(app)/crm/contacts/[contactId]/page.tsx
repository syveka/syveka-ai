export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getContact } from "@/server/services/contacts";
import { listCompanyOptions } from "@/server/services/companies";
import {
  addContactNoteAction,
  archiveContactAction,
  deleteContactAction,
  restoreContactAction,
} from "@/actions/contacts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContactDialog } from "@/components/crm/contact-dialog";
import { EntityActions } from "@/components/crm/entity-actions";
import { NoteComposer } from "@/components/crm/note-composer";
import { formatCents, formatDate } from "@/lib/utils";
import { Link } from "@/i18n/routing";
import { EntityMeetings } from "@/components/calendar/entity-meetings";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const locale = await getLocale();
  const canWrite = can(ctx.role, "crm:write");
  const canDelete = can(ctx.role, "crm:delete");

  const [contact, companies] = await Promise.all([
    getContact(ctx, contactId),
    canWrite ? listCompanyOptions(ctx) : Promise.resolve([]),
  ]);
  if (!contact) notFound();

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  const company = contact.company && !contact.company.deletedAt ? contact.company : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/crm/contacts" className="text-sm text-muted-foreground hover:underline">
            ← {t("contacts")}
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{name}</h1>
            {contact.archivedAt ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t("archivedBadge")}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {[contact.title, company?.name, contact.email, contact.phone]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite ? (
            <ContactDialog
              mode="edit"
              companies={companies}
              contact={{
                id: contact.id,
                firstName: contact.firstName,
                lastName: contact.lastName,
                email: contact.email,
                phone: contact.phone,
                title: contact.title,
                companyId: company?.id ?? null,
                status: contact.status,
              }}
            />
          ) : null}
          <EntityActions
            archived={contact.archivedAt !== null}
            canWrite={canWrite}
            canDelete={canDelete}
            archiveAction={archiveContactAction.bind(null, contact.id)}
            restoreAction={restoreContactAction.bind(null, contact.id)}
            deleteAction={deleteContactAction.bind(null, contact.id)}
            afterDeleteHref="/crm/contacts"
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
              <InfoRow label={t("fields.email")} value={contact.email} />
              <InfoRow label={t("fields.phone")} value={contact.phone} />
              <InfoRow label={t("fields.title")} value={contact.title} />
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("fields.company")}</span>
                {company ? (
                  <Link href={`/crm/companies/${company.id}`} className="hover:underline">
                    {company.name}
                  </Link>
                ) : (
                  <span>—</span>
                )}
              </div>
              <InfoRow
                label={t("fields.status")}
                value={t(`statuses.${contact.status}` as never)}
              />
              <InfoRow
                label={t("createdLabel")}
                value={formatDate(contact.createdAt, locale, { dateStyle: "medium" })}
              />
            </CardContent>
          </Card>

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
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("timeline")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canWrite ? (
              <NoteComposer action={addContactNoteAction.bind(null, contact.id)} />
            ) : null}
            {contact.activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noActivities")}</p>
            ) : (
              <div className="space-y-3">
                {contact.activities.map((a) => (
                  <div key={a.id} className="border-s-2 border-border ps-3">
                    <p className="text-sm font-medium">{a.subject}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(`activityTypes.${a.type}` as never)} ·{" "}
                      {formatDate(a.createdAt, locale, { dateStyle: "medium", timeStyle: "short" })}
                      {a.user?.fullName ? <> · {a.user.fullName}</> : null}
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

      {can(ctx.role, "calendar:read") ? <EntityMeetings ctx={ctx} contactId={contactId} /> : null}
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
