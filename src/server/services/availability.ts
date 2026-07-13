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

  let id = scheduleId;
  if (id) {
    const existing = await db.availabilitySchedule.findFirst({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing) throw new AvailabilityError("Schedule not found", "not_found");
    await db.availabilitySchedule.update({
      where: { id },
      data: { name: input.name, timezone: input.timezone, isDefault: input.isDefault },
    });
  } else {
    const created = await db.availabilitySchedule.create({
      data: {
        organizationId: ctx.orgId,
        userId: ctx.userId,
        name: input.name,
        timezone: input.timezone,
        isDefault: input.isDefault,
      },
    });
    id = created.id;
  }

  if (input.isDefault) {
    // Single default per user.
    await db.availabilitySchedule.updateMany({
      where: { userId: ctx.userId, id: { not: id } },
      data: { isDefault: false },
    });
  }

  // Child rows are parent-scoped; the parent was verified above.
  await unscopedPrisma.availabilityRule.deleteMany({ where: { scheduleId: id } });
  if (input.rules.length > 0) {
    await unscopedPrisma.availabilityRule.createMany({
      data: input.rules.map((r) => ({
        scheduleId: id!,
        weekday: r.weekday,
        startMinute: r.startMinute,
        endMinute: r.endMinute,
      })),
    });
  }
  await unscopedPrisma.availabilityOverride.deleteMany({ where: { scheduleId: id } });
  if (input.overrides.length > 0) {
    await unscopedPrisma.availabilityOverride.createMany({
      data: input.overrides.map((o) => ({
        scheduleId: id!,
        date: new Date(`${o.date}T00:00:00.000Z`),
        startMinute: o.isUnavailable ? null : o.startMinute,
        endMinute: o.isUnavailable ? null : o.endMinute,
        isUnavailable: o.isUnavailable,
      })),
    });
  }

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
