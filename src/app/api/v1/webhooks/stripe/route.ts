import { NextResponse } from "next/server";
import { sanitizeErrorMessage as sanitizeErrorMessageShared } from "@/server/security/error-sanitization";
import type Stripe from "stripe";
import type { Plan, Prisma } from "@/generated/prisma/client/client";
import type { unscopedPrisma as prismaClient } from "@/server/db/tenant";
import type { planForPriceId as resolvePlanForPriceId } from "@/server/integrations/stripe";
import type { invalidateEntitlements as invalidateBillingEntitlements } from "@/server/services/billing/entitlements";

export const runtime = "nodejs"; // raw-body signature verification
export const dynamic = "force-dynamic";

const SUB_STATUS_MAP: Record<Stripe.Subscription.Status, string> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  canceled: "CANCELED",
  incomplete: "INCOMPLETE",
  incomplete_expired: "CANCELED",
  unpaid: "PAST_DUE",
  paused: "PAUSED",
};

/**
 * A claimed-but-never-completed row older than this is treated as
 * abandoned (crashed serverless execution, killed process) and becomes
 * eligible for reclaim by the next delivery/retry, rather than staying
 * stuck in PROCESSING forever. Comfortably longer than this route's
 * realistic worst-case runtime (a couple of Stripe API round-trips plus a
 * short DB transaction).
 */
const STALE_PROCESSING_MS = 5 * 60_000;

/** Truncated, URL-redacted error text -- never the raw Stripe payload or a stack trace. */
function sanitizeErrorMessage(err: unknown): string {
  return sanitizeErrorMessageShared(err, 500);
}

/** Best-effort (orgId, objectId) extraction for ledger observability only -- never used for auth. */
function describeEvent(event: Stripe.Event): { orgId: string | null; objectId: string | null } {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      return { orgId: session.metadata?.orgId ?? null, objectId: session.id };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      return { orgId: sub.metadata.orgId ?? null, objectId: sub.id };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      return { orgId: null, objectId: invoice.id ?? null };
    }
    default:
      return { orgId: null, objectId: null };
  }
}

type RuntimeDeps = {
  planForPriceId: typeof resolvePlanForPriceId;
  invalidateEntitlements: typeof invalidateBillingEntitlements;
};

function customerIdOf(sub: Stripe.Subscription): string | null {
  return typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null);
}

/** Stripe statuses of a subscription that is paying (or in its trial). */
const PAYING_STRIPE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);
/** Our stored statuses of a current subscription that pays nothing and can be superseded. */
const SUPERSEDABLE_BY_PAYING: ReadonlySet<string> = new Set(["CANCELED", "INCOMPLETE"]);

/** Stripe statuses of a subscription whose latest payment failed and is being retried. */
const UNPAID_STRIPE_STATUSES: ReadonlySet<string> = new Set(["past_due", "unpaid"]);
const PLAN_RANK: Record<Plan, number> = { FREE: 0, STARTER: 1, PRO: 2, ENTERPRISE: 3 };

/**
 * Why a higher plan on the org's current subscription isn't granted yet:
 * - subscription_unpaid: Stripe reports it past_due/unpaid;
 * - invoice_unpaid: the change's own invoice (see planRaiseHold) still has
 *   an amount remaining, or its invoices can't be read in full;
 * - deferred_amount_due: the change's proration was left for a later
 *   invoice and that invoice will charge for it;
 * - invoice_voided: the change's invoice was voided and no replacement for
 *   it (a revision Stripe links to it) has been paid.
 */
type PlanRaiseHold =
  "subscription_unpaid" | "invoice_unpaid" | "deferred_amount_due" | "invoice_voided";

/**
 * The pre-transaction check's answer, and the stored plan it was made
 * against (null when the org's row wasn't this subscription's). The
 * transaction re-reads the row; a raise checked against anything else is
 * never applied (see applySubscriptionUpsert).
 */
type PlanRaiseCheck = { hold: PlanRaiseHold | null; checkedFrom: Plan | null };

function idOf(ref: string | { id: string } | null | undefined): string | null {
  return typeof ref === "string" ? ref : (ref?.id ?? null);
}

