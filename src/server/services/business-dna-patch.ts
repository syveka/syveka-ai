import "server-only";

import { Prisma } from "@/generated/prisma/client/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { auditLogData } from "./audit";
import { resyncActiveAssistants } from "./voice";
import {
  BUSINESS_DNA_PATCH_FIELDS,
  WEEKDAYS,
  type BusinessDnaChange,
  type BusinessDnaDisplayValue,
  type BusinessDnaPatch,
  type BusinessDnaPatchField,
  type ConfirmedBusinessDnaPatch,
  type OpeningHoursPatch,
  type Weekday,
} from "@/lib/validators/business-dna-patch";
import { missingBusinessDnaFields } from "@/lib/business-dna/completeness";

/**
 * Partial, confirmed changes to an organization's Business DNA from chat.
 *
 * previewBusinessDnaPatch shows what a patch would change against the
 * current profile, and records the current values of exactly the fields it
 * changes (the basis). applyBusinessDnaPatch applies it only while those
 * fields still have those values, so a change made elsewhere in the
 * meantime is never overwritten, and fields the patch doesn't name are never
 * touched. The change and its audit record are written in one transaction.
 */

const LIST_FIELDS = new Set<BusinessDnaPatchField>(["supportedLocales", "keyFacts"]);

const PATCH_SELECT = {
  id: true,
  displayName: true,
  industry: true,
  description: true,
  productsServices: true,
  supportedLocales: true,
  timezone: true,
  brandTone: true,
  openingHours: true,
  cancellationPolicy: true,
  bookingPolicy: true,
  refundPolicy: true,
  paymentPolicy: true,
  otherPolicies: true,
  currency: true,
  quoteInstructions: true,
  pricingNotes: true,
  targetCustomer: true,
  keyFacts: true,
} as const;

type Profile = Record<BusinessDnaPatchField, unknown> & { id: string };

type StoredDay = { closed: boolean; open?: string; close?: string };

/** The stored opening hours as a weekday map (anything unrecognized is dropped). */
function storedHours(value: unknown): Partial<Record<Weekday, StoredDay>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const hours: Partial<Record<Weekday, StoredDay>> = {};
  for (const day of WEEKDAYS) {
    const v = source[day] as { closed?: unknown; open?: unknown; close?: unknown } | undefined;
    if (!v || typeof v !== "object") continue;
    if (v.closed === true) hours[day] = { closed: true };
    else if (typeof v.open === "string" && typeof v.close === "string") {
      hours[day] = { closed: false, open: v.open, close: v.close };
    }
  }
  return hours;
}

const patchedDay = (v: NonNullable<OpeningHoursPatch[Weekday]>): StoredDay =>
  v.closed ? { closed: true } : { closed: false, open: v.open!, close: v.close! };

/** The patched days whose hours actually change. */
function changedDays(current: unknown, patch: OpeningHoursPatch): Weekday[] {
  const stored = storedHours(current);
  return WEEKDAYS.filter((d) => patch[d] && !sameValue(stored[d] ?? null, patchedDay(patch[d]!)));
}

/**
 * New opening hours: the days in the patch whose hours change are replaced;
 * every other day is kept exactly as stored, so nothing the user wasn't shown
 * is rewritten.
 */
function mergedHours(current: unknown, patch: OpeningHoursPatch) {
  const hours: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  for (const day of changedDays(current, patch)) hours[day] = patchedDay(patch[day]!);
  return hours;
}

/** The value a field would have after the patch. */
function nextValue(current: Profile | null, patch: BusinessDnaPatch, field: BusinessDnaPatchField) {
  if (patch.clear?.includes(field)) return LIST_FIELDS.has(field) ? [] : null;
  const value = patch.set?.[field];
  if (field === "openingHours")
    return mergedHours(current?.openingHours, value as OpeningHoursPatch);
  return value;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return value === "";
}

