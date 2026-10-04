import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { getProviderAdapter } from "@/server/integrations/calendar";
import { ProviderError, type ExternalEvent } from "@/server/integrations/calendar/types";
import { lockActiveCalendarConnection, lockCalendarMember } from "@/server/calendar/locks";
import {
  ConnectionError,
  getFreshTokens,
  isCalendarMember,
  markConnectionStatus,
} from "./calendar-connections";
import { getAppUrlEnv } from "@/env";

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
 * - Membership: each fetched page is persisted (events, deletions, cursor) in
 *   one transaction that first locks the connection owner's membership and
 *   the connection (withCalendarImportAccess). Once a removal, an
 *   organization deletion or a disconnect has committed, nothing fetched
 *   before it is written; the provider fetch itself runs outside any
 *   transaction.
 */

export type SyncResult = {
  imported: number;
  updated: number;
  deleted: number;
  skippedConflicts: number;
  cursorReset: boolean;
  /** Set when the sync stopped because the owner's access ended; nothing was written. */
  accessRevoked?: true;
};

/** The connection owner lost access (removed, org deleted, disconnected). Not retryable. */
class CalendarAccessRevoked extends Error {}

/**
 * Runs `write` in a transaction that first locks the connection owner's
 * membership (and organization) and the connection itself, throwing
 * CalendarAccessRevoked instead when either is gone. See lockCalendarMember
 * for why this excludes a concurrent removal rather than just checking it.
 */
async function withCalendarImportAccess<T>(
  calendar: { organizationId: string; connectionId: string; connection: { userId: string } },
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return unscopedPrisma.$transaction(
    async (tx) => {
      const userId = calendar.connection.userId;
      if (!(await lockCalendarMember(tx, calendar.organizationId, userId))) {
        throw new CalendarAccessRevoked();
      }
      const usable = await lockActiveCalendarConnection(tx, {
        connectionId: calendar.connectionId,
        orgId: calendar.organizationId,
        userId,
      });
      if (!usable) throw new CalendarAccessRevoked();
      return write(tx);
    },
    // A page of events is applied in one transaction; give it room.
    { timeout: 30_000 },
  );
}

function isAccessRevoked(e: unknown): boolean {
  return (
    e instanceof CalendarAccessRevoked ||
    (e instanceof ConnectionError && e.code === "membership_revoked")
  );
}