/** Lines beyond the first page, bounded; null when there are more than that. */
const MAX_LINE_PAGES = 10;
async function allLines(
  first: Stripe.ApiList<Stripe.InvoiceLineItem>,
  nextPage: (startingAfter: string) => Promise<Stripe.ApiList<Stripe.InvoiceLineItem>>,
): Promise<Stripe.InvoiceLineItem[] | null> {
  const lines = [...first.data];
  let page = first;
  for (let n = 0; page.has_more; n++) {
    const last = page.data.at(-1)?.id;
    if (n >= MAX_LINE_PAGES || !last) return null;
    page = await nextPage(last);
    lines.push(...page.data);
  }
  return lines;
}

/** What a line charges after its own discounts. */
function netOfDiscounts(line: Stripe.InvoiceLineItem): number {
  return line.amount - (line.discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0);
}

/**
 * Before the transaction (Stripe calls), for a plan change that would raise
 * the org's plan on its own current subscription: has Stripe been paid what
 * the change owes, in Stripe's current state? Only the change's own
 * evidence counts:
 *
 * 1. Deferred part (read first, so a proration moving from the upcoming
 *    invoice into a new draft is seen in one place or the other): the
 *    upcoming invoice's proration lines for this subscription, net of their
 *    discounts, capped by what that invoice will actually charge
 *    (amount_due, after customer balance). Positive → held. With no upcoming
 *    invoice (set to cancel), this subscription's pending items must net to
 *    nothing owed.
 * 2. Immediate part: newest first, this subscription's invoices back to the
 *    last regular period (a renewal or the first invoice, or a line billing
 *    the stored plan); older ones predate the change. The change's invoice
 *    charges the new price (a proration, or the new period of an interval
 *    change) and credits the old plan's unused time. It must be paid or
 *    have nothing remaining (amount_remaining is after discounts and
 *    credits). Voided, it holds until a replacement is paid (see
 *    voidedChangeReplacement). No such invoice: nothing was charged at once.
 *    A regular period that already bills the new price comes after the
 *    change, so the search goes on past it.
 *
 * So an old paid invoice, an old unpaid renewal, or another subscription's
 * lines never decide it. Null: not a raise on this subscription, or nothing
 * owed (a change with nothing due is granted once Stripe has applied it).
 * What can't be read in full holds; a Stripe error fails the event, and
 * Stripe's retry checks again.
 */
