import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { unscopedPrisma } from "@/server/db/tenant";
import { getProviderAdapter } from "@/server/integrations/calendar";
import { ProviderError, type ExternalEvent } from "@/server/integrations/calendar/types";
import { getFreshTokens, markConnectionStatus } from "./calendar-connections";
import { clientEnv } from "@/env";

/**
 * Webhook verification secret (P0.2): a fresh 32-byte value generated per subscription,
 * sent to the provider once at subscribe time (Google: watch `token`, echoed back as
 * X-Goog-Channel-Token; Microsoft: `clientState`, echoed back on every notification), and
 * never needed again afterward — only compared. Only the SHA-256 hash is ever persisted,
 * mirroring the same pattern already used for booking tokens and API keys
 * (src/server/services/booking-tokens.ts, src/server/services/api-keys.ts).
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url"); // 43 chars — well within clientState's 128
}

export function hashWebhookSecret(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Constant-time verification. Hashing first means both sides are always a fixed-length
 * (64 hex char) digest, so arbitrary-length input can never make timingSafeEqual throw.
 * Missing/null values fail closed. Never logs or returns the presented or stored value.
 */
export function verifyWebhookSecret(
  presented: string | null | undefined,
  storedHash: string | null | undefined,
): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(hashWebhookSecret(presented), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

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
    const tokens = await getFreshTokens(calendar.connectionId, calendar.organizationId);
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
      // `nextCursor` is the resume point for the NEXT run (providers return a
      // sync token even on the final page) — only `hasMore` continues the loop.
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
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

export type WebhookSubscriptionOutcome = "reused" | "renewed" | "skipped";

/**
 * Ensure a webhook subscription exists, renewing it (with a fresh verification secret)
 * when missing, near expiry, or missing a secret hash. Safe to call repeatedly — the
 * only recurring caller today is the calendar-sync maintenance job
 * (src/app/api/v1/jobs/calendar-sync/route.ts); the settings-page toggle-on action
 * calls it once immediately for the calendar being enabled.
 */
export async function ensureWebhookSubscription(
  externalCalendarId: string,
): Promise<WebhookSubscriptionOutcome> {
  const calendar = await unscopedPrisma.externalCalendar.findUnique({
    where: { id: externalCalendarId },
    include: { connection: true, syncState: true },
  });
  if (!calendar?.syncEnabled) return "skipped";

  const state = calendar.syncState;
  // A subscription is only reusable when it has an id, isn't near expiry, AND has a
  // verification secret on record — a null hash (pre-P0.2 rows, or anything that
  // otherwise lost its secret) must be renewed here rather than waiting for expiry,
  // since without a secret no incoming notification for it could ever verify.
  const stillValid =
    !!state?.webhookSubscriptionId &&
    !!state.webhookExpiresAt &&
    state.webhookExpiresAt.getTime() > Date.now() + 12 * 3_600_000 &&
    !!state.webhookVerificationSecretHash;
  if (stillValid) return "reused";

  const adapter = getProviderAdapter(calendar.connection.provider);
  const tokens = await getFreshTokens(calendar.connectionId, calendar.organizationId);
  const callbackUrl = `${clientEnv.NEXT_PUBLIC_APP_URL}/api/v1/webhooks/calendar/${calendar.connection.provider.toLowerCase()}`;
  const verificationSecret = generateWebhookSecret();
  const sub = await adapter.subscribeWebhook(
    tokens,
    calendar.externalId,
    callbackUrl,
    verificationSecret,
  );
  if (!sub) return "skipped";

  // Renewal replaces the subscription id/resource id/expiry and the secret hash
  // together, in one write — the previous secret is discarded, so notifications
  // still using it fail verification from this point on.
  await unscopedPrisma.calendarSyncState.upsert({
    where: { externalCalendarId },
    create: {
      organizationId: calendar.organizationId,
      externalCalendarId,
      webhookSubscriptionId: sub.subscriptionId,
      webhookResourceId: sub.resourceId ?? null,
      webhookExpiresAt: sub.expiresAt ?? null,
      webhookVerificationSecretHash: hashWebhookSecret(verificationSecret),
    },
    update: {
      webhookSubscriptionId: sub.subscriptionId,
      webhookResourceId: sub.resourceId ?? null,
      webhookExpiresAt: sub.expiresAt ?? null,
      webhookVerificationSecretHash: hashWebhookSecret(verificationSecret),
    },
  });
  return "renewed";
}

/**
 * Resolve which calendar a provider webhook ping belongs to, verify its presented
 * secret, then sync it. Returns false — without triggering a sync — for an unknown
 * subscription id, a wrong provider/subscription pairing, or a missing/invalid
 * verification secret alike, so a caller can never distinguish "no such subscription"
 * from "subscription exists but verification failed" (no information leak).
 */
export async function handleProviderWebhook(params: {
  provider: "GOOGLE" | "MICROSOFT" | "MOCK";
  subscriptionId: string;
  presentedSecret: string | null;
}): Promise<boolean> {
  const state = await unscopedPrisma.calendarSyncState.findFirst({
    where: {
      webhookSubscriptionId: params.subscriptionId,
      externalCalendar: { connection: { provider: params.provider } },
    },
    select: { externalCalendarId: true, webhookVerificationSecretHash: true },
  });
  if (!state) return false;
  if (!verifyWebhookSecret(params.presentedSecret, state.webhookVerificationSecretHash)) {
    return false;
  }
  await syncExternalCalendar(state.externalCalendarId);
  return true;
}

// ── Outbound push (P2: unified booking lifecycle) ────────────────────────

export type PushOutcome = "not_applicable" | "synced" | "failed" | "ambiguous";

/**
 * Finds the calendar owner's connected, primary Google calendar, if any.
 * Returns null when there is none — callers must treat that as "skip the
 * push, the booking still succeeds" rather than an error: Google Calendar
 * sync is an optional enhancement to a booking, never a precondition for it.
 */
async function findGooglePushTarget(
  orgId: string,
  ownerId: string,
): Promise<{ connectionId: string; calendarExternalId: string; calendarId: string } | null> {
  const connection = await unscopedPrisma.calendarConnection.findFirst({
    where: { organizationId: orgId, userId: ownerId, provider: "GOOGLE", status: "CONNECTED" },
    select: { id: true },
  });
  if (!connection) return null;
  const calendar = await unscopedPrisma.externalCalendar.findFirst({
    where: { connectionId: connection.id, isPrimary: true },
    select: { id: true, externalId: true },
  });
  if (!calendar) return null;
  return {
    connectionId: connection.id,
    calendarExternalId: calendar.externalId,
    calendarId: calendar.id,
  };
}

/**
 * Push-creates a Syveka-originated booking's CalendarEvent on the owner's
 * connected Google Calendar, if any. Best-effort: never throws — a failed or
 * ambiguous push does not fail the booking (see the `GoogleSyncStatus` enum
 * doc comment in prisma/schema.prisma). Idempotent: a CalendarEvent already
 * SYNCED is not re-pushed.
 *
 * On success, `externalCalendarId`/`externalId` are set to the SAME columns
 * the inbound sync (`applyRemoteEvent` above) keys its
 * upsert-by-(externalCalendarId, externalId) on — so the next inbound sync
 * of this calendar matches this row and UPDATEs it instead of importing a
 * second, duplicate CalendarEvent. This is the mechanism that keeps
 * outbound push and inbound sync from ever producing a duplicate.
 *
 * NO automatic retry on FAILED or AMBIGUOUS: a caller-initiated retry (e.g.
 * a human clicking "retry" after inspecting the failure) is safe; a
 * background job blindly retrying is not, because an AMBIGUOUS outcome
 * means we do not know whether the first attempt actually created the event
 * on Google — retrying it automatically could create a second one there.
 */
export async function pushBookingEventToGoogle(params: {
  orgId: string;
  ownerId: string;
  eventId: string;
}): Promise<PushOutcome> {
  const event = await unscopedPrisma.calendarEvent.findUnique({
    where: { id: params.eventId },
    select: {
      id: true,
      organizationId: true,
      title: true,
      description: true,
      location: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      googleSyncStatus: true,
      deletedAt: true,
    },
  });
  if (!event || event.organizationId !== params.orgId || event.deletedAt) {
    return "not_applicable";
  }
  if (event.googleSyncStatus === "SYNCED") return "synced"; // already pushed — idempotent no-op

  const target = await findGooglePushTarget(params.orgId, params.ownerId);
  if (!target) {
    // No connected Google calendar — this is the common, expected case for
    // a pilot org that hasn't connected Google yet. Leave googleSyncStatus
    // at its NOT_APPLICABLE default; nothing to write.
    return "not_applicable";
  }

  const adapter = getProviderAdapter("GOOGLE");
  if (typeof adapter.createEvent !== "function") return "not_applicable";

  let tokens;
  try {
    tokens = await getFreshTokens(target.connectionId, params.orgId);
  } catch (e) {
    // A definitive failure to even obtain valid credentials (e.g. no refresh
    // token, refresh rejected) — getFreshTokens already recorded
    // NEEDS_REAUTH on the connection. No request was ever sent to Google, so
    // this is FAILED, not AMBIGUOUS.
    await markCalendarEventPush(event.id, "FAILED", errorMessage(e));
    return "failed";
  }

  try {
    const result = await adapter.createEvent(tokens, target.calendarExternalId, {
      title: event.title,
      description: event.description ?? undefined,
      location: event.location ?? undefined,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
    });
    await unscopedPrisma.calendarEvent.update({
      where: { id: event.id },
      data: {
        externalCalendarId: target.calendarId,
        externalId: result.externalId,
        externalEtag: result.etag ?? null,
        googleSyncStatus: "SYNCED",
        googleSyncError: null,
      },
    });
    return "synced";
  } catch (e) {
    // A ProviderError means Google responded with a definitive error (or we
    // got a clean 401/429/4xx/5xx) — we know for certain no event was
    // created. Anything else (fetch itself throwing: DNS failure, connection
    // reset, abort) means we never got a response at all, so we cannot tell
    // whether Google actually created the event before the failure —
    // AMBIGUOUS, and per this function's contract, never auto-retried.
    const outcome: PushOutcome = e instanceof ProviderError ? "failed" : "ambiguous";
    await markCalendarEventPush(
      event.id,
      outcome === "failed" ? "FAILED" : "AMBIGUOUS",
      errorMessage(e),
    );
    return outcome;
  }
}

/**
 * Push-cancels a previously push-created event. No-op (returns
 * "not_applicable") if the event was never synced to Google. Same
 * no-auto-retry contract as pushBookingEventToGoogle — see its doc comment.
 */
export async function cancelBookingEventOnGoogle(params: {
  eventId: string;
}): Promise<PushOutcome> {
  const event = await unscopedPrisma.calendarEvent.findUnique({
    where: { id: params.eventId },
    select: {
      id: true,
      organizationId: true,
      externalCalendarId: true,
      externalId: true,
      googleSyncStatus: true,
    },
  });
  if (!event || !event.externalCalendarId || !event.externalId) return "not_applicable";
  if (event.googleSyncStatus !== "SYNCED") return "not_applicable"; // never successfully pushed, or already handled

  const externalCalendar = await unscopedPrisma.externalCalendar.findUnique({
    where: { id: event.externalCalendarId },
    select: { externalId: true, connectionId: true, connection: { select: { userId: true } } },
  });
  if (!externalCalendar) return "not_applicable";

  const adapter = getProviderAdapter("GOOGLE");
  if (typeof adapter.cancelEvent !== "function") return "not_applicable";

  let tokens;
  try {
    tokens = await getFreshTokens(externalCalendar.connectionId, event.organizationId);
  } catch (e) {
    await markCalendarEventPush(event.id, "FAILED", errorMessage(e));
    return "failed";
  }

  try {
    await adapter.cancelEvent(tokens, externalCalendar.externalId, event.externalId);
    await markCalendarEventPush(event.id, "NOT_APPLICABLE", null);
    return "synced";
  } catch (e) {
    const outcome: PushOutcome = e instanceof ProviderError ? "failed" : "ambiguous";
    await markCalendarEventPush(
      event.id,
      outcome === "failed" ? "FAILED" : "AMBIGUOUS",
      errorMessage(e),
    );
    return outcome;
  }
}

function errorMessage(e: unknown): string {
  // Sanitized: error messages in this codebase's ProviderError/network paths
  // never include tokens or headers (see google.ts) — only status codes and
  // generic descriptions. Truncated defensively regardless.
  const message = e instanceof Error ? e.message : "unknown error";
  return message.slice(0, 500);
}

async function markCalendarEventPush(
  eventId: string,
  status: "FAILED" | "AMBIGUOUS" | "NOT_APPLICABLE",
  error: string | null,
): Promise<void> {
  await unscopedPrisma.calendarEvent
    .update({ where: { id: eventId }, data: { googleSyncStatus: status, googleSyncError: error } })
    .catch(() => undefined);
}
