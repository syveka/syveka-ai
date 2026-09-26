/**
 * Staging-only fixture for the single, human-approved Creator Studio paid
 * image test (.github/workflows/staging-creator-studio-paid-image.yml).
 *
 *   prepare  Ensure a DEDICATED test identity (a `+creator-studio-paid-image`
 *            sub-address of the staging E2E email, pre-confirmed so no email
 *            is sent, fresh random password each run) and a DEDICATED
 *            organization owned only by it. Positively verifies ownership
 *            via markers + membership shape and fails closed otherwise; never
 *            touches the shared E2E user, its password, or its memberships.
 *            Enables creator_studio_v1 on this org only. Only when the org has
 *            never spent (no generation rows, no claim) does it grant the
 *            shortfall to exactly 20 credits through the ledger.
 *   claim    Immediately before the one UI submission: under a row lock,
 *            re-checks "never spent" and records the experiment id in the
 *            org's settings. A claim is permanent -- reruns only inspect.
 *   check-deployment  Token-free check of the saved Vercel responses for the
 *            deployment serving the stable hostname (SHA, env names).
 *   verify   Checks the outcome in the database and private storage (one
 *            fal/flux-schnell IMAGE generation, RESERVE+COMMIT of 20 in the
 *            ledger, zero balance, stored bytes are an image).
 *
 * Never logs an email, password, token, storage path or signed URL.
 * Standalone script: no `@/` aliases (see scripts/verify-release-chain.ts).
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma/client/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_PIPELINE_STAGES } from "../src/lib/constants";
import {
  PAID_IMAGE_TEST,
  assertDedicatedFixture,
  assertExperimentId,
  assertWithinBudget,
  creditShortfall,
  decideState,
  FORBIDDEN_RUNTIME_ENV,
  classifyOutcome,
  detectImageFormat,
  evaluateDeployment,
  readClaim,
  type Claim,
} from "./lib/creator-studio-paid-image";

const LOG_PREFIX = "creator-studio-paid-image-fixture";
const OUTPUT_BUCKET = "creator-generated-media";

function fail(message: string): never {
  throw new Error(`${LOG_PREFIX}: ${message}`);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing required env var ${name}`);
  return value;
}

function subAddress(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) fail("the base E2E email is not a valid email address");
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`;
}

function exportEnv(name: string, value: string, { mask }: { mask: boolean }): void {
  const githubEnv = requireEnv("GITHUB_ENV");
  if (mask) console.log(`::add-mask::${value}`);
  appendFileSync(githubEnv, `${name}=${value}\n`, { encoding: "utf8" });
}

function connect(): PrismaClient {
  const databaseUrl = requireEnv("DATABASE_URL");
  if (databaseUrl !== requireEnv("DIRECT_URL")) {
    fail("DATABASE_URL and DIRECT_URL must be the same direct/session connection");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

function supabaseAdmin() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function findAuthUser(
  prisma: PrismaClient,
  email: string,
): Promise<{ id: string; marker: string | null } | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; marker: string | null }>>`
    select id::text as id, raw_app_meta_data->>'e2e_fixture' as marker
    from auth.users where lower(email) = lower(${email})`;
  if (rows.length > 1) fail("ambiguous auth user lookup");
  return rows[0] ?? null;
}

async function findFixtureOrg(prisma: PrismaClient) {
  return prisma.organization.findFirst({
    where: { slug: PAID_IMAGE_TEST.orgSlug, deletedAt: null },
    select: { id: true, settings: true },
  });
}

async function prepare(prisma: PrismaClient): Promise<void> {
  assertWithinBudget();
  assertExperimentId(process.env.EXPERIMENT_ID);
  const admin = supabaseAdmin();
  const email = subAddress(requireEnv("E2E_USER_EMAIL"), PAID_IMAGE_TEST.fixtureTag);
  const password = randomBytes(24).toString("base64url");

  let authUser = await findAuthUser(prisma, email);
  if (authUser) {
    if (authUser.marker !== PAID_IMAGE_TEST.fixtureTag) {
      fail("an account with the fixture address exists but is not this test's fixture; refusing");
    }
    const rotated = await admin.auth.admin.updateUserById(authUser.id, { password });
    if (rotated.error) fail("failed to rotate the fixture identity password");
  } else {
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { e2e_fixture: PAID_IMAGE_TEST.fixtureTag },
    });
    if (created.error || !created.data.user) fail("failed to create the fixture identity");
    authUser = { id: created.data.user.id, marker: PAID_IMAGE_TEST.fixtureTag };
    console.log(`${LOG_PREFIX}: created the dedicated fixture identity.`);
  }

  // handle_new_user() mirrors auth.users into public.users.
  let publicUser = null;
  for (let attempt = 0; attempt < 10 && !publicUser; attempt++) {
    publicUser = await prisma.user.findUnique({ where: { id: authUser.id }, select: { id: true } });
    if (!publicUser) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!publicUser) fail("the fixture identity never appeared in public.users");

  let org = await findFixtureOrg(prisma);
  if (!org) {
    const memberships = await prisma.organizationMember.count({ where: { userId: authUser.id } });
    if (memberships !== 0)
      fail("the fixture identity already belongs to another organization; refusing");
    const userId = authUser.id;
    const created = await prisma.$transaction(async (tx) => {
      const o = await tx.organization.create({
        data: {
          name: PAID_IMAGE_TEST.orgName,
          slug: PAID_IMAGE_TEST.orgSlug,
          defaultLocale: "EN",
          settings: { e2e_fixture: PAID_IMAGE_TEST.fixtureTag },
        },
      });
      await tx.organizationMember.create({ data: { organizationId: o.id, userId, role: "OWNER" } });
      await tx.subscription.create({
        data: { organizationId: o.id, plan: "FREE", status: "ACTIVE", seats: 1 },
      });
      await tx.pipeline.create({
        data: {
          organizationId: o.id,
          name: "Pipeline",
          isDefault: true,
          stages: { create: DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s })) },
        },
      });
      return o;
    });
    org = { id: created.id, settings: created.settings };
    console.log(`${LOG_PREFIX}: created the dedicated fixture organization.`);
  }

  const orgMembers = await prisma.organizationMember.findMany({
    where: { organizationId: org.id },
    select: { userId: true, role: true },
  });
  const fixtureUserMembershipCount = await prisma.organizationMember.count({
    where: { userId: authUser.id },
  });
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  assertDedicatedFixture({
    orgMarker: settings.e2e_fixture,
    fixtureUserMarker: authUser.marker,
    orgMembers,
    fixtureUserId: authUser.id,
    fixtureUserMembershipCount,
  });

  const activeOrg = await admin.auth.admin.updateUserById(authUser.id, {
    app_metadata: { e2e_fixture: PAID_IMAGE_TEST.fixtureTag, last_active_org: org.id },
  });
  if (activeOrg.error) fail("failed to set the fixture identity's active organization");

  if (settings[PAID_IMAGE_TEST.featureFlag] !== true) {
    await prisma.organization.update({
      where: { id: org.id },
      data: { settings: { ...settings, [PAID_IMAGE_TEST.featureFlag]: true } },
    });
    console.log(
      `${LOG_PREFIX}: enabled ${PAID_IMAGE_TEST.featureFlag} on the fixture organization only.`,
    );
  }

  const generationCount = await prisma.creatorGeneration.count({
    where: { organizationId: org.id },
  });
  const decision = decideState({ generationCount, claim: readClaim(settings) });

  if (decision.state === "ready") {
    const balance = await prisma.creatorCreditBalance.findUnique({
      where: { organizationId: org.id },
    });
    const grant = creditShortfall(
      balance ? { available: balance.availableCredits, reserved: balance.reservedCredits } : null,
    );
    if (grant > 0) {
      await prisma.$transaction([
        prisma.creatorCreditBalance.upsert({
          where: { organizationId: org.id },
          create: { organizationId: org.id, availableCredits: grant, reservedCredits: 0 },
          update: { availableCredits: { increment: grant } },
        }),
        prisma.creatorCreditTransaction.create({
          data: {
            organizationId: org.id,
            type: "GRANT",
            amount: grant,
            reason: "creator_studio_paid_image_topup",
          },
        }),
      ]);
    }
    console.log(
      `${LOG_PREFIX}: ready; granted ${grant} credit(s) to reach ${PAID_IMAGE_TEST.targetCredits}.`,
    );
  } else {
    console.log(`${LOG_PREFIX}: inspect only (${decision.reason}); no credits granted.`);
  }

  exportEnv("PAID_TEST_USER_EMAIL", email, { mask: true });
  exportEnv("PAID_TEST_USER_PASSWORD", password, { mask: true });
  exportEnv("PAID_TEST_STATE", decision.state, { mask: false });
}

async function claim(prisma: PrismaClient): Promise<void> {
  const experimentId = assertExperimentId(process.env.EXPERIMENT_ID);
  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; settings: unknown }>>`
      select id::text as id, settings from public.organizations
      where slug = ${PAID_IMAGE_TEST.orgSlug} and deleted_at is null for update`;
    const org = locked[0];
    if (!org) fail("the fixture organization does not exist; run prepare first");
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    const generationCount = await tx.creatorGeneration.count({ where: { organizationId: org.id } });
    const decision = decideState({ generationCount, claim: readClaim(settings) });
    if (decision.state !== "ready") return decision;
    const balance = await tx.creatorCreditBalance.findUnique({ where: { organizationId: org.id } });
    if (
      balance?.availableCredits !== PAID_IMAGE_TEST.targetCredits ||
      balance.reservedCredits !== 0
    ) {
      return {
        state: "inspect" as const,
        reason: "credit balance is not exactly 20 available / 0 reserved",
      };
    }
    const record: Claim = {
      experimentId,
      claimedAt: new Date().toISOString(),
      githubRunId: requireEnv("GITHUB_RUN_ID"),
      githubRunAttempt: requireEnv("GITHUB_RUN_ATTEMPT"),
    };
    await tx.organization.update({
      where: { id: org.id },
      data: { settings: { ...settings, [PAID_IMAGE_TEST.claimKey]: record } },
    });
    return decision;
  });

  if (outcome.state === "ready") {
    exportEnv("PAID_TEST_SUBMIT", "1", { mask: false });
    console.log(`${LOG_PREFIX}: claimed the single paid request for experiment ${experimentId}.`);
  } else {
    exportEnv("PAID_TEST_SUBMIT", "0", { mask: false });
    console.log(`${LOG_PREFIX}: not submitting (${outcome.reason}).`);
  }
}

async function verify(prisma: PrismaClient): Promise<void> {
  const org = await findFixtureOrg(prisma);
  if (!org) fail("the fixture organization does not exist");
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const rows = await prisma.creatorGeneration.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "asc" },
  });
  const generations = rows.map((g) => ({
    id: g.id,
    provider: g.provider,
    status: g.status,
    generationType: g.generationType,
    errorCode: g.errorCode,
    outputAssetIds: g.outputAssetIds,
    creditsConsumed: g.creditsConsumed,
    providerRequestIdRaw: g.providerRequestId,
  }));
  const ledger = await prisma.creatorCreditTransaction.findMany({
    where: { organizationId: org.id },
    select: { generationId: true, type: true, amount: true },
  });
  const balance = await prisma.creatorCreditBalance.findUnique({
    where: { organizationId: org.id },
  });

  let storedImageFormat: string | null = null;
  let storedImageBytes = 0;
  const assetId = generations.length === 1 ? generations[0]!.outputAssetIds[0] : undefined;
  if (assetId) {
    const asset = await prisma.creatorReferenceAsset.findFirst({
      where: { id: assetId, organizationId: org.id, source: "GENERATED" },
      select: { storagePath: true },
    });
    if (asset) {
      const { data, error } = await supabaseAdmin()
        .storage.from(OUTPUT_BUCKET)
        .download(asset.storagePath);
      if (!error && data) {
        const bytes = new Uint8Array(await data.arrayBuffer());
        storedImageBytes = bytes.length;
        storedImageFormat = detectImageFormat(bytes);
      }
    }
  }

  const claimRecord = readClaim(settings);
  if (claimRecord && generations.length === 1 && !claimRecord.generationId) {
    await prisma.organization.update({
      where: { id: org.id },
      data: {
        settings: {
          ...settings,
          [PAID_IMAGE_TEST.claimKey]: {
            ...claimRecord,
            generationId: generations[0]!.id,
          },
        },
      },
    });
  }

  const result = classifyOutcome({
    claimPresent: claimRecord !== null,
    generations,
    ledger,
    balance: balance
      ? {
          available: balance.availableCredits,
          reserved: balance.reservedCredits,
        }
      : null,
    storedImageFormat,
    storedImageBytes,
  });
  const g = generations.length === 1 ? generations[0]! : null;
  // Fixed fields only: never the raw providerRequestId, storage path or URLs.
  console.log(`${LOG_PREFIX}: outcome=${result.outcome}`);
  console.log(`${LOG_PREFIX}: billing: ${result.billing}`);
  console.log(
    `${LOG_PREFIX}: job status=${g?.status ?? "none"} provider=${g?.provider ?? "none"}` +
      ` falEndpoint=${result.providerModel ?? "unknown"} generations=${generations.length}` +
      ` experiment=${claimRecord?.experimentId ?? "none"}`,
  );
  console.log(
    `${LOG_PREFIX}: ledger for the generation reserve=${result.ledger.reserved}` +
      ` commit=${result.ledger.committed} release=${result.ledger.released};` +
      ` balance=${balance ? `${balance.availableCredits}/${balance.reservedCredits}` : "none"}` +
      ` (available/reserved)`,
  );
  console.log(`${LOG_PREFIX}: stored image=${storedImageFormat ?? "none"}:${storedImageBytes}B`);
  if (!result.pass) {
    fail(`NOT PASS (${result.outcome}; automatic retry: no): ${result.problems.join("; ")}`);
  }
  console.log(
    `${LOG_PREFIX}: PASS -- one fal flux/schnell image, one 20-credit charge, stored image present.`,
  );
}

/**
 * Token-free validation of the Vercel responses saved by the preceding
 * credential step (alias lookup + deployment). Reads files only.
 */
