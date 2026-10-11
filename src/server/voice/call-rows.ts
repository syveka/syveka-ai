import type { Prisma } from "@/generated/prisma/client/client";

type VoiceCallClient = { voiceCall: Prisma.TransactionClient["voiceCall"] };

/**
 * Upserts a call row only within `orgId`. vapiCallId is unique across organizations,
 * and Prisma plans this upsert two ways (pinned by voice-call-rows-prisma.test.ts):
 * - with fields to update, one `INSERT ... ON CONFLICT (vapi_call_id) DO UPDATE ...
 *   WHERE organization_id = orgId`. Another organization's call id updates nothing
 *   there and returns no row, which Prisma reports as null;
 * - with nothing to update, a SELECT within the organization, then a plain INSERT,
 *   which fails with P2002 on any existing row: another organization's call, or this
 *   organization's own concurrent first write (status-update racing
 *   end-of-call-report), which is retried once.
 * Another organization's row is never changed; "foreign" is returned for it. Any other
 * database error propagates so Vapi retries.
 */
export async function upsertOwnCall(
  db: VoiceCallClient,
  orgId: string,
  args: {
    vapiCallId: string;
    create: Prisma.VoiceCallUncheckedCreateInput;
    update: Prisma.VoiceCallUncheckedUpdateInput;
  },
): Promise<"ok" | "foreign"> {
  // Typed as never null; a conflict that updates nothing is the exception.
  const upsert = (): Promise<{ id: string } | null> =>
    db.voiceCall.upsert({
      where: { vapiCallId: args.vapiCallId, organizationId: orgId },
      create: args.create,
      update: args.update,
      select: { id: true },
    });
  try {
    if (await upsert()) return "ok";
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "P2002") throw err;
    const own = await db.voiceCall.findFirst({
      where: { vapiCallId: args.vapiCallId, organizationId: orgId },
      select: { id: true },
    });
    if (own && (await upsert())) return "ok";
  }
  console.error(JSON.stringify({ event: "voice_call_org_conflict", orgId }));
  return "foreign";
}