async function planRaiseHold(
  client: Stripe,
  db: typeof prismaClient,
  sub: Stripe.Subscription,
  deps: RuntimeDeps,
): Promise<PlanRaiseCheck> {
  const orgId = sub.metadata.orgId;
  const targetPriceId = sub.items.data[0]?.price.id ?? "";
  const plan = deps.planForPriceId(targetPriceId);
  if (!orgId || !plan) return { hold: null, checkedFrom: null };
  const stored = await db.subscription.findUnique({
    where: { organizationId: orgId },
    select: { plan: true, stripeSubscriptionId: true },
  });
  if (!stored || stored.stripeSubscriptionId !== sub.id) return { hold: null, checkedFrom: null };
  const checked = (hold: PlanRaiseHold | null) => ({ hold, checkedFrom: stored.plan });
  if (PLAN_RANK[plan] <= PLAN_RANK[stored.plan]) return checked(null);

  let upcoming: Stripe.UpcomingInvoice | null = null;
  try {
    upcoming = await client.invoices.retrieveUpcoming({ subscription: sub.id });
  } catch (err) {
    if ((err as { code?: unknown })?.code !== "invoice_upcoming_none") throw err;
  }
  if (!upcoming) {
    // No upcoming invoice (for example, set to cancel at period end): a
    // deferred proration may then never be invoiced, so this subscription's
    // pending items themselves must net to nothing owed.
    const customerId = customerIdOf(sub);
    if (!customerId) return checked("deferred_amount_due");
    let pending = 0;
    let startingAfter: string | undefined;
    for (let n = 0; ; n++) {
      if (n >= MAX_LINE_PAGES) return checked("deferred_amount_due");
      const items = await client.invoiceItems.list({
        customer: customerId,
        pending: true,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      pending += items.data
        .filter((i) => idOf(i.subscription) === sub.id)
        .reduce((sum, i) => sum + i.amount, 0);
      startingAfter = items.data.at(-1)?.id;
      if (!items.has_more) break;
      if (!startingAfter) return checked("deferred_amount_due");
    }
    if (pending > 0) return checked("deferred_amount_due");
  } else {
    const lines = await allLines(upcoming.lines, (startingAfter) =>
      client.invoices.listUpcomingLines({
        subscription: sub.id,
        limit: 100,
        starting_after: startingAfter,
      }),
    );
    if (!lines) return checked("deferred_amount_due");
    const deferred = lines
      .filter((l) => l.proration && idOf(l.subscription) === sub.id)
      .reduce((sum, l) => sum + netOfDiscounts(l), 0);
    if (Math.min(deferred, upcoming.amount_due) > 0) return checked("deferred_amount_due");
  }

  // The change's invoice charges the new price and credits the unused time
  // of the old one (any price that isn't the new plan's, legacy prices
  // included). A later seat-change proration on the new plan has no such
  // credit, so it never stands in for the change's invoice.
  const carriesChange = (invoice: Stripe.Invoice, lines: Stripe.InvoiceLineItem[]) => {
    const ofThis = lines.filter((l) => idOf(l.subscription) === sub.id);
    const chargesNew = ofThis.some(
      (l) =>
        l.price?.id === targetPriceId &&
        (l.proration || invoice.billing_reason === "subscription_update"),
    );
    const creditsOld = ofThis.some(
      (l) => l.proration && l.amount < 0 && (!l.price || deps.planForPriceId(l.price.id) !== plan),
    );
    return chargesNew && creditsOld;
  };
  const linesOf = (invoice: Stripe.Invoice) => {
    const invoiceId = invoice.id!;
    return allLines(invoice.lines, (startingAfter) =>
      client.invoices.listLineItems(invoiceId, { limit: 100, starting_after: startingAfter }),
    );
  };

  const recent = await client.invoices.list({ subscription: sub.id, limit: 10 });
  for (const invoice of recent.data) {
    if (idOf(invoice.subscription) !== sub.id || !invoice.id) continue;
    // A revision counts only as the replacement its voided original links
    // to (voidedChangeReplacement), never by resembling the change.
    if (invoice.from_invoice) continue;
    const lines = await linesOf(invoice);
    if (!lines) return checked(historyUnreadable(sub, "lines"));
    if (carriesChange(invoice, lines)) {
      if (invoice.status === "void") {
        const replacement = await voidedChangeReplacement(client, sub, invoice, (revision) =>
          linesOf(revision).then((l) => (l ? carriesChange(revision, l) : null)),
        );
        // Voided by an operator: never paid, so an operator should look,
        // whatever happens next.
        console.warn(
          JSON.stringify({
            alert: "stripe_plan_raise_on_void_invoice",
            subscriptionId: sub.id,
            invoiceId: invoice.id,
            replacement,
          }),
        );
        return checked(replacement === "paid" ? null : "invoice_voided");
      }
      const settled = invoice.status === "paid" || invoice.amount_remaining <= 0;
      return checked(settled ? null : "invoice_unpaid");
    }
    // An earlier regular period (whatever its price, unless it already bills
    // the new one) or the old plan billed: everything older predates the
    // change.
    const ofThis = lines.filter((l) => idOf(l.subscription) === sub.id);
    const billsNew = ofThis.some((l) => !l.proration && l.price?.id === targetPriceId);
    const regularPeriod =
      !billsNew &&
      (invoice.billing_reason === "subscription_cycle" ||
        invoice.billing_reason === "subscription_create");
    const billedOldPlan = ofThis.some(
      (l) => !l.proration && l.price && deps.planForPriceId(l.price.id) === stored.plan,
    );
    if (regularPeriod || billedOldPlan) return checked(null);
  }
  // Neither the change's invoice nor an earlier period among the newest:
  // can't tell which invoice is the change's, so it's held.
  return checked(recent.has_more ? historyUnreadable(sub, "invoices") : null);
}

/** How many revisions of a voided change invoice are followed. */
const MAX_REVISIONS = 5;

/**
 * A voided change invoice's replacement, by Stripe's own link only: the
 * voided invoice's latest_revision, which must point back to it
 * (from_invoice, action "revision"), be for the same customer, and still
 * carry the change. A voided revision is followed to its own revision.
 * - paid: the replacement is paid (Stripe marks a zero-total one paid);
 * - unpaid: a valid replacement is still owed;
 * - none: no replacement;
 * - unlinked: something claims to replace it but can't be tied to the
 *   change, or the chain is longer than followed.
 */
async function voidedChangeReplacement(
  client: Stripe,
  sub: Stripe.Subscription,
  voided: Stripe.Invoice,
  carriesChange: (revision: Stripe.Invoice) => Promise<boolean | null>,
): Promise<"paid" | "unpaid" | "none" | "unlinked"> {
  let current = voided;
  for (let n = 0; n < MAX_REVISIONS; n++) {
    const ref = current.latest_revision;
    if (!ref) return "none";
    const revision = typeof ref === "string" ? await client.invoices.retrieve(ref) : ref;
    const linked =
      revision.from_invoice?.action === "revision" &&
      idOf(revision.from_invoice.invoice) === current.id &&
      idOf(revision.customer) === customerIdOf(sub) &&
      (await carriesChange(revision)) === true;
    if (!linked) return "unlinked";
    if (revision.status === "void") {
      current = revision;
      continue;
    }
    return revision.status === "paid" ? "paid" : "unpaid";
  }
  return "unlinked";
}

/** A hold because the subscription's invoices couldn't be read in full: an operator should look. */
function historyUnreadable(sub: Stripe.Subscription, what: string): PlanRaiseHold {
  console.warn(
    JSON.stringify({ alert: "stripe_plan_raise_history_unreadable", subscriptionId: sub.id, what }),
  );
  return "invoice_unpaid";
}

/** Structured, non-sensitive alert: ids and statuses only, never customer data. */
function alertSkippedSubscription(fields: Record<string, string | null>): void {
  console.warn(JSON.stringify({ alert: "stripe_subscription_event_skipped", ...fields }));
}

/**
 * Whether `sub` may be written as the organization's current subscription.
 * The org has one row, so an event for any other subscription -- an older
 * one still being retired, a stale retry, a second checkout -- replaces it
 * only when the current one doesn't pay:
 * - no current subscription, or the same one: yes;
 * - the current one has ended (CANCELED): yes;
 * - the current one is INCOMPLETE (its first payment never went through) and
 *   `sub` is ACTIVE or TRIALING: yes, the paying one takes over;
 * - otherwise (the current one is ACTIVE, TRIALING, PAST_DUE or PAUSED, or
 *   `sub` itself isn't paying): no. A live `sub` skipped this way raises a
 *   structured alert, since the customer may be paying for two.
 * A subscription whose customer isn't the org's own Stripe customer never
 * touches it, whatever its metadata says. `sub` is Stripe's current state,
 * retrieved by the caller, so its status isn't a stale event copy.
 */
async function mayBecomeCurrent(
  tx: Prisma.TransactionClient,
  orgId: string,
  sub: Stripe.Subscription,
): Promise<boolean> {
  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { stripeCustomerId: true },
  });
  if (!org) return false;
  // Ownership is proven only by the org's stored Stripe customer, which
  // startCheckoutAction persists before any Checkout session exists. No
  // stored customer, or a subscription without one, proves nothing, so the
  // event is skipped (fail closed) rather than trusted on its metadata.
  const customerId = customerIdOf(sub);
  if (!org.stripeCustomerId || !customerId || org.stripeCustomerId !== customerId) {
    alertSkippedSubscription({
      reason: "customer_mismatch",
      organizationId: orgId,
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
    });
    return false;
  }

  const current = await tx.subscription.findUnique({
    where: { organizationId: orgId },
    select: { stripeSubscriptionId: true, status: true },
  });
  if (!current?.stripeSubscriptionId || current.stripeSubscriptionId === sub.id) return true;
  if (current.status === "CANCELED") return true;
  if (PAYING_STRIPE_STATUSES.has(sub.status) && SUPERSEDABLE_BY_PAYING.has(current.status)) {
    return true;
  }
  if (sub.status !== "canceled" && sub.status !== "incomplete_expired") {
    alertSkippedSubscription({
      reason: "other_subscription_current",
      organizationId: orgId,
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
      currentSubscriptionId: current.stripeSubscriptionId,
      currentStatus: current.status,
    });
  }
  return false;
}