/** JSON with sorted object keys: equal values compare equal (Postgres jsonb reorders keys). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sameValue = (a: unknown, b: unknown) =>
  stable(isEmpty(a) ? null : a) === stable(isEmpty(b) ? null : b);

function display(
  field: BusinessDnaPatchField,
  value: unknown,
  days?: Weekday[],
): BusinessDnaDisplayValue | null {
  if (isEmpty(value)) return null;
  if (field === "openingHours") {
    const hours = storedHours(value);
    const shown = (days ?? WEEKDAYS).filter((d) => hours[d]);
    if (shown.length === 0) return null;
    return { type: "hours", days: shown.map((day) => ({ day, ...hours[day]! })) };
  }
  if (Array.isArray(value)) return { type: "list", items: value.map(String) };
  return { type: "text", value: String(value) };
}

/** A patch names a field chat may not change (e.g. the AI's own instructions). */
export class BusinessDnaFieldNotAllowedError extends Error {
  constructor() {
    super("Business DNA field not changeable from chat");
    this.name = "BusinessDnaFieldNotAllowedError";
  }
}

const CHAT_FIELDS: ReadonlySet<string> = new Set(BUSINESS_DNA_PATCH_FIELDS);

/**
 * The fields a patch changes. Checked against the chat allowlist here too,
 * not only by the input schema: preview and apply both go through this, so
 * no input can reach a settings-only field however it was produced.
 */
function changedFields(patch: BusinessDnaPatch): BusinessDnaPatchField[] {
  const fields = [...Object.keys(patch.set ?? {}), ...(patch.clear ?? [])];
  if (fields.some((field) => !CHAT_FIELDS.has(field))) throw new BusinessDnaFieldNotAllowedError();
  return fields as BusinessDnaPatchField[];
}

export type BusinessDnaPatchPreview =
  | {
      ok: true;
      changes: BusinessDnaChange[];
      basis: ConfirmedBusinessDnaPatch["basis"];
      /** Important fields still empty after this change, most important first. */
      missingAfter: string[];
    }
  | { ok: false; reason: "no_changes" };

/** What the patch would change in this organization's current profile. Writes nothing. */
export async function previewBusinessDnaPatch(
  orgId: string,
  patch: BusinessDnaPatch,
): Promise<BusinessDnaPatchPreview> {
  const db = tenantDb(orgId);
  const current = (await db.businessDNA.findFirst({ select: PATCH_SELECT })) as Profile | null;
  const changes: BusinessDnaChange[] = [];
  const basisFields: Partial<Record<BusinessDnaPatchField, unknown>> = {};
  const after: Partial<Record<BusinessDnaPatchField, unknown>> = { ...(current ?? {}) };

  for (const field of changedFields(patch)) {
    const before = current?.[field] ?? null;
    const next = nextValue(current, patch, field);
    after[field] = next;
    if (sameValue(before, next)) continue;
    basisFields[field] = before;
    const days =
      field === "openingHours" && patch.set?.openingHours
        ? changedDays(before, patch.set.openingHours)
        : undefined;
    // The kind describes what the user is shown: opening hours show only the
    // days that change, so days that had no hours before are "added".
    const shownBefore = display(field, before, days);
    const shownAfter = display(field, next, days);
    changes.push({
      field,
      kind: !shownAfter ? "removed" : !shownBefore ? "added" : "modified",
      before: shownBefore,
      after: shownAfter,
    });
  }
  if (changes.length === 0) return { ok: false, reason: "no_changes" };

  const activeServiceCount = current
    ? await db.businessDnaService.count({ where: { isActive: true } })
    : 0;
  return {
    ok: true,
    changes,
    basis: { exists: !!current, fields: basisFields },
    missingAfter: missingBusinessDnaFields(after, { activeServiceCount }),
  };
}

