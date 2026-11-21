import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { getEntitlements } from "@/server/services/billing/entitlements";
import { hasVoiceEntitlement } from "@/lib/billing/plan-catalog";

export type VoiceAccess = {
  /** The plan (plus grants) includes the voice receptionist. */
  entitled: boolean;
  /** The organization already has an assistant (and possibly calls). */
  hasAssistant: boolean;
  /**
   * Voice surfaces are shown: always when entitled, and read-only for an
   * organization that lost voice but still has an assistant and its calls
   * (so it can review them and deactivate). An organization that never had
   * voice sees none of it.
   */
  visible: boolean;
};

export function voiceAccessFrom(
  limits: { voiceAssistants: number },
  assistantCount: number,
): VoiceAccess {
  const entitled = hasVoiceEntitlement(limits);
  const hasAssistant = assistantCount > 0;
  return { entitled, hasAssistant, visible: entitled || hasAssistant };
}

export async function getVoiceAccess(orgId: string): Promise<VoiceAccess> {
  const [ent, assistantCount] = await Promise.all([
    getEntitlements(orgId),
    tenantDb(orgId).voiceAssistant.count(),
  ]);
  return voiceAccessFrom(ent, assistantCount);
}
