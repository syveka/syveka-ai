/**
 * Pure decision logic for the one-off, human-approved staging Creator Studio
 * paid image test (.github/workflows/staging-creator-studio-paid-image.yml).
 * No I/O here, so every spend-safety rule is unit-testable with plain data
 * (tests/unit/creator-studio-paid-image-fixture.test.ts).
 */

export const PAID_IMAGE_TEST = {
  /** Sub-address tag and app_metadata/settings marker for the dedicated fixture. */
  fixtureTag: "creator-studio-paid-image",
  orgSlug: "syveka-staging-creator-studio-paid-image",
  orgName: "Syveka Staging - Creator Studio paid image test (fixture)",
  profileDisplayName: "Synthetic test subject (not a real person)",
  /** organization.settings key recording the single approved experiment. */
  claimKey: "creator_studio_paid_image_claim",
  featureFlag: "creator_studio_v1",
  /** One fal IMAGE: base 10 credits x fal multiplier 2 (creator-credits.ts). */
  targetCredits: 20,
  mockImageCredits: 10,
  model: "fal-ai/flux/schnell",
  provider: "fal",
  imageWidth: 1024,
  imageHeight: 1024,
  /** fal.ai published price for flux/schnell, billed per started megapixel. */
  usdPerBilledMegapixel: 0.003,
  maxUsd: 0.1,
  experimentIdPattern: /^cs-paid-img-[a-z0-9][a-z0-9-]{3,40}$/,
} as const;

/** fal bills per megapixel, rounding up to the next whole megapixel. */
export function billedMegapixels(width: number, height: number): number {
  return Math.ceil((width * height) / 1_000_000);
}

export function maxImageCostUsd(): number {
  const { imageWidth, imageHeight, usdPerBilledMegapixel } = PAID_IMAGE_TEST;
  return billedMegapixels(imageWidth, imageHeight) * usdPerBilledMegapixel;
}

export function assertWithinBudget(): void {
  const cost = maxImageCostUsd();
  if (!(cost > 0 && cost <= PAID_IMAGE_TEST.maxUsd)) {
    throw new Error(
      `paid image cost bound ${cost} exceeds the approved USD ${PAID_IMAGE_TEST.maxUsd}`,
    );
  }
}

export function assertExperimentId(value: string | undefined): string {
  if (!value || !PAID_IMAGE_TEST.experimentIdPattern.test(value)) {
    throw new Error("experiment id must match cs-paid-img-<lowercase letters, digits, dashes>");
  }
  return value;
}

export type Claim = {
  experimentId: string;
  claimedAt: string;
  githubRunId: string;
  githubRunAttempt: string;
  generationId?: string;
};

export function readClaim(settings: unknown): Claim | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>)[PAID_IMAGE_TEST.claimKey];
  if (raw === undefined || raw === null) return null;
  // Anything present but malformed still counts as a claim: never spend on ambiguity.
  if (typeof raw !== "object")
    return { experimentId: "unknown", claimedAt: "", githubRunId: "", githubRunAttempt: "" };
  return raw as Claim;
}

/**
 * The dedicated org may spend at most once, ever. A generation row is always
 * committed before credits are reserved and before the provider is called
 * (creator-generations.ts runGeneration), so zero rows means this org never
 * submitted a provider request through the app. Any row, or any claim (even
 * one whose submission never produced a row), means inspect only.
 */
export function decideState(input: {
  generationCount: number;
  claim: Claim | null;
}): { state: "ready" } | { state: "inspect"; reason: string } {
  if (input.generationCount > 0) {
    return {
      state: "inspect",
      reason: `the fixture org already has ${input.generationCount} generation(s)`,
    };
  }
  if (input.claim) {
    return {
      state: "inspect",
      reason: `experiment ${input.claim.experimentId} already claimed the single paid request`,
    };
  }
  return { state: "ready" };
}

/** Credits to grant so the org holds exactly enough for one fal image, never more. */
export function creditShortfall(balance: { available: number; reserved: number } | null): number {
  const available = balance?.available ?? 0;
  const reserved = balance?.reserved ?? 0;
  if (reserved !== 0) {
    throw new Error(
      "the fixture org has reserved credits (an in-flight or unfinished generation); refusing to top up",
    );
  }
  if (available > PAID_IMAGE_TEST.targetCredits) {
    throw new Error(
      "the fixture org holds more credits than one image needs; refusing to continue",
    );
  }
  return PAID_IMAGE_TEST.targetCredits - available;
}