/** Only the fields that change, from a confirmed patch (no-op fields were dropped at preview). */
export function effectivePatch(confirmed: ConfirmedBusinessDnaPatch): BusinessDnaPatch {
  const fields = new Set(Object.keys(confirmed.basis.fields));
  return {
    set: Object.fromEntries(
      Object.entries(confirmed.set ?? {}).filter(([field]) => fields.has(field)),
    ) as BusinessDnaPatch["set"],
    clear: (confirmed.clear ?? []).filter((field) => fields.has(field)),
  };
}

export type ApplyBusinessDnaPatchResult =
  | { applied: true; id: string; changedFields: BusinessDnaPatchField[] }
  | { applied: false; reason: "stale" };

/**
 * Applies a confirmed patch for this organization, only if every field it
 * changes still has the value the user was shown (and the profile still
 * exists, or still doesn't). Otherwise nothing is written ("stale").
 */
export async function applyBusinessDnaPatch(
  actor: {
    orgId: string;
    userId: string;
    actorType: "user" | "voice_ai";
    /** The chat action and conversation the change was confirmed in, when there is one. */
    source?: { actionId?: string; conversationId?: string };
  },
  confirmed: ConfirmedBusinessDnaPatch,
): Promise<ApplyBusinessDnaPatchResult> {
  const patch = effectivePatch(confirmed);
  const fields = changedFields(patch);
  if (fields.length === 0) return { applied: false, reason: "stale" };

  const result = await unscopedPrisma
    .$transaction(async (tx): Promise<ApplyBusinessDnaPatchResult> => {
      // Serializes this organization's Business DNA patches: the check below
      // and the write happen with no other patch in between.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('business_dna'), hashtext(${actor.orgId}))`;
      // And against every other writer (the settings form, the API): the
      // profile row stays locked from this check until the write commits, so
      // a save that lands in between can't be silently overwritten.
      await tx.$queryRaw`SELECT id FROM business_dna WHERE organization_id = ${actor.orgId}::uuid FOR UPDATE`;
      const current = (await tx.businessDNA.findUnique({
        where: { organizationId: actor.orgId },
        select: PATCH_SELECT,
      })) as Profile | null;
      if (!!current !== confirmed.basis.exists) return { applied: false, reason: "stale" };
      for (const field of fields) {
        if (!sameValue(current?.[field] ?? null, confirmed.basis.fields[field])) {
          return { applied: false, reason: "stale" };
        }
      }

      const data: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const field of fields) {
        const next = nextValue(current, patch, field);
        before[field] = current?.[field] ?? null;
        after[field] = next;
        data[field] = field === "openingHours" && next === null ? Prisma.JsonNull : next;
      }

      const record = current
        ? await tx.businessDNA.update({
            where: { organizationId: actor.orgId },
            data,
            select: { id: true },
          })
        : await tx.businessDNA.create({
            data: { organizationId: actor.orgId, ...data },
            select: { id: true },
          });

      await tx.auditLog.create({
        data: await auditLogData(
          { orgId: actor.orgId, userId: actor.userId },
          {
            action: current ? "business_dna.update" : "business_dna.create",
            resourceType: "business_dna",
            resourceId: record.id,
            actorType: actor.actorType,
            before: { fields: before },
            after: {
              fields: after,
              via: "ai_chat",
              ...(actor.source?.actionId ? { actionId: actor.source.actionId } : {}),
              ...(actor.source?.conversationId
                ? { conversationId: actor.source.conversationId }
                : {}),
            },
          },
        ),
      });
      return { applied: true, id: record.id, changedFields: fields };
    })
    .catch((e: unknown): ApplyBusinessDnaPatchResult => {
      // A profile created by another save after this one found none (there
      // was no row to lock): that is a change made elsewhere, not a failure.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return { applied: false, reason: "stale" };
      }
      throw e;
    });

  // Same as a form save: a live voice assistant must not keep quoting old
  // hours or policies. Best-effort, after the change has committed.
  if (result.applied) await resyncActiveAssistants(actor.orgId);
  return result;
}
