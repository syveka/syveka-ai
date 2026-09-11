import "server-only";

import { cache } from "react";
import type { Role } from "@prisma/client";
import { createSupabaseServer } from "@/server/supabase/server";
import { prisma } from "@/server/db/prisma";

export type TenantContext = {
  userId: string;
  email: string;
  orgId: string;
  role: Role;
  locale: string;
};

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Raw session user or null. Cached per request. */
export const getSessionUser = cache(async () => {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  // Non-sensitive: never logs tokens, cookies, or user data. A transient
  // Supabase Auth error here (network blip, rate limit, timeout) previously
  // looked identical to "genuinely no session" -- both silently returned
  // null -- making it indistinguishable downstream from a real logged-out
  // user. Same signal/rationale as middleware.ts's own getUser() logging.
  if (error) {
    console.error(
      JSON.stringify({
        event: "get_session_user_error",
        name: error.name,
        status: error.status ?? null,
      }),
    );
  }
  return user;
});

/**
 * Resolves the authenticated tenant context from JWT claims (org_id, role
 * injected by the custom access token hook — §6.3). Falls back to a membership
 * lookup for sessions issued before the user joined their first org.
 */
export const getTenantContext = cache(async (): Promise<TenantContext> => {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Not authenticated", 401);

  const claimOrg = (user.app_metadata?.last_active_org ?? null) as string | null;

  const membership = await prisma.organizationMember.findFirst({
    where: { userId: user.id, ...(claimOrg ? { organizationId: claimOrg } : {}) },
    orderBy: { joinedAt: "asc" },
    include: { organization: { select: { defaultLocale: true, deletedAt: true } } },
  });

  if (!membership || membership.organization.deletedAt) {
    // Diagnostic only -- never changes the outcome. A user reaching this
    // branch is shown /onboarding ("Create your organization") by every
    // caller (see (app)/layout.tsx), which is indistinguishable in the UI
    // from a genuinely new user, even when this is actually a live claim/
    // membership mismatch (e.g. last_active_org pointing at a membership
    // the userId->organizationId filter above can't find, or a matched
    // membership whose organization has since been soft-deleted). A cheap
    // unfiltered recount (ignoring claimOrg) tells us, from the very next
    // occurrence's logs, whether this userId has zero memberships at all
    // or has one that simply didn't match the claim/isn't deleted -- never
    // logs the claim value or any PII, only counts and booleans.
    const totalMemberships = await prisma.organizationMember.count({
      where: { userId: user.id },
    });
    console.error(
      JSON.stringify({
        event: "tenant_context_no_usable_membership",
        userId: user.id,
        hadClaimOrg: claimOrg !== null,
        matchedMembership: Boolean(membership),
        matchedMembershipOrgDeleted: Boolean(membership?.organization.deletedAt),
        totalMembershipsIgnoringClaim: totalMemberships,
      }),
    );
    throw new AuthError("No organization membership", 403);
  }

  return {
    userId: user.id,
    email: user.email ?? "",
    orgId: membership.organizationId,
    role: membership.role,
    locale: membership.organization.defaultLocale.toLowerCase(),
  };
});

/** Nullable variant for layouts that render both states. */
export async function getTenantContextOrNull(): Promise<TenantContext | null> {
  try {
    return await getTenantContext();
  } catch (error) {
    // AuthError is the expected shape (not authenticated, or no usable
    // membership -- both already diagnosed at their own throw sites above)
    // and every caller already shows /onboarding for it, same as before.
    // Anything else (e.g. a Prisma connection/timeout error) previously
    // vanished into this same silent null, making a genuine infrastructure
    // failure indistinguishable from a real new user in both the UI and the
    // logs. Never logs the error message itself -- it could echo a raw
    // connection string on some Prisma error shapes -- only its name.
    if (!(error instanceof AuthError)) {
      console.error(
        JSON.stringify({
          event: "get_tenant_context_or_null_unexpected_error",
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
    return null;
  }
}