function checkDeployment(): void {
  const expectedBuildSha = requireEnv("EXPECTED_BUILD_SHA");
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(requireEnv(name), "utf8"));
    } catch {
      fail(`could not read ${name} as JSON`);
    }
  };
  const { problems, deploymentId } = evaluateDeployment({
    alias: read("STAGING_ALIAS_JSON"),
    deployment: read("STAGING_DEPLOYMENT_JSON"),
    expectedBuildSha,
  });
  if (problems.length > 0) fail(`deployment check failed: ${problems.join("; ")}`);
  console.log(
    `${LOG_PREFIX}: ${deploymentId} serves ${expectedBuildSha}; FAL_API_KEY present by name,` +
      ` ${FORBIDDEN_RUNTIME_ENV.join(" and ")} absent (names only; key value not verified).`,
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "check-deployment") return checkDeployment();
  if (mode !== "prepare" && mode !== "claim" && mode !== "verify") {
    fail("usage: creator-studio-paid-image-fixture.ts prepare|check-deployment|claim|verify");
  }
  const prisma = connect();
  try {
    if (mode === "prepare") await prepare(prisma);
    else if (mode === "claim") await claim(prisma);
    else await verify(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // Our messages are fixed strings; anything else is reduced to its name.
  const message =
    error instanceof Error && error.message.startsWith(LOG_PREFIX)
      ? error.message
      : `${LOG_PREFIX}: unexpected ${error instanceof Error ? error.name : "error"}`;
  console.error(message);
  process.exit(1);
});
