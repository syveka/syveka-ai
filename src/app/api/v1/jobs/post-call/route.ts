import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const payloadSchema = z.object({
  vapiCallId: z.string(),
  orgId: z.string().uuid(),
});

const analysisSchema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  followUps: z.array(z.string()).max(5),
});

/** The model's reply as an analysis, or null when it is not the requested JSON. */
function parseAnalysis(reply: string): z.infer<typeof analysisSchema> | null {
  try {
    const json = analysisSchema.safeParse(JSON.parse(reply.replace(/^```json?|```$/g, "").trim()));
    return json.success ? json.data : null;
  } catch {
    return null;
  }
}

function logSummaryFailure(
  orgId: string,
  callId: string,
  reason: "provider_error" | "invalid_response",
): void {
  console.error(JSON.stringify({ event: "post_call_summary_failed", orgId, callId, reason }));
}

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { verifyJobRequest },
    { unscopedPrisma },
    { anthropic },
    { routeModel },
    { recordUsage },
    { emitWorkflowEvent },
    { isOrganizationActive, ORGANIZATION_INACTIVE },
    { callerPhoneIdentity, PHONE_SEPARATOR_SQL_PATTERN },
    { lockContactPhone },
  ] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/db/tenant"),
    import("@/server/integrations/anthropic"),
    import("@/server/ai/router"),
    import("@/server/services/billing/entitlements"),
    import("@/server/services/workflow-events"),
    import("@/server/jobs/organization-guard"),
    import("@/lib/crm/phone-identity"),
    import("@/server/calendar/locks"),
  ]);

  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { vapiCallId, orgId } = parsed.data;

  // A missing or soft-deleted organization gets no usage record, contact,
  // paid summary, notification or workflow event; the call stays unprocessed.
  if (!(await isOrganizationActive(orgId))) return NextResponse.json(ORGANIZATION_INACTIVE);

  const call = await unscopedPrisma.voiceCall.findFirst({
    where: { vapiCallId, organizationId: orgId },
    include: { assistant: { select: { name: true, language: true } } },
  });
  if (!call) return NextResponse.json({ skipped: "call not found" });

  // Idempotency guard against QStash retrying this job invocation after a
  // partial failure (distinct from the webhook's own dedupe key, which only
  // prevents the same end-of-call-report *event* from being enqueued twice
  // — see src/app/api/v1/voice/webhook/route.ts). Without this, a retry
  // would double-record VOICE_MINUTES usage and create a duplicate CRM
  // activity/summary. Set only after every step below completes.
  if (call.postCallProcessedAt) {
    return NextResponse.json({ ok: true, alreadyProcessed: true });
  }

  // Two runs of this job for the same call can overlap: a duplicate end-of-call report
  // that QStash's dedupe window misses, or a retry while a slow first attempt is still
  // running. Under READ COMMITTED both would pass each "already recorded?" check below
  // before either inserts, and record the minutes, the activity or the notification
  // twice. Each check-then-insert therefore runs in its own transaction holding a lock
  // on the call (transaction-scoped: released at commit or rollback, no schema change),
  // so the second run waits and then sees the first's row. Each step commits on its
  // own, so a retry after a partial failure redoes only what is missing.
  const lockedStep = <T>(step: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    unscopedPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('post_call'), hashtext(${call.id}))`;
      return step(tx);
    });

  // 1. Usage metering — minutes rounded up (§14.2)
  //
  // The postCallProcessedAt guard above only catches a retry of a call that
  // already finished successfully (e.g. the response was lost after a 200).
  // QStash retries because a *prior attempt failed partway through* just as
  // often, and postCallProcessedAt is only set at the very end — a retry of
  // that kind reaches this line with postCallProcessedAt still null. recordUsage
  // is a bare INSERT with no upsert-by-call key, so without this explicit
  // existence check, that retry would double-count VOICE_MINUTES (and the
  // quota gate in the webhook's status-update handler would over-count with
  // it). Steps 2 and 4 below don't need the same treatment: contact match/
  // create already falls back to a phone lookup that finds step 2's own
  // prior result, and emitWorkflowEvent has its own sourceEventKey-based
  // idempotency (see workflow-events.ts).
  const minutes = Math.max(1, Math.ceil((call.durationSeconds ?? 0) / 60));
  await lockedStep(async (tx) => {
    const usageAlreadyRecorded = await tx.usageRecord.findFirst({
      where: {
        organizationId: orgId,
        metric: "VOICE_MINUTES",
        metadata: { path: ["callId"], equals: call.id },
      },
      select: { id: true },
    });
    if (!usageAlreadyRecorded) {
      await recordUsage(orgId, "VOICE_MINUTES", minutes, { callId: call.id }, tx);
    }
  });

  // 2. Contact match/create from caller number (§16.4)
  //
  // A caller whose number identifies no one (anonymous, invalid) gets no contact.
  // Otherwise an existing contact with the same number in any formatting is linked
  // (phone-identity.ts says which formats are certainly the same number). When
  // several contacts have the number, which one called is unknown: the call is
  // linked to none and no contact is created; the rest of the job still runs. Two
  // different calls from the same new caller can be processed at once, and the
  // per-call lock doesn't serialize them, so the lookup and create also hold a
  // lock on the (organization, number): the second waits, then finds the first's
  // contact. Lock order is always call, then number.
  let contactId = call.contactId;
  const identity = contactId ? null : callerPhoneIdentity(call.callerNumber);
  if (identity) {
    const step = await lockedStep(async (tx) => {
      await lockContactPhone(tx, orgId, identity.canonical);
      let matched: string | null = null;
      let created: Awaited<ReturnType<typeof tx.contact.create>> | null = null;
      // Two rows are enough to tell one match from several.
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM contacts
        WHERE organization_id = ${orgId}::uuid
          AND deleted_at IS NULL
          AND regexp_replace(phone, ${PHONE_SEPARATOR_SQL_PATTERN}, '', 'g') = ANY(${identity.matchForms}::text[])
        LIMIT 2`;
      if (existing.length > 1) {
        // Several contacts share the number (a household or a switchboard). Picking
        // one could attach this call to the wrong person, and creating another would
        // add a duplicate, so the call stays unlinked. Ids only, never the number.
        console.warn(
          JSON.stringify({ event: "post_call_contact_multiple_matches", orgId, callId: call.id }),
        );
      } else if (existing[0]) {
        matched = existing[0].id;
      } else if (call.status === "COMPLETED") {
        created = await tx.contact.create({
          data: {
            organizationId: orgId,
            firstName: identity.canonical, // placeholder until enriched
            phone: identity.canonical,
            source: "voice-ai",
            status: "LEAD",
          },
        });
        matched = created.id;
      }
      if (matched) {
        await tx.voiceCall.update({ where: { id: call.id }, data: { contactId: matched } });
      }
      return { matched, created };
    });
    contactId = step.matched;
    // `contact.created` only for a contact this run created, once its step has committed.
    // A retry finds call.contactId already set and skips this step, so it never emits
    // again; the contact id is also the event's dedupe key. A queue failure is logged
    // and never fails the job (the contact is already saved).
    if (step.created) {
      const created = step.created;
      await emitWorkflowEvent(
        orgId,
        "contact.created",
        {
          contactId: created.id,
          firstName: created.firstName,
          lastName: created.lastName,
          email: created.email,
          phone: created.phone,
          source: created.source,
        },
        created.id,
      ).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "contact_created_workflow_event_failed",
            orgId,
            contactId: created.id,
            errorName: error instanceof Error ? error.name : typeof error,
          }),
        );
      });
    }
  }

  // 3. AI summary + sentiment (Haiku-class, §15.2)
  //
  // `!call.summary` guards against the same partial-failure retry as step 1:
  // a summary saved by a prior attempt is never paid for again. Safe for calls
  // whose transcript is too short to summarize too: call.summary stays null and
  // this block is skipped identically on every attempt.
  //
  // The summary is best-effort: a provider failure or an unusable reply leaves the
  // call without one (logged with ids only, never the transcript). A database
  // failure saving it, or its activity below, fails the job so QStash retries --
  // marking the call processed would lose them for good.
  const transcriptText = JSON.stringify(call.transcript ?? []).slice(0, 30_000);
  // The workflow event below reports the sentiment computed here, not the value loaded before it.
  let sentiment = call.sentiment;
  let summary = call.summary;
  let followUps: unknown = call.actionsTaken;
  if (transcriptText.length > 10 && !call.summary) {
    let reply: string | null = null;
    try {
      const { model, maxTokens } = routeModel("summary");
      const res = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: `Analyze this phone call transcript. Respond with ONLY valid JSON: {"summary": "<3-5 sentence summary in ${
              call.assistant.language === "FI" ? "Finnish" : "English"
            }>", "sentiment": "positive"|"neutral"|"negative", "followUps": ["<action item>", ...max 5]}\n\nTranscript:\n${transcriptText}`,
          },
        ],
      });
      reply = res.content[0]?.type === "text" ? res.content[0].text : "";
    } catch {
      logSummaryFailure(orgId, call.id, "provider_error");
    }
    // The summary call can take a while: nothing more for an organization
    // deleted meanwhile (the call itself can't be recalled).
    if (!(await isOrganizationActive(orgId))) return NextResponse.json(ORGANIZATION_INACTIVE);

    const analysis = reply === null ? null : parseAnalysis(reply);
    if (reply !== null && !analysis) logSummaryFailure(orgId, call.id, "invalid_response");
    if (analysis) {
      await unscopedPrisma.voiceCall.update({
        where: { id: call.id },
        data: {
          summary: analysis.summary,
          sentiment: analysis.sentiment,
          actionsTaken: analysis.followUps,
        },
      });
      summary = analysis.summary;
      sentiment = analysis.sentiment;
      followUps = analysis.followUps;
    }
  }

  // The call's CRM activity, keyed by the call (not by the summary) so a retry after
  // the summary was saved but the activity was not still creates it, exactly once.
  if (summary && contactId) {
    const activityContactId = contactId;
    const activityBody = summary;
    await lockedStep(async (tx) => {
      const activityExists = await tx.activity.findFirst({
        where: {
          organizationId: orgId,
          type: "VOICE_AI_CALL",
          metadata: { path: ["voiceCallId"], equals: call.id },
        },
        select: { id: true },
      });
      if (!activityExists) {
        await tx.activity.create({
          data: {
            organizationId: orgId,
            contactId: activityContactId,
            type: "VOICE_AI_CALL",
            subject: `${call.assistant.name}: ${sentiment ?? "neutral"} call (${minutes} min)`,
            body: activityBody,
            metadata: { voiceCallId: call.id, followUps: followUps as string[] },
          },
        });
      }
    });
  }

  // 4. Notify org owner + workflow trigger (§16.4)
  //
  // Same partial-failure retry gap as steps 1 and 3: a retry whose prior
  // attempt got past this point but failed before the postCallProcessedAt
  // marker (e.g. emitWorkflowEvent's enqueue call failing, or the marker
  // write itself failing) would otherwise create a second `call.completed`
  // notification for the same call. `href` is `/voice/calls/${call.id}` —
  // unique per call — so it's the natural existence key, matching the same
  // find-before-create idiom step 1 already uses for usageRecord.
  if (!(await isOrganizationActive(orgId))) return NextResponse.json(ORGANIZATION_INACTIVE);

  const owner = await unscopedPrisma.organizationMember.findFirst({
    where: { organizationId: orgId, role: "OWNER" },
    select: { userId: true },
  });
  if (owner) {
    await lockedStep(async (tx) => {
      const notificationAlreadySent = await tx.notification.findFirst({
        where: { organizationId: orgId, type: "call.completed", href: `/voice/calls/${call.id}` },
        select: { id: true },
      });
      if (!notificationAlreadySent) {
        await tx.notification.create({
          data: {
            organizationId: orgId,
            userId: owner.userId,
            type: "call.completed",
            title: call.assistant.name,
            body: `${call.callerNumber ?? "Unknown"} · ${minutes} min`,
            href: `/voice/calls/${call.id}`,
          },
        });
      }
    });
  }

  await emitWorkflowEvent(
    orgId,
    "call.completed",
    {
      callId: call.id,
      contactId,
      durationSeconds: call.durationSeconds,
      sentiment,
    },
    call.id,
  );

  await unscopedPrisma.voiceCall.update({
    where: { id: call.id },
    data: { postCallProcessedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
