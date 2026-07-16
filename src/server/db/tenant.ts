import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Tenant-scoped Prisma (§4.3 layer 3).
 *
 * `tenantDb(orgId)` returns a Prisma client extension that transparently
 * injects `organizationId` into every query/mutation on tenant-owned models —
 * a forgotten `where` can no longer leak across organizations.
 *
 * Models scoped via a parent relation (Message, PipelineStage, DocumentChunk,
 * TagsOnContacts, EventAttendee, AvailabilityRule, AvailabilityOverride,
 * BookingToken) are NOT listed here; access them through their parent or
 * the dedicated service functions which join through the parent.
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
            case "updateMany":
            case "deleteMany":
              a.where = { ...(a.where as object), organizationId: orgId };
              break;
            case "create":
              a.data = { ...(a.data as object), organizationId: orgId };
              break;
            case "createMany":
              if (Array.isArray((a.data as unknown[]) ?? null)) {
                a.data = (a.data as object[]).map((d) => ({ ...d, organizationId: orgId }));
              }
              break;
            case "update":
            case "delete":
            case "upsert":
              // Unique-where ops: verify tenancy with an explicit filter.
              a.where = { ...(a.where as object), organizationId: orgId };
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