export type Membership = { userId: string; role: string };

/** Positive ownership proof: the org and the identity belong only to each other. */
export function assertDedicatedFixture(input: {
  orgMarker: unknown;
  fixtureUserMarker: unknown;
  orgMembers: Membership[];
  fixtureUserId: string;
  fixtureUserMembershipCount: number;
}): void {
  if (input.fixtureUserMarker !== PAID_IMAGE_TEST.fixtureTag) {
    throw new Error(
      "the fixture identity is not marked as this test's dedicated fixture; refusing to use it",
    );
  }
  if (input.orgMarker !== PAID_IMAGE_TEST.fixtureTag) {
    throw new Error(
      "the fixture organization is not marked as this test's dedicated fixture; refusing to use it",
    );
  }
  const [only, ...others] = input.orgMembers;
  if (!only || others.length > 0 || only.userId !== input.fixtureUserId || only.role !== "OWNER") {
    throw new Error(
      "the fixture organization must have exactly one member: the fixture identity as OWNER",
    );
  }
  if (input.fixtureUserMembershipCount !== 1) {
    throw new Error("the fixture identity must belong to exactly one organization");
  }
}

export function detectImageFormat(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * The generation row's `model` column is NOT the fal endpoint (the character
 * image path stores "default"). `providerRequestId` holds one of two
 * documented shapes (creator-generation-recovery.ts parseProviderRequestRecord):
 *   - while QUEUED/GENERATING (and after a FAILED transition, which does not
 *     touch the column): JSON { requestId, statusUrl, responseUrl, model }
 *     written by persistProviderRequestIdentity once fal accepts the job;
 *   - once COMPLETED: claimGenerationCompleted overwrites it with the final
 *     output URL (fal-provider.ts persistFirstImage `providerRequestId: url`),
 *     so the submitted endpoint is no longer recorded on the row.
 * These parsers return only derived facts and never echo the raw value.
 */
export type ProviderSubmission =
  { ok: true; model: string } | { ok: false; reason: "missing" | "malformed" | "unexpected" };

export function parseProviderSubmission(raw: unknown): ProviderSubmission {
  if (raw === null || raw === undefined || raw === "") return { ok: false, reason: "missing" };
  if (typeof raw !== "string") return { ok: false, reason: "unexpected" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "unexpected" };
  }
  const { model, requestId } = parsed as Record<string, unknown>;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return { ok: false, reason: "unexpected" };
  }
  if (typeof model !== "string" || !/^fal-ai\/[a-z0-9][a-z0-9/._-]{0,120}$/.test(model)) {
    return { ok: false, reason: "unexpected" };
  }
  return { ok: true, model };
}

export type ProviderReference =
  | { kind: "submission"; model: string }
  | { kind: "result-url"; host: string }
  | { kind: "invalid"; reason: "missing" | "malformed" | "unexpected" };

/** Classifies providerRequestId as a submission record or a completed result URL. */
export function parseProviderReference(raw: unknown): ProviderReference {
  if (raw === null || raw === undefined || raw === "")
    return { kind: "invalid", reason: "missing" };
  if (typeof raw !== "string") return { kind: "invalid", reason: "unexpected" };
  if (raw.trimStart().startsWith("{")) {
    const submission = parseProviderSubmission(raw);
    return submission.ok
      ? { kind: "submission", model: submission.model }
      : { kind: "invalid", reason: submission.reason };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid", reason: "malformed" };
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    return { kind: "invalid", reason: "unexpected" };
  }
  return { kind: "result-url", host: url.hostname };
}

/**
 * Pre-submission check of the deployment actually serving the stable staging
 * hostname, from the Vercel API responses the credential step saved (alias
 * lookup + deployment). Env NAMES only: presence of FAL_API_KEY does not prove
 * the value is non-empty or valid -- the app's own estimate check (fal = 20
 * credits) is still required. Any missing or unexpected field fails closed.
 */
