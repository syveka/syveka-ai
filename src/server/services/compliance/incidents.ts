import "server-only";

import type { IncidentSeverity, IncidentStatus, NotificationRequirement } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listIncidents() {
  await requireSuperadmin();
  return unscopedPrisma.securityIncident.findMany({ orderBy: { detectedAt: "desc" } });
}

export async function getIncident(id: string) {
  await requireSuperadmin();
  return unscopedPrisma.securityIncident.findUnique({
    where: { id },
    include: { events: { orderBy: { occurredAt: "asc" } } },
  });
}

export type CreateIncidentInput = {
  incidentKey: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  detectedAt: Date;
  occurredAt?: Date;
  affectedOrganizationId?: string;
  affectedSystems?: string;
  affectedDataCategories?: string;
};

/**
 * `notificationRequired` always starts UNKNOWN -- legal notification
 * applicability is a human (ideally legal) review decision, never inferred
 * here. Set it explicitly via `setNotificationAssessment` after review.
 */
export async function createIncident(input: CreateIncidentInput) {
  const { userId } = await requireSuperadmin();
  const incident = await unscopedPrisma.securityIncident.create({
    data: { status: "DETECTED", ownerUserId: userId, ...input },
  });
  await complianceAudit(userId, {
    action: "security_incident.create",
    resourceType: "SecurityIncident",
    resourceId: incident.id,
    after: incident,
  });
  return incident;
}

export async function updateIncidentStatus(id: string, status: IncidentStatus) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.securityIncident.findUnique({ where: { id } });
  if (!before) throw new Error("Incident not found");
  const incident = await unscopedPrisma.securityIncident.update({
    where: { id },
    data: { status, closedAt: status === "CLOSED" ? new Date() : undefined },
  });
  await complianceAudit(userId, {
    action: "security_incident.update_status",
    resourceType: "SecurityIncident",
    resourceId: incident.id,
    before,
    after: incident,
  });
  return incident;
}

export type NotificationAssessment = {
  notificationRequired: NotificationRequirement;
  notificationEarlyWarningDueAt?: Date;
  notificationAuthorityDueAt?: Date;
  notificationFinalReportDueAt?: Date;
};

/** Deadlines are set by a human reviewer per incident -- never templated automatically. */
export async function setNotificationAssessment(id: string, input: NotificationAssessment) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.securityIncident.findUnique({ where: { id } });
  if (!before) throw new Error("Incident not found");
  const incident = await unscopedPrisma.securityIncident.update({ where: { id }, data: input });
  await complianceAudit(userId, {
    action: "security_incident.set_notification_assessment",
    resourceType: "SecurityIncident",
    resourceId: incident.id,
    before,
    after: incident,
  });
  return incident;
}

/** Append-only: no corresponding update/delete is exposed. */
export async function addIncidentEvent(incidentId: string, occurredAt: Date, description: string) {
  const { userId } = await requireSuperadmin();
  const event = await unscopedPrisma.incidentEvent.create({
    data: { incidentId, occurredAt, description, createdByUserId: userId },
  });
  await complianceAudit(userId, {
    action: "incident_event.create",
    resourceType: "IncidentEvent",
    resourceId: event.id,
    after: event,
  });
  return event;
}
