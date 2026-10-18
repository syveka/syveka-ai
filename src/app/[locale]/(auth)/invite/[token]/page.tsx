export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSessionUser } from "@/server/auth/session";
import { unscopedPrisma } from "@/server/db/tenant";
import { acceptInvitationAction } from "@/actions/members";
import { signOutToInvitationAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { localizedPath, normalizeLocale } from "@/lib/auth-redirect";
import { parseInvitationAcceptError } from "@/lib/invitation-errors";

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { locale, token } = await params;
  const t = await getTranslations("invite");

  // An acceptance that failed for an expected reason comes back here with a
  // fixed code (acceptInvitationAction). Only an allowlisted code is shown,
  // and the message says nothing about the organization, its plan or seats.
  const acceptError = parseInvitationAcceptError((await searchParams).error);
  if (acceptError) {
    return (
      <Card>
        <CardContent className="space-y-4 pt-6 text-center text-sm">
          <p role="alert">{t(`errors.${acceptError}`)}</p>
          {acceptError === "already_member" ? (
            <Button asChild className="w-full">
              <a href={localizedPath(normalizeLocale(locale), "/dashboard")}>
                {t("goToDashboard")}
              </a>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const invitation = await unscopedPrisma.invitation.findUnique({
    where: { token },
    include: { organization: { select: { name: true } } },
  });

  if (!invitation || invitation.status !== "PENDING" || invitation.expiresAt < new Date()) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-sm">{t("invalid")}</CardContent>
      </Card>
    );
  }

  const user = await getSessionUser();
  if (!user) {
    // Register (or sign in from there) first, then come back here (§11.3)
    const next = encodeURIComponent(`/invite/${invitation.token}`);
    redirect(`${localizedPath(normalizeLocale(locale), "/register")}?next=${next}`);
  }

  const signOut = signOutToInvitationAction.bind(null, invitation.token, locale);
  const tRoles = await getTranslations("roles");
  // Email addresses keep their own direction inside right-to-left text.
  const b = (chunks: React.ReactNode) => <strong dir="auto">{chunks}</strong>;

  // Only the invited address can accept (acceptInvitation); offering Accept to
  // anyone else ended on an error page.
  if (user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title", { organization: invitation.organization.name })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t.rich("otherAccount", { invited: invitation.email, current: user.email ?? "", b })}
          </p>
          <form action={signOut}>
            <Button type="submit" className="w-full">
              {t("signOutAndContinue")}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title", { organization: invitation.organization.name })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t.rich("invitedAs", { role: tRoles(invitation.role), email: invitation.email, b })}
        </p>
        <form action={acceptInvitationAction.bind(null, invitation.token, locale)}>
          <Button type="submit" className="w-full">
            {t("accept")}
          </Button>
        </form>
        <form action={signOut} className="text-center text-xs text-muted-foreground">
          {t("wrongAccount")}{" "}
          <Button type="submit" variant="link" className="h-auto p-0 text-xs">
            {t("switchAccount")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
