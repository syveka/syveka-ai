/**
 * One-off admin utility: makes an existing organization actually able to run
 * Creator Studio (tests/e2e/creator-studio-live.spec.ts included).
 *
 * SCOPE BOUNDARY (do not extend without a separate, explicit task):
 *   - This script ONLY (1) sets the `creator_studio_v1` feature flag to true
 *     on Organization.settings (the exact mechanism src/server/services/
 *     feature-flags.ts already defines — setFeatureEnabled() — but which no
 *     route, admin UI, or existing script calls anywhere in this repo), and
 *     (2) tops up CreatorCreditBalance.availableCredits to at least
 *     --min-credits (default 500) if it is currently lower, recording a
 *     GRANT CreatorCreditTransaction for auditability.
 *   - It does NOT enable creator_studio_autopilot (stays opt-in, unrelated
 *     to this script's purpose), does NOT change the organization's
 *     subscription/plan, does NOT touch any other feature flag, and does
 *     NOT create an organization — it requires one to already exist.
 *   - Why a manual top-up instead of upgrading the plan: FREE (the plan
 *     scripts/ensure-e2e-org-fixture.ts provisions) has
 *     creatorCreditsPerMonth: 0 (src/server/services/billing/plans.ts), and
 *     ensureMonthlyCreditGrant() in creator-credits.ts early-returns for any
 *     plan with 0 credits/month — so the org would otherwise stay stuck at
 *     zero forever, and changing its plan would risk altering unrelated
 *     billing-related test assertions for the same shared E2E org.
 *   - Idempotent: reruns are safe. The flag write is a no-op if already
 *     true; the credit top-up only ever raises the balance to the floor
 *     given, never lowers it, and never re-grants once already at/above it.
 *
 * Usage:
 *   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/enable-creator-studio-for-org.ts --email=e2e@example.com [--min-credits=500]
 *   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/enable-creator-studio-for-org.ts --org-id=<uuid> [--min-credits=500]
 *
 * DATABASE_URL/DIRECT_URL must be the same direct/session connection, same
 * requirement and reason as scripts/ensure-e2e-org-fixture.ts.
 */
import { PrismaClient } from "@prisma/client";

const CREATOR_STUDIO_FLAG = "creator_studio_v1";
const DEFAULT_MIN_CREDITS = 500;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`enable-creator-studio-for-org: missing required env var ${name}`);
  return value;
}

function requireDirectConnection(): void {
  const databaseUrl = requireEnv("DATABASE_URL");
  const directUrl = requireEnv("DIRECT_URL");
  if (databaseUrl !== directUrl) {
    throw new Error(
      "enable-creator-studio-for-org: DATABASE_URL and DIRECT_URL must be the same direct/" +
        "session connection for this script — it is a one-off admin script, not the deployed " +
        "app, and PrismaClient's runtime query engine only ever uses DATABASE_URL/`url`.",
    );
  }
}

function parseArgs(): { email?: string; orgId?: string; minCredits: number } {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    if (key) args.set(key, rest.join("="));
  }
  const email = args.get("email");
  const orgId = args.get("org-id");
  if (!email && !orgId) {
    throw new Error(
      "enable-creator-studio-for-org: pass either --email=<e2e-user-email> or --org-id=<uuid>",
    );
  }
  const minCredits = args.has("min-credits")
    ? Number(args.get("min-credits"))
    : DEFAULT_MIN_CREDITS;
  if (!Number.isFinite(minCredits) || minCredits < 0) {
    throw new Error("enable-creator-studio-for-org: --min-credits must be a non-negative number");
  }
  return { email, orgId, minCredits };
}

async function main(): Promise<void> {
  requireDirectConnection();
  const { email, orgId: orgIdArg, minCredits } = parseArgs();

  const prisma = new PrismaClient();
  try {
    let orgId = orgIdArg;
    if (!orgId) {
      const user = await prisma.user.findUnique({ where: { email: email! }, select: { id: true } });
      if (!user) {
        throw new Error(`enable-creator-studio-for-org: no public.users row for ${email}`);
      }
      const membership = await prisma.organizationMember.findFirst({
        where: { userId: user.id },
        select: { organizationId: true },
      });
      if (!membership) {
        throw new Error(
          `enable-creator-studio-for-org: ${email} has no organization membership yet — run ` +
            "scripts/ensure-e2e-org-fixture.ts first.",
        );
      }
      orgId = membership.organizationId;
    }

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { id: true, name: true, settings: true },
    });

    const settings = (org.settings ?? {}) as Record<string, unknown>;
    const alreadyEnabled = settings[CREATOR_STUDIO_FLAG] === true;
    if (!alreadyEnabled) {
      await prisma.organization.update({
        where: { id: org.id },
        data: { settings: { ...settings, [CREATOR_STUDIO_FLAG]: true } },
      });
      console.log(
        `enable-creator-studio-for-org: enabled "${CREATOR_STUDIO_FLAG}" for ${org.name} (${org.id}).`,
      );
    } else {
      console.log(
        `enable-creator-studio-for-org: "${CREATOR_STUDIO_FLAG}" already enabled for ${org.name} (${org.id}).`,
      );
    }

    const balance = await prisma.creatorCreditBalance.findUnique({
      where: { organizationId: org.id },
    });
    const current = balance?.availableCredits ?? 0;
    if (current < minCredits) {
      const topUp = minCredits - current;
      await prisma.$transaction([
        prisma.creatorCreditBalance.upsert({
          where: { organizationId: org.id },
          create: { organizationId: org.id, availableCredits: minCredits, reservedCredits: 0 },
          update: { availableCredits: { increment: topUp } },
        }),
        prisma.creatorCreditTransaction.create({
          data: {
            organizationId: org.id,
            type: "GRANT",
            amount: topUp,
            reason: "manual_e2e_topup",
          },
        }),
      ]);
      console.log(
        `enable-creator-studio-for-org: topped up ${org.name} (${org.id}) from ${current} to ${minCredits} available credits.`,
      );
    } else {
      console.log(
        `enable-creator-studio-for-org: ${org.name} (${org.id}) already has ${current} available credits (>= ${minCredits}) — no top-up needed.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
