/**
 * Why accepting an invitation failed, as a fixed code. The code is the only
 * thing that leaves the server (as `?error=` on the invitation page), so it
 * never carries seat counts, plan details, exception text or anything about
 * the organization.
 */
export const INVITATION_ACCEPT_ERROR_CODES = [
  "invalid",
  "expired",
  "seat_limit",
  "read_only",
  "already_member",
] as const;

export type InvitationAcceptErrorCode = (typeof INVITATION_ACCEPT_ERROR_CODES)[number];

/** A client-supplied `?error=` value, or null unless it is exactly one of the codes. */
export function parseInvitationAcceptError(value: unknown): InvitationAcceptErrorCode | null {
  return typeof value === "string" &&
    (INVITATION_ACCEPT_ERROR_CODES as readonly string[]).includes(value)
    ? (value as InvitationAcceptErrorCode)
    : null;
}
