import "server-only";

import { spokenDisclosure } from "@/server/ai/prompts/voice";
import { redis } from "@/server/integrations/redis";
import { getVapiAssistant } from "@/server/integrations/vapi";

/**
 * The spoken AI notice is a launch blocker, so it is enforced at each call rather than
 * trusted from configuration: a dashboard edit, or an assistant not re-synced since the
 * notice changed, would otherwise go unnoticed. What the notice says, and whether calls are
 * recorded, are legal decisions that this code doesn't make.
 */
export type DisclosureCheck =
  "ok" | "language_not_approved" | "live_config_mismatch" | "unverifiable";

/** Long enough for one real call to outlive its check, and no longer. */
const VERIFIED_TTL_SECONDS = 2 * 60 * 60;
const VERIFY_TIMEOUT_MS = 3_000;

const verifiedKey = (orgId: string, vapiCallId: string) =>
  `voice:disclosure-ok:${orgId}:${vapiCallId}`;

/**
 * Languages whose wording counsel and a native speaker have approved. Empty by default, so
 * no call can proceed in any language until someone decides, deliberately, per environment.
 */
export function disclosureApprovedLanguages(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return new Set(
    (env.VOICE_DISCLOSURE_APPROVED_LANGUAGES ?? "")
      .split(",")
      .map((language) => language.trim())
      .filter(Boolean),
  );
}

export type LiveAssistantConfig = {
  firstMessage?: string | null;
  firstMessageMode?: string | null;
  firstMessageInterruptionsEnabled?: boolean | null;
};

/** The notice comes first, in the right language, spoken by Vapi in full. */
export function liveConfigDisclosesFirst(language: string, live: LiveAssistantConfig): boolean {
  const notice = spokenDisclosure(language);
  if (notice === null || typeof live.firstMessage !== "string") return false;
  return (
    live.firstMessage.startsWith(notice) &&
    (live.firstMessageMode ?? "assistant-speaks-first") === "assistant-speaks-first" &&
    live.firstMessageInterruptionsEnabled !== true
  );
}

/** Checks a connecting call against the live config. Anything unconfirmed fails closed. */
export async function verifyCallDisclosure(params: {
  orgId: string;
  vapiCallId: string;
  language: string;
  vapiAssistantId: string;
  /** The assistant as sent in the signed webhook, used only when it answers fully. */
  reported?: LiveAssistantConfig | null;
  /** This call's own overrides, which a fetch of the assistant wouldn't show. */
  overrides?: Record<string, unknown> | null;
}): Promise<DisclosureCheck> {
  if (!disclosureApprovedLanguages().has(params.language)) return "language_not_approved";

  if (
    params.overrides &&
    ["firstMessage", "firstMessageMode", "firstMessageInterruptionsEnabled"].some(
      (field) => field in (params.overrides as object),
    )
  ) {
    return "live_config_mismatch";
  }

  let live: LiveAssistantConfig | null = null;
  const reported = params.reported;
  if (
    typeof reported?.firstMessage === "string" &&
    typeof reported.firstMessageMode === "string" &&
    typeof reported.firstMessageInterruptionsEnabled === "boolean"
  ) {
    live = reported;
  } else {
    try {
      live = await getVapiAssistant(params.vapiAssistantId, AbortSignal.timeout(VERIFY_TIMEOUT_MS));
    } catch {
      return "unverifiable";
    }
  }
  if (!liveConfigDisclosesFirst(params.language, live)) return "live_config_mismatch";

  try {
    await redis.set(verifiedKey(params.orgId, params.vapiCallId), "1", {
      ex: VERIFIED_TTL_SECONDS,
    });
  } catch {
    return "unverifiable";
  }
  return "ok";
}

/** Whether this call passed the check, or "unknown" when that can't be read. */
export async function callDisclosureState(
  orgId: string,
  vapiCallId: string,
): Promise<"verified" | "unverified" | "unknown"> {
  try {
    return (await redis.get(verifiedKey(orgId, vapiCallId))) ? "verified" : "unverified";
  } catch {
    return "unknown";
  }
}