export const FORBIDDEN_RUNTIME_ENV = ["FAL_IMAGE_MODEL", "CREATOR_MEDIA_PROVIDER"] as const;

export function evaluateDeployment(input: {
  alias: unknown;
  deployment: unknown;
  expectedBuildSha: string;
}): { problems: string[]; deploymentId: string | null } {
  const problems: string[] = [];
  const obj = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const alias = obj(input.alias);
  const dep = obj(input.deployment);
  if (!alias || !dep) {
    return {
      problems: ["the alias or deployment response is not a JSON object"],
      deploymentId: null,
    };
  }
  const deploymentId = typeof dep.id === "string" ? dep.id : null;
  if (!deploymentId || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) {
    problems.push("the deployment id is missing or malformed");
  }
  if (alias.deploymentId !== deploymentId) {
    problems.push("the stable alias does not point at the inspected deployment");
  }
  if (typeof dep.projectId !== "string" || alias.projectId !== dep.projectId) {
    problems.push("the alias and deployment do not belong to the same project");
  }
  if (dep.readyState !== "READY") problems.push("the deployment is not READY");
  if (dep.target !== "production") {
    problems.push(
      "the deployment is not the staging project's stable (production-target) deployment",
    );
  }
  const meta = obj(dep.meta);
  const sha = meta?.githubCommitSha ?? meta?.gitCommitSha;
  if (typeof sha !== "string" || sha !== input.expectedBuildSha) {
    problems.push("the deployment's commit SHA is missing or differs from expected_build_sha");
  }
  const env = dep.env;
  if (!Array.isArray(env) || !env.every((name) => typeof name === "string")) {
    problems.push("the deployment's runtime env name list is missing or malformed");
  } else {
    if (!env.includes("FAL_API_KEY")) problems.push("FAL_API_KEY is not in the runtime env names");
    for (const name of FORBIDDEN_RUNTIME_ENV) {
      if (env.includes(name))
        problems.push(`${name} is set; the request could differ from flux/schnell`);
    }
  }
  return { problems, deploymentId };
}

/**
 * Error text for failed HTTP calls in the paid test. Fixed label + numeric
 * status only: never the URL (signed upload URLs carry tokens), headers or
 * response body.
 */
export function sanitizedHttpFailure(label: string, status: number | null): string {
  const safeLabel = /^[a-z][a-z0-9 -]{0,60}$/.test(label) ? label : "request";
  return status === null
    ? `${safeLabel} failed (network error)`
    : `${safeLabel} failed (HTTP ${Number.isInteger(status) ? status : "unknown"})`;
}

/** Runs one HTTP call; any thrown error is replaced by a sanitized one. */
export async function sanitizedCall<T extends { status(): number; ok(): boolean }>(
  label: string,
  call: () => Promise<T>,
  { expectStatus }: { expectStatus?: number } = {},
): Promise<T> {
  let res: T;
  try {
    res = await call();
  } catch {
    throw new Error(sanitizedHttpFailure(label, null));
  }
  const good = expectStatus === undefined ? res.ok() : res.status() === expectStatus;
  if (!good) throw new Error(sanitizedHttpFailure(label, res.status()));
  return res;
}

export type GenerationRecord = {
  id: string;
  provider: string;
  status: string;
  generationType: string;
  errorCode: string | null;
  outputAssetIds: string[];
  creditsConsumed: number;
  /** Raw providerRequestId column; parsed here, never printed. */
  providerRequestIdRaw: unknown;
};

export type LedgerEntry = {
  generationId: string | null;
  type: string;
  amount: number;
};

export type OutcomeCase =
  | "NOT_ATTEMPTED"
  | "CLAIMED_NO_GENERATION"
  | "MULTIPLE_GENERATIONS"
  | "NO_PROVIDER_REQUEST_ID"
  | "PROVIDER_JOB_PENDING"
  | "GENERATION_FAILED"
  | "COMPLETED_UNVERIFIED"
  | "COMPLETED_VERIFIED";

export type EndpointEvidence = "submission-record" | "pre-submission-deployment-check" | "none";

