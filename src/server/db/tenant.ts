import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Tenant-scoped Prisma (§4.3 layer 3).
 *
 * `tenantDb(orgId)` returns a Prisma client extension that transparently
 * injects `organizationId` into every query/mutation on tenant-owned models —
 * a forgotten `where` can no longer leak across organizations, and a
 * client-influenced write payload (`create`/`update`/`upsert`'s `data`,
 * `create`, or `update` body) can never plant or reassign a row into another
 * organization, since `organizationId` is always overridden there too, after
 * any caller-supplied value.
 *
 * Models scoped via a parent relation (Message, PipelineStage, DocumentChunk,
 * TagsOnContacts, EventAttendee, AvailabilityRule, AvailabilityOverride,
 * BookingToken, InboxMessage) are NOT listed here; access them through their
 * parent or the dedicated service functions which join through the parent.
 */
const TENANT_MODELS = new Set<Prisma.ModelName>([
  "OrganizationMember",
  "Team",
  "Invitation",
  "Subscription",
  "UsageRecord",
  "Company",
  "Contact",
  "Pipeline",
  "Deal",
  "Activity",
  "Tag",
  "CalendarEvent",
  "CalendarConnection",
  "ExternalCalendar",
  "CalendarSyncState",
  "AvailabilitySchedule",
  "BookingType",
  "Booking",
  "Reminder",
  "Conversation",
  "ConversationDocument",
  "Collection",
  "Document",
  "DocumentUploadIntent",
  "Workflow",
  "WorkflowRun",
  "VoiceAssistant",
  "VoiceCall",
  "Notification",
  "ApiKey",
  "WebhookEndpoint",
  "AuditLog",
  "Prompt",
  "BusinessDNA",
  "BusinessDnaService",
  "InboxThread",
  "InboxMailbox",
]);

export function tenantDb(orgId: string) {
  if (!orgId) throw new Error("tenantDb: orgId is required");

  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODELS.has(model)) return query(args);

          const a = args as Record<string, unknown>;

          switch (operation) {
            case "findFirst":
            case "findFirstOrThrow":
            case "findMany":
            case "findUnique":
            case "findUniqueOrThrow":
            case "count":
            case "aggregate":
            case "groupBy":
            case "deleteMany":
              a.where = { ...(a.where as object), organizationId: orgId };
              break;
            case "create":
              a.data = { ...(a.data as object), organizationId: orgId };
              break;
            case "updateMany":
              // Like update(): override organizationId in the write payload too, not
              // just where, so a client-influenced data body can never bulk-reassign
              // rows into another organization.
              a.where = { ...(a.where as object), organizationId: orgId };
              a.data = { ...(a.data as object), organizationId: orgId };
              break;
            case "createMany":
              if (Array.isArray((a.data as unknown[]) ?? null)) {
                a.data = (a.data as object[]).map((d) => ({ ...d, organizationId: orgId }));
              }
              break;
            case "delete":
              // Unique-where op: verify tenancy with an explicit filter.
              a.where = { ...(a.where as object), organizationId: orgId };
              break;
            case "update":
              // Unique-where op: verify tenancy with an explicit filter, and - like
              // create() - override organizationId in the write payload too, so a
              // client-influenced data body can never reassign a row to another
              // organization.
              a.where = { ...(a.where as object), organizationId: orgId };
              a.data = { ...(a.data as object), organizationId: orgId };
              break;
            case "upsert":
              // Unique-where ops: verify tenancy with an explicit filter, and -
              // like create() - override organizationId in both write payloads so a
              // client-influenced create/update body can never plant a row (or flip
              // an existing one) into another organization.
              a.where = { ...(a.where as object), organizationId: orgId };
              a.create = { ...(a.create as object), organizationId: orgId };
              a.update = { ...(a.update as object), organizationId: orgId };
              break;
            default:
              break;
          }
          return query(args);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;

/** Escape hatch for cross-tenant infrastructure code (webhooks, jobs). */
export { prisma as unscopedPrisma };
