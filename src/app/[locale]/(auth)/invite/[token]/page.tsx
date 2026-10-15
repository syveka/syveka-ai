export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { unscopedPrisma } from "@/server/db/tenant";
import { acceptInvitationAction } from "@/actions/members";
import { signOutToInvitationAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { localizedPath, normalizeLocale } from "@/lib/auth-redirect";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;

  const invitation = await unscopedPrisma.invitation.findUnique({
    where: { token },
    include: { organization: { select: { name: true } } },
  });

  if (!invitation || invitation.status !== "PENDING" || invitation.expiresAt < new Date()) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-sm">
          This invitation is invalid or has expired.
        </CardContent>
      </Card>
    );
  }

  const user = await getSessionUser();
  if (!user) {
    // Register (or sign in from there) first, then come back here (§11.3)
    const next = encodeURIComponent(`/invite/${invitation.token}`);
    redirect(`${localizedPath(normalizeLocale(locale), "/register")}?next=${next}`);
  }

  const signOut = signOutToInvitationAction.bind(null, invitation.token);

  // Only the invited address can accept (acceptInvitation); offering Accept to
  // anyone else ended on an error page.
  if (user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Join {invitation.organization.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This invitation was sent to <strong>{invitation.email}</strong>, but you are signed in
            as <strong>{user.email}</strong>. Sign out, then sign in or register with the invited
            address to accept it.
          </p>
          <form action={signOut}>
            <Button type="submit" className="w-full">
              Sign out and continue
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join {invitation.organization.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          You were invited as <strong>{invitation.role}</strong> ({invitation.email}).
        </p>
        <form action={acceptInvitationAction.bind(null, token)}>
          <Button type="submit" className="w-full">
            Accept invitation
          </Button>
        </form>
        <form action={signOut} className="text-center text-xs text-muted-foreground">
          Wrong account?{" "}
          <Button type="submit" variant="link" className="h-auto p-0 text-xs">
            Switch account
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