export type Outcome = {
  outcome: OutcomeCase;
  pass: boolean;
  /** Ambiguous or failed outcomes are never retried automatically. */
  automaticRetry: false;
  billing: string;
  providerModel: string | null;
  /** Where providerModel comes from; a completed row no longer records it. */
  endpointEvidence: EndpointEvidence;
  /** Hostname of the completed result reference (no path, query or token). */
  resultHost: string | null;
  ledger: { reserved: number; committed: number; released: number };
  problems: string[];
};

const RESERVATION_FAILURE_CODES = new Set(["insufficient_credits", "reserve_failed"]);

/**
 * Classifies the fixture org's state after (or instead of) the one request.
 * Job status and ledger movements are reported separately; a FAILED job is
 * not assumed refunded -- only a RELEASE row shows that.
 *
 * Endpoint validation stays strict: a COMPLETED row no longer records the
 * submitted endpoint, so PASS requires either the submission record or
 * `preSubmissionEndpoint` -- the endpoint proven by this same run's
 * credential-free deployment check (serving deployment on the reviewed SHA,
 * FAL_IMAGE_MODEL absent, so the reviewed code's default applies). Without
 * either, a completed generation is COMPLETED_UNVERIFIED.
 */
export function classifyOutcome(input: {
  claimPresent: boolean;
  generations: GenerationRecord[];
  ledger: LedgerEntry[];
  balance: { available: number; reserved: number } | null;
  storedImageFormat: string | null;
  storedImageBytes: number;
  preSubmissionEndpoint?: string | null;
}): Outcome {
  const target = PAID_IMAGE_TEST.targetCredits;
  const sum = (generationId: string | null, type: string) =>
    input.ledger
      .filter((e) => e.generationId === generationId && e.type === type)
      .reduce((total, e) => total + e.amount, 0);
  const base = (
    outcome: OutcomeCase,
    billing: string,
    g: GenerationRecord | null,
    endpoint: {
      model: string | null;
      evidence: EndpointEvidence;
      resultHost: string | null;
    },
    problems: string[],
  ): Outcome => ({
    outcome,
    pass: outcome === "COMPLETED_VERIFIED" && problems.length === 0,
    automaticRetry: false,
    billing,
    providerModel: endpoint.model,
    endpointEvidence: endpoint.evidence,
    resultHost: endpoint.resultHost,
    ledger: g
      ? {
          reserved: sum(g.id, "RESERVE"),
          committed: sum(g.id, "COMMIT"),
          released: sum(g.id, "RELEASE"),
        }
      : { reserved: 0, committed: 0, released: 0 },
    problems,
  });
  const noEndpoint = {
    model: null,
    evidence: "none" as const,
    resultHost: null,
  };

  if (input.generations.length === 0) {
    return input.claimPresent
      ? base(
          "CLAIMED_NO_GENERATION",
          "No generation row. In the app's generation path the row is committed before credits " +
            "are reserved and before the provider call, so that path made no provider request. " +
            "Needs human review; never retried automatically.",
          null,
          noEndpoint,
          ["a claim exists but no generation was recorded"],
        )
      : base(
          "NOT_ATTEMPTED",
          "No claim and no generation: this workflow has not submitted.",
          null,
          noEndpoint,
          ["no paid request has been attempted"],
        );
  }
  if (input.generations.length > 1) {
    return base(
      "MULTIPLE_GENERATIONS",
      "More than one generation exists in the fixture org; each may have been billed.",
      null,
      noEndpoint,
      [`expected at most 1 generation, found ${input.generations.length}`],
    );
  }

  const g = input.generations[0]!;
  const ref = parseProviderReference(g.providerRequestIdRaw);
  const problems: string[] = [];
  if (g.generationType !== "IMAGE")
    problems.push(`generation type ${g.generationType}, expected IMAGE`);
  if (g.provider !== PAID_IMAGE_TEST.provider)
    problems.push(`provider ${g.provider}, expected fal`);
  const recorded =
    ref.kind === "submission"
      ? {
          model: ref.model,
          evidence: "submission-record" as const,
          resultHost: null,
        }
      : noEndpoint;
  if (ref.kind === "submission" && ref.model !== PAID_IMAGE_TEST.model) {
    problems.push(`fal endpoint ${ref.model}, expected ${PAID_IMAGE_TEST.model}`);
  }

  if (ref.kind === "invalid") {
    const reservationFailed =
      g.status === "FAILED" && g.errorCode !== null && RESERVATION_FAILURE_CODES.has(g.errorCode);
    return base(
      "NO_PROVIDER_REQUEST_ID",
      reservationFailed
        ? "Failed at credit reservation, before the provider call; the provider was not called."
        : "AMBIGUOUS: no usable provider request id (" +
            ref.reason +
            "). The id is recorded only after fal accepts the submission, so a request may have " +
            "reached fal and may be billed. Never retried automatically.",
      g,
      noEndpoint,
      [...problems, `provider request id ${ref.reason}`],
    );
  }
  if (g.status !== "COMPLETED" && ref.kind === "result-url") {
    return base(
      "NO_PROVIDER_REQUEST_ID",
      `AMBIGUOUS: a completed-result reference on a ${g.status} generation. Never retried automatically.`,
      g,
      noEndpoint,
      [...problems, `unexpected result reference on status ${g.status}`],
    );
  }
  if (g.status === "QUEUED" || g.status === "GENERATING") {
    return base(
      "PROVIDER_JOB_PENDING",
      "fal accepted the job (billing likely); the result is not yet known. The reconciler may " +
        "still finish it. Never resubmitted.",
      g,
      recorded,
      [...problems, `generation status ${g.status}`],
    );
  }
  if (g.status === "FAILED") {
    return base(
      "GENERATION_FAILED",
      "fal accepted the job and the generation then failed; fal may still bill an accepted job. " +
        "Refund status is shown by the ledger, not assumed.",
      g,
      recorded,
      [...problems, `generation failed (${g.errorCode ?? "no error code"})`],
    );
  }
  if (g.status !== "COMPLETED") {
    return base(
      "NO_PROVIDER_REQUEST_ID",
      `Unexpected generation status ${g.status}.`,
      g,
      recorded,
      [...problems, `unexpected status ${g.status}`],
    );
  }

  // COMPLETED: the documented shape is the final output URL.
  let endpoint: {
    model: string | null;
    evidence: EndpointEvidence;
    resultHost: string | null;
  } = recorded;
  if (ref.kind === "result-url") {
    const pre = input.preSubmissionEndpoint ?? null;
    endpoint = pre
      ? {
          model: pre,
          evidence: "pre-submission-deployment-check",
          resultHost: ref.host,
        }
      : { model: null, evidence: "none", resultHost: ref.host };
    if (!pre) {
      problems.push(
        "fal endpoint is not recorded after completion and this run has no pre-submission endpoint verification",
      );
    } else if (pre !== PAID_IMAGE_TEST.model) {
      problems.push(`pre-submission endpoint ${pre}, expected ${PAID_IMAGE_TEST.model}`);
    }
  }
  if (g.outputAssetIds.length !== 1)
    problems.push(`expected 1 output asset, found ${g.outputAssetIds.length}`);
  if (g.creditsConsumed !== target)
    problems.push(`credits consumed ${g.creditsConsumed}, expected ${target}`);
  const reserved = sum(g.id, "RESERVE");
  const committed = sum(g.id, "COMMIT");
  const released = sum(g.id, "RELEASE");
  if (reserved !== target || committed !== target || released !== 0) {
    problems.push(
      `ledger reserve/commit/release ${reserved}/${committed}/${released}, expected ${target}/${target}/0`,
    );
  }
  if (input.ledger.some((e) => e.generationId !== null && e.generationId !== g.id)) {
    problems.push("ledger has entries for another generation");
  }
  if (!input.balance || input.balance.available !== 0 || input.balance.reserved !== 0) {
    problems.push(
      `balance ${JSON.stringify(input.balance)}, expected {"available":0,"reserved":0}`,
    );
  }
  if (!input.storedImageFormat) problems.push("stored output is not a recognizable image");
  if (input.storedImageBytes <= 0) problems.push("stored output is empty");
  return base(
    problems.length === 0 ? "COMPLETED_VERIFIED" : "COMPLETED_UNVERIFIED",
    "One fal job completed (billed by fal).",
    g,
    endpoint,
    problems,
  );
}
