import "server-only";

import type { VoiceAssistant } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import {
  upsertVapiAssistant,
  buyPhoneNumber,
  importPhoneNumber,
  type VapiAssistantConfig,
  type PhoneImportParams,
} from "@/server/integrations/vapi";
import { TOOL_REGISTRY, zodToJsonSchema } from "@/server/ai/tools";
import { buildVoiceSystemPrompt } from "@/server/ai/prompts/voice";
import { getBusinessDnaContext } from "@/server/business-dna/context";
import { getEntitlements } from "./billing/entitlements";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { VoiceAssistantInput, AttachPhoneNumberInput } from "@/lib/validators/voice";
import { getVapiEnv } from "@/env";

export class DuplicatePhoneNumberError extends Error {}
export class AssistantNotSyncedError extends Error {}

/** Zod tool schemas → OpenAI-function JSON for Vapi (§16.2). */
function vapiToolsFor(enabledNames: string[]) {
  return TOOL_REGISTRY.filter((t) => enabledNames.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: zodToJsonSchema(t.schema),
  }));
}

export async function listAssistants(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.voiceAssistant.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { calls: true } } },
  });
}

export async function upsertAssistant(
  ctx: TenantContext,
  input: VoiceAssistantInput,
  assistantId?: string,
) {
  const db = tenantDb(ctx.orgId);

  if (!assistantId) {
    const ent = await getEntitlements(ctx.orgId);
    const count = await db.voiceAssistant.count();
    if (count >= ent.voiceAssistants) {
      throw new Error("Voice assistant limit reached for your plan");
    }
  }

  const data = {
    organizationId: ctx.orgId,
    name: input.name,
    language: input.language,
    voiceProvider: input.voiceProvider,
    voiceId: input.voiceId || null,
    firstMessage: input.firstMessage,
    systemPrompt: input.systemPrompt,
    enabledTools: input.enabledTools,
    useKnowledgeBase: input.useKnowledgeBase,
    transferNumber: input.transferNumber || null,
  };

  const assistant = assistantId
    ? await db.voiceAssistant.update({ where: { id: assistantId }, data })
    : await db.voiceAssistant.create({ data });

  // If already linked to Vapi, re-sync config on every save (§16.2)
  if (assistant.vapiAssistantId) {
    await syncToVapi(assistant.id, ctx.orgId);
  }

  await audit(ctx, {
    action: assistantId ? "voice_assistant.update" : "voice_assistant.create",
    resourceType: "voice_assistant",
    resourceId: assistant.id,
    after: { name: input.name, language: input.language },
  });
  return assistant;
}

export type ActivateAssistantResult = {
  assistant: VoiceAssistant;
  /** Set when the Vapi assistant synced successfully but no phone number
   * could be provisioned -- never a reason to fail the whole activation. */
  phoneNumberError: string | null;
};

/**
 * Activate: upsert on Vapi, then attempt to provision a number (§16.2).
 *
 * These two steps are deliberately NOT all-or-nothing. `syncToVapi` already
 * persists `vapiAssistantId` to the DB the moment Vapi confirms the assistant
 * exists (see below) -- so a failure here never loses that work, and a retry
 * calls `upsertVapiAssistant` with the now-persisted id, which PATCHes the
 * existing Vapi assistant instead of creating a duplicate.
 *
 * Vapi's native ("vapi" provider) number pool is US-only -- there is no
 * account/architecture support today for a real +358 number (Vapi also
 * supports importing a number already held with Twilio/Vonage/a BYO SIP
 * trunk, but Syveka has no such integration yet). If provisioning fails for
 * any reason, that is treated as an expected, non-fatal outcome: the
 * assistant stays fully synced and re-activatable, `isActive` stays false
 * (setup-readiness and the dashboard already key off isActive + a real
 * phoneNumber, so this correctly keeps reading as "not yet call-ready"), and
 * the caller decides how to surface `phoneNumberError` -- never by silently
 * assigning a US number to a Finnish customer.
 */
