import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { unscopedPrisma } from "@/server/db/tenant";
import { acceptInvitationAction } from "@/actions/members";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/routing";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

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
    // Register first, then come back (§11.3)
    redirect(`/register?next=/invite/${token}`);
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
        <p className="text-center text-xs text-muted-foreground">
          Wrong account? <Link href="/login" className="text-primary hover:underline">Switch account</Link>
        </p>
      </CardContent>
    </Card>
  );
}
