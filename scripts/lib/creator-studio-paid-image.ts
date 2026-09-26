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

export type GenerationRecord = {
  id: string;
  provider: string;
  model: string;
  status: string;
  generationType: string;
  outputAssetIds: string[];
  creditsReserved: number;
  creditsConsumed: number;
  hasProviderRequestId: boolean;
};

export type LedgerEntry = { generationId: string | null; type: string; amount: number };

/** Post-run verification: every problem is listed; an empty list means PASS. */
export function evaluateOutcome(input: {
  generations: GenerationRecord[];
  ledger: LedgerEntry[];
  balance: { available: number; reserved: number } | null;
  storedImageFormat: string | null;
  storedImageBytes: number;
}): string[] {
  const problems: string[] = [];
  if (input.generations.length !== 1) {
    problems.push(
      `expected exactly 1 generation in the fixture org, found ${input.generations.length}`,
    );
    return problems;
  }
  const g = input.generations[0]!;
  if (g.generationType !== "IMAGE")
    problems.push(`generation type ${g.generationType}, expected IMAGE`);
  if (g.provider !== PAID_IMAGE_TEST.provider)
    problems.push(`provider ${g.provider}, expected fal`);
  if (g.model !== PAID_IMAGE_TEST.model)
    problems.push(`model ${g.model}, expected ${PAID_IMAGE_TEST.model}`);
  if (g.status !== "COMPLETED") problems.push(`status ${g.status}, expected COMPLETED`);
  if (!g.hasProviderRequestId) problems.push("no provider request id was recorded");
  if (g.outputAssetIds.length !== 1)
    problems.push(`expected 1 output asset, found ${g.outputAssetIds.length}`);
  if (g.creditsConsumed !== PAID_IMAGE_TEST.targetCredits) {
    problems.push(
      `credits consumed ${g.creditsConsumed}, expected ${PAID_IMAGE_TEST.targetCredits}`,
    );
  }
  const forGen = input.ledger.filter((e) => e.generationId === g.id);
  const summary = forGen
    .map((e) => `${e.type}:${e.amount}`)
    .sort()
    .join(",");
  const expected = [
    `COMMIT:${PAID_IMAGE_TEST.targetCredits}`,
    `RESERVE:${PAID_IMAGE_TEST.targetCredits}`,
  ].join(",");
  if (summary !== expected)
    problems.push(`ledger for the generation is [${summary}], expected [${expected}]`);
  const otherSpend = input.ledger.filter((e) => e.generationId !== null && e.generationId !== g.id);
  if (otherSpend.length > 0) problems.push("ledger has entries for another generation");
  if (!input.balance || input.balance.available !== 0 || input.balance.reserved !== 0) {
    problems.push(
      `balance ${JSON.stringify(input.balance)}, expected {"available":0,"reserved":0}`,
    );
  }
  if (!input.storedImageFormat) problems.push("stored output is not a recognizable image");
  if (input.storedImageBytes <= 0) problems.push("stored output is empty");
  return problems;
}
