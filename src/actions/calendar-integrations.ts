"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CalendarProvider } from "@prisma/client";
import { requirePermission } from "@/server/auth/guard";
import {
  checkConnectionHealth,
  ConnectionError,
  disconnectConnection,
  setCalendarSyncEnabled,
  startConnectionUrl,
} from "@/server/services/calendar-connections";
import { ensureWebhookSubscription, syncExternalCalendar } from "@/server/services/calendar-sync";

export type IntegrationActionState = { error?: string; message?: string };

const PROVIDERS = new Set<CalendarProvider>(["GOOGLE", "MICROSOFT", "MOCK"]);

export async function connectCalendarAction(provider: string): Promise<IntegrationActionState> {
  const ctx = await requirePermission("integrations:manage");
  const p = provider.toUpperCase() as CalendarProvider;
  if (!PROVIDERS.has(p)) return { error: "invalid_provider" };

  let url: string;
  try {
    url = startConnectionUrl(ctx, p);
  } catch (e) {
    if (e instanceof ConnectionError) return { error: e.code };
    return { error: "failed" };
  }
  redirect(url);
}

export async function disconnectCalendarAction(
  connectionId: string,
): Promise<IntegrationActionState> {
  const ctx = await requirePermission("integrations:manage");
  try {
    await disconnectConnection(ctx, connectionId);
  } catch (e) {
    if (e instanceof ConnectionError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/settings/integrations");
  return { message: "disconnected" };
}

export async function toggleCalendarSyncAction(
  externalCalendarId: string,
  enabled: boolean,
): Promise<IntegrationActionState> {
  const ctx = await requirePermission("integrations:manage");
  try {
    await setCalendarSyncEnabled(ctx, externalCalendarId, enabled);
    if (enabled) {
      await syncExternalCalendar(externalCalendarId).catch(() => undefined);
      await ensureWebhookSubscription(externalCalendarId).catch(() => undefined);
    }
  } catch (e) {
    if (e instanceof ConnectionError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/settings/integrations");
  return { message: enabled ? "sync_enabled" : "sync_disabled" };
}

export async function checkConnectionHealthAction(
  connectionId: string,
): Promise<IntegrationActionState> {
  const ctx = await requirePermission("integrations:manage");
  try {
    const result = await checkConnectionHealth(ctx, connectionId);
    revalidatePath("/settings/integrations");
    return { message: result.status };
  } catch (e) {
    if (e instanceof ConnectionError) return { error: e.code };
    return { error: "failed" };
  }
}

export async function syncNowAction(externalCalendarId: string): Promise<IntegrationActionState> {
  const ctx = await requirePermission("integrations:manage");
  // Tenant check: the service verifies the calendar belongs to this org+user
  // through setCalendarSyncEnabled-style lookup; do a scoped existence check.
  const { tenantDb } = await import("@/server/db/tenant");
  const db = tenantDb(ctx.orgId);
  const calendar = await db.externalCalendar.findFirst({
    where: { id: externalCalendarId, connection: { userId: ctx.userId } },
    select: { id: true },
  });
  if (!calendar) return { error: "not_found" };

  try {
    const result = await syncExternalCalendar(externalCalendarId);
    revalidatePath("/settings/integrations");
    revalidatePath("/calendar");
    return { message: `synced:${result.imported + result.updated}` };
  } catch {
    return { error: "sync_failed" };
  }
}
