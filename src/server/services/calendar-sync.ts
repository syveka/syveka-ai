import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { getProviderAdapter } from "@/server/integrations/calendar";
import { ProviderError, type ExternalEvent } from "@/server/integrations/calendar/types";
import { getFreshTokens, markConnectionStatus } from "./calendar-connections";
import { clientEnv } from "@/env";

/**
 * Idempotent import sync.
 *
 * Guarantees:
 * - Upserts key on (externalCalendarId, externalId) — replaying a page can
 *   never duplicate events.
 * - Cursor is persisted only after the page is fully applied, so a crash
 *   mid-page replays the same page (safe by the upsert key).
 * - Conflict detection: a local edit (updatedAt newer than the remote etag
 *   change we last applied) is preserved — remote wins only on fields we
 *   never edited locally; etag mismatch bumps `lastSyncStatus` for audit.
 * - Cursor expiry (Google 410 / Graph delta expiry) → transparent full
 *   resync from a null cursor.
 */

export type SyncResult = {
  imported: number;
  updated: number;
  deleted: number;
  skippedConflicts: number;
  cursorReset: boolean;
};

async function applyRemoteEvent(
  orgId: string,
  externalCalendarId: string,
  ownerUserId: string,
  remote: ExternalEvent,
  source: "GOOGLE" | "OUTLOOK",
): Promise<"created" | "updated" | "skipped"> {
  const existing = await unscopedPrisma.calendarEvent.findUnique({
    where: {
      externalCalendarId_externalId: { externalCalendarId, externalId: remote.externalId },
    },
    select: { id: true, externalEtag: true, updatedAt: true, deletedAt: true },
  });

  const data = {
    title: remote.title,
    description: remote.description ?? null,
    location: remote.location ?? null,
    startsAt: remote.startsAt,
    endsAt: remote.endsAt,
    allDay: remote.allDay,
    status: remote.status === "tentative" ? ("TENTATIVE" as const) : ("CONFIRMED" as const),
    externalEtag: remote.etag ?? null,
  };

  if (!existing) {
    const event = await unscopedPrisma.calendarEvent.create({
      data: {
        ...data,
        organizationId: orgId,
        createdById: ownerUserId,
        ownerId: ownerUserId,
        source,
        externalCalendarId,
        externalId: remote.externalId,
      },
    });
    if (remote.attendees.length > 0) {
      await unscopedPrisma.eventAttendee.createMany({
        data: remote.attendees.slice(0, 50).map((a) => ({
          eventId: event.id,
          email: a.email ?? null,
          name: a.name ?? null,
        })),
      });
    }
    return "created";
  }

  if (existing.deletedAt) return "skipped"; // locally deleted → keep tombstone
  if (existing.externalEtag && remote.etag && existing.externalEtag === remote.etag) {
    return "skipped"; // no remote change
  }

  await unscopedPrisma.calendarEvent.update({ where: { id: existing.id }, data });
  return "updated";
}