export async function activateAssistant(
  ctx: TenantContext,
  assistantId: string,
): Promise<ActivateAssistantResult> {
  const db = tenantDb(ctx.orgId);
  const assistant = await db.voiceAssistant.findFirstOrThrow({ where: { id: assistantId } });

  const vapiId = await syncToVapi(assistantId, ctx.orgId);

  let phoneNumber = assistant.phoneNumber;
  let phoneNumberError: string | null = null;
  if (!phoneNumber) {
    try {
      const number = await buyPhoneNumber(vapiId);
      phoneNumber = number.number;
    } catch (error) {
      phoneNumberError =
        error instanceof Error ? error.message : "Phone number provisioning failed";
    }
  }

  const updated = await db.voiceAssistant.update({
    where: { id: assistantId },
    data: { isActive: Boolean(phoneNumber), phoneNumber, vapiAssistantId: vapiId },
  });

  await audit(ctx, {
    action: phoneNumber ? "voice_assistant.activate" : "voice_assistant.sync_pending_number",
    resourceType: "voice_assistant",
    resourceId: assistantId,
    after: { phoneNumber, phoneNumberError },
  });
  return { assistant: updated, phoneNumberError };
}

/**
 * Attach a number the org already holds with an external carrier (Twilio, or
 * a generic BYO SIP trunk) to an assistant already synced to Vapi -- the
 * only route to a real +358 (or any other non-US/CA) number today, since
 * Vapi's own native pool (buyPhoneNumber, above) is US/Canada-only.
 *
 * - Requires the assistant to already have a vapiAssistantId (call
 *   activateAssistant()/syncToVapi() first) -- there is no Vapi assistant to
 *   attach a number to otherwise.
 * - Duplicate-number protection is checked across ALL organizations
 *   (unscopedPrisma), not just this one -- two different Syveka orgs can
 *   never legitimately hold the same real external number, and a per-org
 *   check alone would miss a cross-tenant collision.
 * - Idempotent: re-attaching the exact number already on this assistant is a
 *   no-op success, not an error or a second Vapi import call.
 * - Twilio Account SID/Auth Token are used only for the single Vapi import
 *   request below and are never written to the database -- only the
 *   resulting phone number (already public/known) is persisted, exactly
 *   like buyPhoneNumber's own number-only persistence.
 */
export async function attachPhoneNumber(
  ctx: TenantContext,
  assistantId: string,
  input: AttachPhoneNumberInput,
): Promise<VoiceAssistant> {
  const db = tenantDb(ctx.orgId);
  const assistant = await db.voiceAssistant.findFirstOrThrow({ where: { id: assistantId } });

  if (!assistant.vapiAssistantId) {
    throw new AssistantNotSyncedError(
      "Save and sync the assistant before attaching a phone number.",
    );
  }

  if (assistant.phoneNumber === input.phoneNumber) {
    return assistant; // already attached -- idempotent no-op
  }

  const existingOwner = await unscopedPrisma.voiceAssistant.findFirst({
    where: { phoneNumber: input.phoneNumber, id: { not: assistantId } },
    select: { id: true },
  });
  if (existingOwner) {
    throw new DuplicatePhoneNumberError(
      "This phone number is already attached to another assistant.",
    );
  }

  const importParams: PhoneImportParams =
    input.provider === "twilio"
      ? {
          provider: "twilio",
          phoneNumber: input.phoneNumber,
          twilioAccountSid: input.twilioAccountSid ?? "",
          twilioAuthToken: input.twilioAuthToken ?? "",
        }
      : {
          provider: "byo-phone-number",
          phoneNumber: input.phoneNumber,
          sipUri: input.sipUri ?? "",
        };

  const number = await importPhoneNumber(assistant.vapiAssistantId, importParams);

  const updated = await db.voiceAssistant.update({
    where: { id: assistantId },
    data: { isActive: true, phoneNumber: number.number },
  });

  await audit(ctx, {
    action: "voice_assistant.attach_phone_number",
    resourceType: "voice_assistant",
    resourceId: assistantId,
    after: { provider: input.provider, phoneNumber: number.number },
  });
  return updated;
}