async function applyRemoteEvent(
  db: Prisma.TransactionClient,
  orgId: string,
  externalCalendarId: string,
  ownerUserId: string,
  remote: ExternalEvent,
  source: "GOOGLE" | "OUTLOOK",
): Promise<"created" | "updated" | "skipped"> {
  const existing = await db.calendarEvent.findUnique({
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
    const event = await db.calendarEvent.create({
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
      await db.eventAttendee.createMany({
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

  await db.calendarEvent.update({ where: { id: existing.id }, data });
  return "updated";
}

export async function syncExternalCalendar(externalCalendarId: string): Promise<SyncResult> {
  // A soft-deleted org's calendars are treated as gone: nothing is imported.
  const calendar = await unscopedPrisma.externalCalendar.findUnique({
    where: { id: externalCalendarId, organization: { deletedAt: null } },
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
      // Provider fetch: outside any transaction.
      const page = await adapter.listEvents(tokens, calendar.externalId, cursor);

      if (page.cursorExpired) {
        result.cursorReset = true;
        cursor = null;
        await withCalendarImportAccess(calendar, (tx) =>
          persistCursor(tx, calendar.id, calendar.organizationId, null, "cursor_reset"),
        );
        continue;
      }

      const source = calendar.connection.provider === "MICROSOFT" ? "OUTLOOK" : "GOOGLE";
      // The page and its cursor are applied together, only while the owner
      // still has access; counts are added once the transaction commits.
      const applied = await withCalendarImportAccess(calendar, async (tx) => {
        const counts = { imported: 0, updated: 0, deleted: 0, skippedConflicts: 0 };
        for (const remote of page.events) {
          const outcome = await applyRemoteEvent(
            tx,
            calendar.organizationId,
            calendar.id,
            calendar.connection.userId,
            remote,
            source,
          );
          if (outcome === "created") counts.imported += 1;
          else if (outcome === "updated") counts.updated += 1;
          else counts.skippedConflicts += 1;
        }

        if (page.deletedExternalIds.length > 0) {
          const res = await tx.calendarEvent.updateMany({
            where: {
              externalCalendarId: calendar.id,
              externalId: { in: page.deletedExternalIds },
              deletedAt: null,
            },
            data: { status: "CANCELED", canceledAt: new Date(), deletedAt: new Date() },
          });
          counts.deleted += res.count;
        }

        // Persist cursor after the page is fully applied (same transaction).
        await persistCursor(tx, calendar.id, calendar.organizationId, page.nextCursor, "ok");
        return counts;
      });
      result.imported += applied.imported;
      result.updated += applied.updated;
      result.deleted += applied.deleted;
      result.skippedConflicts += applied.skippedConflicts;

      // `nextCursor` is the resume point for the NEXT run (providers return a
      // sync token even on the final page) — only `hasMore` continues the loop.
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // updateMany: the state row may be gone if sync was turned off meanwhile.
    await unscopedPrisma.calendarSyncState.updateMany({
      where: { externalCalendarId: calendar.id },
      data: { lastSyncedAt: new Date(), lastSyncStatus: "ok", failureCount: 0 },
    });
    return result;
  } catch (e) {
    // Access ended (removed member, deleted org, disconnected connection):
    // nothing from the interrupted page was written, and nothing is recorded
    // or retried for a calendar its owner no longer gives the org access to.
    if (isAccessRevoked(e)) return { ...result, accessRevoked: true };
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
  db: Prisma.TransactionClient,
  externalCalendarId: string,
  orgId: string,
  cursor: string | null,
  status: string,
): Promise<void> {
  await db.calendarSyncState.upsert({
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
  // Never create or renew a provider subscription for a soft-deleted org.
  const calendar = await unscopedPrisma.externalCalendar.findUnique({
    where: { id: externalCalendarId, organization: { deletedAt: null } },
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

  // No provider subscription on behalf of someone without access: a
  // disconnected connection, or an owner who is no longer a member.
  if (
    calendar.connection.status === "DISCONNECTED" ||
    !(await isCalendarMember(calendar.organizationId, calendar.connection.userId))
  ) {
    return "skipped";
  }

  const adapter = getProviderAdapter(calendar.connection.provider);
  const tokens = await getFreshTokens(calendar.connectionId, calendar.organizationId);
  const callbackUrl = `${getAppUrlEnv().NEXT_PUBLIC_APP_URL}/api/v1/webhooks/calendar/${calendar.connection.provider.toLowerCase()}`;
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
  // still using it fail verification from this point on. Stored only while the
  // owner still has access; otherwise the new provider subscription is left
  // unverifiable (no secret stored), so its notifications never trigger a sync.
  const subscription = sub;
  try {
    await withCalendarImportAccess(calendar, (tx) =>
      tx.calendarSyncState.upsert({
        where: { externalCalendarId },
        create: {
          organizationId: calendar.organizationId,
          externalCalendarId,
          webhookSubscriptionId: subscription.subscriptionId,
          webhookResourceId: subscription.resourceId ?? null,
          webhookExpiresAt: subscription.expiresAt ?? null,
          webhookVerificationSecretHash: hashWebhookSecret(verificationSecret),
        },
        update: {
          webhookSubscriptionId: subscription.subscriptionId,
          webhookResourceId: subscription.resourceId ?? null,
          webhookExpiresAt: subscription.expiresAt ?? null,
          webhookVerificationSecretHash: hashWebhookSecret(verificationSecret),
        },
      }),
    );
  } catch (e) {
    if (isAccessRevoked(e)) return "skipped";
    throw e;
  }
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
