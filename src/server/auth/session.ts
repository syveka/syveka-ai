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

/**
 * TEMPORARY staging-only diagnostic logging for the BLOCKER A session
 * investigation (2026-08-27). Event name + safe metadata only — never
 * cookie values, tokens, email, or headers. Self-contained per file so
 * each can be reverted independently. Remove after root cause is proven.
 */
function logAuthEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ diag: "session", event, ...fields }));
}

/** Raw session user or null. Cached per request. */
export const getSessionUser = cache(async () => {
  logAuthEvent("get_session_user_started");
  const supabase = await createSupabaseServer();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    logAuthEvent("supabase_get_user_failure", {
      code: error.code ?? null,
      status: error.status ?? null,
      name: error.name,
    });
  } else if (!user) {
    logAuthEvent("session_user_missing");
  } else {
    logAuthEvent("supabase_get_user_success");
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
  if (!user) {
    logAuthEvent("tenant_context_auth_failure");
    throw new AuthError("Not authenticated", 401);
  }

  const claimOrg = (user.app_metadata?.last_active_org ?? null) as string | null;

  const membership = await prisma.organizationMember.findFirst({
    where: { userId: user.id, ...(claimOrg ? { organizationId: claimOrg } : {}) },
    orderBy: { joinedAt: "asc" },
    include: { organization: { select: { defaultLocale: true, deletedAt: true } } },
  });

  if (!membership || membership.organization.deletedAt) {
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
  } catch {
    return null;
  }
}