async function syncToVapi(assistantId: string, orgId: string): Promise<string> {
  const assistant = await unscopedPrisma.voiceAssistant.findFirstOrThrow({
    where: { id: assistantId, organizationId: orgId },
  });

  const enabledTools = (assistant.enabledTools as string[]) ?? [];
  const toolNames = assistant.useKnowledgeBase
    ? [...new Set(["searchKnowledgeBase", ...enabledTools])]
    : enabledTools;

  // Mandatory AI disclosure (§13.3, §16.5) is prepended server-side.
  const disclosure =
    assistant.language === "FI"
      ? "Aloita kertomalla, että olet tekoälyavustaja ja puhelu voidaan tallentaa."
      : "Start by disclosing that you are an AI assistant and the call may be recorded.";

  // Business DNA is optional — the assistant degrades gracefully (falls back
  // to just the human-authored prompt) when the org hasn't filled it in yet.
  const businessDna = await getBusinessDnaContext(orgId);

  const { NEXT_PUBLIC_APP_URL, VAPI_WEBHOOK_CREDENTIAL_ID } = getVapiEnv();
  const config: VapiAssistantConfig = {
    name: assistant.name,
    firstMessage: assistant.firstMessage,
    systemPrompt: buildVoiceSystemPrompt({
      disclosure,
      businessDna,
      assistantSystemPrompt: assistant.systemPrompt,
      transferNumber: assistant.transferNumber,
    }),
    language: assistant.language.toLowerCase() as "fi" | "en" | "ar",
    voiceProvider: assistant.voiceProvider,
    voiceId: assistant.voiceId,
    serverUrl: `${NEXT_PUBLIC_APP_URL}/api/v1/voice/webhook`,
    serverCredentialId: VAPI_WEBHOOK_CREDENTIAL_ID,
    tools: vapiToolsFor(toolNames),
    maxDurationSeconds: 15 * 60, // §16.5
  };

  const { id } = await upsertVapiAssistant(config, assistant.vapiAssistantId);
  if (id !== assistant.vapiAssistantId) {
    await unscopedPrisma.voiceAssistant.update({
      where: { id: assistantId },
      data: { vapiAssistantId: id },
    });
  }
  return id;
}

/**
 * Re-syncs Business DNA (and any other assistant-config-affecting data) to
 * every already-Vapi-linked assistant for an org. `upsertAssistant` already
 * re-syncs on every save of the assistant record itself (line ~68 above),
 * but a Business DNA edit alone previously never reached a live assistant at
 * all - it could keep quoting stale pricing/policy/hours indefinitely. This
 * is the trigger business-dna.ts calls after a successful save so that
 * config change reaches Vapi too, not just an assistant-record save.
 *
 * Best-effort per assistant: one assistant's Vapi call failing (e.g. a
 * transient Vapi outage) must not prevent the others from syncing, and must
 * never throw back into the caller - by the time this runs, the caller's own
 * write has already committed. Matches the existing best-effort pattern used
 * for non-critical follow-up work elsewhere (e.g. post-call/route.ts's
 * AI-summary step). Failures are logged (never containing assistant config
 * content, only ids) so a stuck sync is diagnosable, not silent.
 */
export async function resyncActiveAssistants(orgId: string): Promise<void> {
  try {
    const db = tenantDb(orgId);
    const assistants = await db.voiceAssistant.findMany({
      where: { vapiAssistantId: { not: null } },
      select: { id: true },
    });

    await Promise.all(
      assistants.map(async ({ id }) => {
        try {
          await syncToVapi(id, orgId);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "voice_assistant_resync_failed",
              organizationId: orgId,
              assistantId: id,
              message: error instanceof Error ? error.message : "unknown error",
            }),
          );
        }
      }),
    );
  } catch (error) {
    // Belt-and-suspenders around the lookup itself (e.g. a transient DB
    // error) - the per-assistant try/catch above only covers syncToVapi.
    // This function must never throw, full stop; see the doc comment above.
    console.error(
      JSON.stringify({
        event: "voice_assistant_resync_lookup_failed",
        organizationId: orgId,
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
  }
}

export async function listCalls(ctx: TenantContext, params?: { assistantId?: string }) {
  const db = tenantDb(ctx.orgId);
  return db.voiceCall.findMany({
    where: params?.assistantId ? { assistantId: params.assistantId } : {},
    orderBy: { startedAt: "desc" },
    take: 100,
    include: { assistant: { select: { name: true } } },
  });
}