/**
 * Runs inside the caller's transaction -- no external (Stripe API) calls here.
 * Returns the org id, and whether the subscription was written (see
 * mayBecomeCurrent); a skipped event is still completed, never retried.
 */
async function applySubscriptionUpsert(
  tx: Prisma.TransactionClient,
  sub: Stripe.Subscription,
  deps: RuntimeDeps,
  raiseCheck: PlanRaiseCheck,
): Promise<{ orgId: string; applied: boolean }> {
  const orgId = sub.metadata.orgId;
  if (!orgId) throw new Error(`Subscription ${sub.id} missing orgId metadata`);
  if (!(await mayBecomeCurrent(tx, orgId, sub))) return { orgId, applied: false };

  const item = sub.items.data[0];
  const priceId = item?.price.id ?? "";
  let plan = deps.planForPriceId(priceId);
  // Stripe applies a plan change to the subscription's items before (or
  // without) it being paid: a failed payment leaves it past_due on the new
  // price, and a change whose proration is left for a later invoice is
  // active on the new price with nothing paid. The higher plan is granted
  // only once Stripe reports the amount due for it paid (see planRaiseHold);
  // a later event (invoice.paid, the next update) re-applies Stripe's state.
  // Lower or equal plans, and changes with nothing owed, apply at once.
  const hold = UNPAID_STRIPE_STATUSES.has(sub.status) ? "subscription_unpaid" : raiseCheck.hold;
  const stored = plan
    ? await tx.subscription.findUnique({
        where: { organizationId: orgId },
        select: { plan: true, stripeSubscriptionId: true },
      })
    : null;
  const raises = Boolean(plan && stored && PLAN_RANK[plan] > PLAN_RANK[stored.plan]);
  if (
    raises &&
    hold === null &&
    stored?.stripeSubscriptionId === sub.id &&
    raiseCheck.checkedFrom !== stored.plan
  ) {
    // The row changed after the payment check (a concurrent event): the
    // check doesn't apply to this raise. Failing makes Stripe retry, and the
    // retry checks again against the row as it is then.
    throw new Error("stripe_plan_raise_check_stale");
  }
  if (plan && stored && hold) {
    if (raises) {
      console.warn(
        JSON.stringify({
          alert: "stripe_plan_raise_deferred_unpaid",
          organizationId: orgId,
          subscriptionId: sub.id,
          subscriptionStatus: sub.status,
          reason: hold,
        }),
      );
      plan = stored.plan;
    }
  }
  if (!plan) {
    // A price outside STRIPE_PRICE_* (a new or legacy price, another
    // currency): a new subscription is stored as FREE and an existing one
    // keeps its plan, so a paying customer may get the wrong limits. Nothing
    // here can map it; the alert is for an operator to fix the price ids.
    console.warn(
      JSON.stringify({
        alert: "stripe_unknown_price",
        organizationId: orgId,
        subscriptionId: sub.id,
        priceId,
        subscriptionStatus: sub.status,
      }),
    );
  }

  await tx.subscription.upsert({
    where: { organizationId: orgId },
    create: {
      organizationId: orgId,
      stripeSubscriptionId: sub.id,
      plan: plan ?? "FREE",
      status: SUB_STATUS_MAP[sub.status] as never,
      seats: item?.quantity ?? 1,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    },
    update: {
      stripeSubscriptionId: sub.id,
      ...(plan ? { plan } : {}),
      status: SUB_STATUS_MAP[sub.status] as never,
      seats: item?.quantity ?? 1,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    },
  });
  return { orgId, applied: true };
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const [
    { getStripeEnv },
    { stripe, planForPriceId },
    { unscopedPrisma },
    { invalidateEntitlements },
  ] = await Promise.all([
    import("@/env"),
    import("@/server/integrations/stripe"),
    import("@/server/db/tenant"),
    import("@/server/services/billing/entitlements"),
  ]);
  const deps: RuntimeDeps = { planForPriceId, invalidateEntitlements };

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      getStripeEnv().STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const { orgId: describedOrgId, objectId } = describeEvent(event);

  // ── Durable idempotency ledger (§14.4) ──
  // Ensure a row exists for this Stripe event id. Two concurrent first
  // deliveries can both reach this block; exactly one `create()` wins, the
  // other hits the unique constraint on `stripe_event_id` and falls through
  // to re-read whatever the winner wrote -- there is no window where two
  // rows exist for the same event.
  let justCreated = false;
  try {
    await unscopedPrisma.stripeWebhookEvent.create({
      data: { stripeEventId: event.id, eventType: event.type, organizationId: describedOrgId },
    });
    justCreated = true;
  } catch (err) {
    const isUniqueViolation =
      typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
    if (!isUniqueViolation) {
      console.error(`stripe webhook ${event.type} ledger create failed`, sanitizeErrorMessage(err));
      return NextResponse.json({ error: "ledger unavailable" }, { status: 500 });
    }
  }

  // A row we just created ourselves is always fresh (RECEIVED, 0 attempts) --
  // no need to re-read it. Only an existing row (the create() lost to a
  // unique-constraint conflict) needs its current state inspected.
  if (!justCreated) {
    const existing = await unscopedPrisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    if (!existing) {
      // Row vanished between create/re-read (should not happen barring an
      // external delete) -- fail closed, retryable.
      return NextResponse.json({ error: "ledger unavailable" }, { status: 500 });
    }

    if (existing.status === "COMPLETED") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    if (existing.status === "PROCESSING") {
      const staleSince = Date.now() - STALE_PROCESSING_MS;
      const isStale = !existing.lastAttemptAt || existing.lastAttemptAt.getTime() < staleSince;
      if (!isStale) {
        // Another execution is actively handling this exact event right now.
        // Acknowledge without reprocessing; the stale-reclaim window above
        // covers the case where that execution never finishes.
        return NextResponse.json({ received: true, processing: true });
      }
    }
  }

  // Atomic claim: RECEIVED/FAILED are always retriable; a PROCESSING row is
  // only retriable once it is stale. This is a conditional UPDATE, not a
  // read-then-write -- Postgres row-level locking makes it safe against two
  // concurrent requests claiming the same row (exactly one `updateMany`
  // matches; the loser's `count` is 0).
  const claimed = await unscopedPrisma.stripeWebhookEvent.updateMany({
    where: {
      stripeEventId: event.id,
      OR: [
        { status: { in: ["RECEIVED", "FAILED"] } },
        { status: "PROCESSING", lastAttemptAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
      ],
    },
    data: { status: "PROCESSING", attempts: { increment: 1 }, lastAttemptAt: new Date() },
  });
  if (claimed.count === 0) {
    // Lost the race to another concurrent claim, or the event completed
    // between our read above and this claim attempt.
    const nowState = await unscopedPrisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
      select: { status: true },
    });
    if (nowState?.status === "COMPLETED") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    return NextResponse.json({ received: true, processing: true });
  }

  try {
    let resolvedOrgId: string | null = describedOrgId;

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription && session.metadata?.orgId) {
          // Stripe API call happens before the DB transaction opens -- a
          // transaction must never hold a connection open across a network
          // round-trip to an external service.
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          if (!sub.metadata.orgId) {
            await stripe.subscriptions.update(sub.id, {
              metadata: { orgId: session.metadata.orgId },
            });
            sub.metadata.orgId = session.metadata.orgId;
          }
          const raiseCheck = await planRaiseHold(stripe, unscopedPrisma, sub, deps);
          await unscopedPrisma.$transaction(async (tx) => {
            ({ orgId: resolvedOrgId } = await applySubscriptionUpsert(tx, sub, deps, raiseCheck));
            await tx.stripeWebhookEvent.update({
              where: { stripeEventId: event.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
                organizationId: resolvedOrgId,
                objectId: sub.id,
              },
            });
          });
          await invalidateEntitlements(resolvedOrgId!);
        } else {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        // Stripe neither orders events nor stops retrying failed deliveries, so
        // this event's copy may be older than state already applied (e.g. an
        // "active" update retried after customer.subscription.deleted would
        // restore a paid plan). Apply the subscription's current state instead
        // -- fetched before the transaction opens, as for invoice.paid.
        const sub = await stripe.subscriptions.retrieve(event.data.object.id);
        if (sub.status === "canceled") {
          // customer.subscription.deleted owns the downgrade; a stale update
          // must neither revive nor downgrade anything on its own.
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, sub.id);
          break;
        }
        const raiseCheck = await planRaiseHold(stripe, unscopedPrisma, sub, deps);
        await unscopedPrisma.$transaction(async (tx) => {
          ({ orgId: resolvedOrgId } = await applySubscriptionUpsert(tx, sub, deps, raiseCheck));
          await tx.stripeWebhookEvent.update({
            where: { stripeEventId: event.id },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              organizationId: resolvedOrgId,
              objectId: sub.id,
            },
          });
        });
        await invalidateEntitlements(resolvedOrgId!);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const orgId = sub.metadata.orgId;
        if (orgId) {
          await unscopedPrisma.$transaction(async (tx) => {
            // Downgrade to FREE; data kept, over-limit features go read-only (§14.4).
            // Only when the deleted subscription is the org's current one: ending
            // an older or second subscription must not downgrade an org that is
            // still paying through another. No row to match is a no-op, not a
            // failure Stripe would retry forever.
            await tx.subscription.updateMany({
              where: { organizationId: orgId, stripeSubscriptionId: sub.id },
              data: { plan: "FREE", status: "CANCELED", stripeSubscriptionId: null },
            });
            await tx.stripeWebhookEvent.update({
              where: { stripeEventId: event.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
                organizationId: orgId,
                objectId: sub.id,
              },
            });
          });
          await invalidateEntitlements(orgId);
        } else {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        }
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object;
        const subId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const raiseCheck = await planRaiseHold(stripe, unscopedPrisma, sub, deps);
          await unscopedPrisma.$transaction(async (tx) => {
            ({ orgId: resolvedOrgId } = await applySubscriptionUpsert(tx, sub, deps, raiseCheck)); // clears PAST_DUE
            await tx.stripeWebhookEvent.update({
              where: { stripeEventId: event.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
                organizationId: resolvedOrgId,
                objectId: invoice.id ?? sub.id,
              },
            });
          });
          await invalidateEntitlements(resolvedOrgId!);
        } else {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const failedSubId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id;
        if (!failedSubId) {
          // A one-off invoice belongs to no subscription, so it can't make
          // the org's subscription PAST_DUE.
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, invoice.id ?? null);
          break;
        }
        // Same ordering hazard as subscription updates: a retried failure
        // delivered after invoice.paid must not mark a paid-up subscription
        // PAST_DUE. Only act while Stripe still reports an ESTABLISHED
        // subscription as unpaid. An `incomplete` one never paid: its first
        // invoice failing is not dunning, and PAST_DUE would keep the paid
        // plan's limits (entitlements) and block a later paying subscription
        // from becoming current (mayBecomeCurrent). It stays INCOMPLETE until
        // it pays (invoice.paid) or expires (incomplete_expired).
        const current = await stripe.subscriptions.retrieve(failedSubId);
        if (!["past_due", "unpaid"].includes(current.status)) {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, invoice.id ?? null);
          break;
        }
        const customerId =
          typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
        const org = customerId
          ? await unscopedPrisma.organization.findUnique({
              where: { stripeCustomerId: customerId },
              select: { id: true },
            })
          : null;
        if (org) {
          await unscopedPrisma.$transaction(async (tx) => {
            // Only the subscription this invoice is for: a failure on an
            // older or second subscription leaves the current one alone.
            await tx.subscription.updateMany({
              where: { organizationId: org.id, stripeSubscriptionId: failedSubId },
              data: { status: "PAST_DUE" },
            });
            await tx.stripeWebhookEvent.update({
              where: { stripeEventId: event.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
                organizationId: org.id,
                objectId: invoice.id ?? null,
              },
            });
          });
          await invalidateEntitlements(org.id);
          // Dunning email sequence is triggered by the billing service (day 0/3/7).
        } else {
          await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        }
        break;
      }
      default:
        // Unhandled event types are acknowledged and marked complete so we
        // never re-attempt them -- there is nothing to retry.
        await markCompleted(unscopedPrisma, event.id, resolvedOrgId, objectId);
        break;
    }
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    console.error(`stripe webhook ${event.type} failed`, message);
    await unscopedPrisma.stripeWebhookEvent
      .update({
        where: { stripeEventId: event.id },
        data: { status: "FAILED", lastError: message },
      })
      .catch((updateErr) => {
        console.error(
          "stripe webhook ledger FAILED-state write failed",
          sanitizeErrorMessage(updateErr),
        );
      });
    // 500 → Stripe retries with backoff (§14.4); the ledger row is now
    // FAILED, so the retry will be claimed and reprocessed, not skipped.
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

/** Marks a no-op (guard-condition-skipped or unhandled) event complete without a business mutation. */
async function markCompleted(
  db: typeof prismaClient,
  stripeEventId: string,
  organizationId: string | null,
  objectId: string | null,
): Promise<void> {
  await db.stripeWebhookEvent.update({
    where: { stripeEventId },
    data: { status: "COMPLETED", completedAt: new Date(), organizationId, objectId },
  });
}
