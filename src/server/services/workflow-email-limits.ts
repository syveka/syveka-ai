import "server-only";

import { z } from "zod";
import { checkRateLimit, type RateLimiters } from "@/server/integrations/redis";
import { emailKey } from "@/server/security/rate-limit";

/**
 * A workflow email.send recipient as one plain address, trimmed and
 * lowercased, or null when it is anything else: a display name
 * ("Name <a@x>"), several addresses (comma, semicolon, space), or any control
 * character (CR/LF would let a template value add mail headers). Checked
 * before the trim, so a value can't hide a line break at either end.
 * Plus-addressing and dots are kept: the address is delivered as written.
 */
export function normalizeWorkflowRecipient(raw: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const address = raw.trim().toLowerCase();
  if (address.length > 254) return null;
  return z.email().safeParse(address).success ? address : null;
}

export type WorkflowEmailLimitScope =
  "organization_hour" | "organization_day" | "recipient_day" | "recipient_all_organizations_day";

export type WorkflowEmailAdmission =
  | { ok: true }
  | { ok: false; reason: "limited"; scope: WorkflowEmailLimitScope }
  | { ok: false; reason: "unavailable" };

/**
 * Spends one unit of each workflow email limit for one send, in order: the
 * organization's hourly and daily budget, the organization's daily
 * allowance for this recipient, then the recipient's daily allowance across
 * all organizations. The recipient is keyed by a hash of the
 * mailbox (emailKey), never the address, and aliases of one mailbox share
 * it. Each check is one atomic Redis operation; the first refusal stops,
 * so a later limit is not spent for a send that won't happen. Limits spent
 * before an unavailable check stay spent: a retry can over-count, never
 * exceed.
 */
export async function admitWorkflowEmail(
  organizationId: string,
  recipient: string,
): Promise<WorkflowEmailAdmission> {
  const mailbox = emailKey(recipient);
  const checks: Array<[keyof RateLimiters, string, WorkflowEmailLimitScope]> = [
    ["workflowEmailOrgHour", organizationId, "organization_hour"],
    ["workflowEmailOrgDay", organizationId, "organization_day"],
    ["workflowEmailRecipientDay", `${organizationId}:${mailbox}`, "recipient_day"],
    ["workflowEmailRecipientAnyOrgDay", mailbox, "recipient_all_organizations_day"],
  ];
  for (const [name, key, scope] of checks) {
    const decision = await checkRateLimit(name, key);
    if (!decision.ok) {
      return decision.reason === "unavailable"
        ? { ok: false, reason: "unavailable" }
        : { ok: false, reason: "limited", scope };
    }
  }
  return { ok: true };
}