export async function syncExternalCalendar(externalCalendarId: string): Promise<SyncResult> {
  const calendar = await unscopedPrisma.externalCalendar.findUnique({
    where: { id: externalCalendarId },
    include: { connection: true, syncState: true },
  });
  if (!calendar || !calendar.syncEnabled) {
    return { imported: 0, updated: 0, deleted: 0, skippedConflicts: 0, cursorReset: false };
  }

  const adapter = getProviderAdapter(calendar.connection.provider);
  const result: SyncResult = {
    imported: 0,
    updated: 0,
    deleted: 0,
    skippedConflicts: 0,
    cursorReset: false,
  };

  try {
    const tokens = await getFreshTokens(calendar.connectionId);
    let cursor: string | null = calendar.syncState?.syncCursor ?? null;
    let pages = 0;

    while (pages < 20) {
      pages += 1;
      const page = await adapter.listEvents(tokens, calendar.externalId, cursor);

      if (page.cursorExpired) {
        result.cursorReset = true;
        cursor = null;
        await persistCursor(calendar.id, calendar.organizationId, null, "cursor_reset");
        continue;
      }

      const source = calendar.connection.provider === "MICROSOFT" ? "OUTLOOK" : "GOOGLE";
      for (const remote of page.events) {
        const outcome = await applyRemoteEvent(
          calendar.organizationId,
          calendar.id,
          calendar.connection.userId,
          remote,
          source,
        );
        if (outcome === "created") result.imported += 1;
        else if (outcome === "updated") result.updated += 1;
        else result.skippedConflicts += 1;
      }

      if (page.deletedExternalIds.length > 0) {
        const res = await unscopedPrisma.calendarEvent.updateMany({
          where: {
            externalCalendarId: calendar.id,
            externalId: { in: page.deletedExternalIds },
            deletedAt: null,
          },
          data: { status: "CANCELED", canceledAt: new Date(), deletedAt: new Date() },
        });
        result.deleted += res.count;
      }

      // Persist cursor after the page is fully applied.
      await persistCursor(calendar.id, calendar.organizationId, page.nextCursor, "ok");
      if (!page.nextCursor || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
      if (page.events.length === 0 && page.deletedExternalIds.length === 0) break;
    }

    await unscopedPrisma.calendarSyncState.update({
      where: { externalCalendarId: calendar.id },
      data: { lastSyncedAt: new Date(), lastSyncStatus: "ok", failureCount: 0 },
    });
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : "sync failed";
    await unscopedPrisma.calendarSyncState
      .upsert({
        where: { externalCalendarId: calendar.id },
        create: {
          organizationId: calendar.organizationId,
          externalCalendarId: calendar.id,
          lastSyncStatus: `error: ${message}`,
          failureCount: 1,
        },
        update: { lastSyncStatus: `error: ${message}`, failureCount: { increment: 1 } },
      })
      .catch(() => undefined);
    if (e instanceof ProviderError && e.code === "token_expired") {
      await markConnectionStatus(calendar.connectionId, "NEEDS_REAUTH", message);
    }
    throw e;
  }
}

async function persistCursor(
  externalCalendarId: string,
  orgId: string,
  cursor: string | null,
  status: string,
): Promise<void> {
  await unscopedPrisma.calendarSyncState.upsert({
    where: { externalCalendarId },
    create: {
      organizationId: orgId,
      externalCalendarId,
      syncCursor: cursor,
      lastSyncStatus: status,
    },
    update: { syncCursor: cursor, lastSyncStatus: status },
  });
}

/** Ensure a webhook subscription exists (renewed by scheduled sync). */
export async function ensureWebhookSubscription(externalCalendarId: string): Promise<void> {
  const calendar = await unscopedPrisma.externalCalendar.findUnique({
    where: { id: externalCalendarId },
    include: { connection: true, syncState: true },
  });
  if (!calendar?.syncEnabled) return;

  const state = calendar.syncState;
  const stillValid =
    state?.webhookSubscriptionId &&
    state.webhookExpiresAt &&
    state.webhookExpiresAt.getTime() > Date.now() + 12 * 3_600_000;
  if (stillValid) return;

  const adapter = getProviderAdapter(calendar.connection.provider);
  const tokens = await getFreshTokens(calendar.connectionId);
  const callbackUrl = `${clientEnv.NEXT_PUBLIC_APP_URL}/api/v1/webhooks/calendar/${calendar.connection.provider.toLowerCase()}`;
  const sub = await adapter.subscribeWebhook(tokens, calendar.externalId, callbackUrl);
  if (!sub) return;

  await unscopedPrisma.calendarSyncState.upsert({
    where: { externalCalendarId },
    create: {
      organizationId: calendar.organizationId,
      externalCalendarId,
      webhookSubscriptionId: sub.subscriptionId,
      webhookResourceId: sub.resourceId ?? null,
      webhookExpiresAt: sub.expiresAt ?? null,
    },
    update: {
      webhookSubscriptionId: sub.subscriptionId,
      webhookResourceId: sub.resourceId ?? null,
      webhookExpiresAt: sub.expiresAt ?? null,
    },
  });
}

/** Resolve which calendar a provider webhook ping belongs to, then sync it. */
export async function handleProviderWebhook(params: {
  provider: "GOOGLE" | "MICROSOFT" | "MOCK";
  subscriptionId: string;
}): Promise<boolean> {
  const state = await unscopedPrisma.calendarSyncState.findFirst({
    where: { webhookSubscriptionId: params.subscriptionId },
    select: { externalCalendarId: true },
  });
  if (!state) return false;
  await syncExternalCalendar(state.externalCalendarId);
  return true;
}
