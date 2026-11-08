import "server-only";

import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { audit } from "./audit";
import { isValidTimezone } from "@/server/calendar/timezone";
import type { TenantContext } from "@/server/auth/session";
import type { AvailabilityScheduleInput } from "@/lib/validators/booking";

export class AvailabilityError extends Error {
  constructor(
    message: string,
    public readonly code: "not_found" | "invalid_timezone" | "overlapping_rules",
  ) {
    super(message);
    this.name = "AvailabilityError";
  }
}

function assertRulesDisjoint(rules: AvailabilityScheduleInput["rules"]): void {
  const byDay = new Map<number, Array<{ s: number; e: number }>>();
  for (const r of rules) {
    const list = byDay.get(r.weekday) ?? [];
    for (const other of list) {
      if (r.startMinute < other.e && r.endMinute > other.s) {
        throw new AvailabilityError("Overlapping windows on the same weekday", "overlapping_rules");
      }
    }
    list.push({ s: r.startMinute, e: r.endMinute });
    byDay.set(r.weekday, list);
  }
}

export async function listSchedules(ctx: TenantContext, userId?: string) {
  const db = tenantDb(ctx.orgId);
  return db.availabilitySchedule.findMany({
    where: userId ? { userId } : {},
    include: {
      rules: { orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] },
      overrides: { orderBy: { date: "asc" } },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    take: 50,
  });
}

export async function getSchedule(ctx: TenantContext, scheduleId: string) {
  const db = tenantDb(ctx.orgId);
  return db.availabilitySchedule.findFirst({
    where: { id: scheduleId },
    include: {
      rules: { orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] },
      overrides: { orderBy: { date: "asc" } },
    },
  });
}

export async function saveSchedule(
  ctx: TenantContext,
  input: AvailabilityScheduleInput,
  scheduleId?: string,
) {
  if (!isValidTimezone(input.timezone)) {
    throw new AvailabilityError(`Unknown timezone: ${input.timezone}`, "invalid_timezone");
  }
  assertRulesDisjoint(input.rules);
  const db = tenantDb(ctx.orgId);

  if (scheduleId) {
    const existing = await db.availabilitySchedule.findFirst({
      where: { id: scheduleId },
      select: { id: true },
    });
    if (!existing) throw new AvailabilityError("Schedule not found", "not_found");
  }

  // One transaction for everything the save writes: a failure part-way leaves
  // the previous schedule, not one with none of its rules (every booking page
  // using it would offer no slots) or a new timezone over its old rules
  // (every slot would move). The transaction client is not tenant-scoped, so
  // every write names the organization; the schedule was verified above.
  const orgId = ctx.orgId;
  const id = await unscopedPrisma.$transaction(async (tx) => {
    let savedId: string;
    if (scheduleId) {
      await tx.availabilitySchedule.updateMany({
        where: { id: scheduleId, organizationId: orgId },
        data: { name: input.name, timezone: input.timezone, isDefault: input.isDefault },
      });
      savedId = scheduleId;
    } else {
      const created = await tx.availabilitySchedule.create({
        data: {
          organizationId: orgId,
          userId: ctx.userId,
          name: input.name,
          timezone: input.timezone,
          isDefault: input.isDefault,
        },
      });
      savedId = created.id;
    }

    if (input.isDefault) {
      // Single default per user.
      await tx.availabilitySchedule.updateMany({
        where: { organizationId: orgId, userId: ctx.userId, id: { not: savedId } },
        data: { isDefault: false },
      });
    }

    // Child rows are parent-scoped; the parent is this organization's.
    await tx.availabilityRule.deleteMany({ where: { scheduleId: savedId } });
    if (input.rules.length > 0) {
      await tx.availabilityRule.createMany({
        data: input.rules.map((r) => ({
          scheduleId: savedId,
          weekday: r.weekday,
          startMinute: r.startMinute,
          endMinute: r.endMinute,
        })),
      });
    }
    await tx.availabilityOverride.deleteMany({ where: { scheduleId: savedId } });
    if (input.overrides.length > 0) {
      await tx.availabilityOverride.createMany({
        data: input.overrides.map((o) => ({
          scheduleId: savedId,
          date: new Date(`${o.date}T00:00:00.000Z`),
          startMinute: o.isUnavailable ? null : o.startMinute,
          endMinute: o.isUnavailable ? null : o.endMinute,
          isUnavailable: o.isUnavailable,
        })),
      });
    }
    return savedId;
  });

  await audit(ctx, {
    action: scheduleId ? "availability.update" : "availability.create",
    resourceType: "availability_schedule",
    resourceId: id,
    after: { name: input.name, timezone: input.timezone, rules: input.rules.length },
  });
  return id;
}

export async function deleteSchedule(ctx: TenantContext, scheduleId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const existing = await db.availabilitySchedule.findFirst({
    where: { id: scheduleId },
    select: { id: true, name: true },
  });
  if (!existing) throw new AvailabilityError("Schedule not found", "not_found");
  await db.availabilitySchedule.delete({ where: { id: scheduleId } });
  await audit(ctx, {
    action: "availability.delete",
    resourceType: "availability_schedule",
    resourceId: scheduleId,
    before: { name: existing.name },
  });
}
