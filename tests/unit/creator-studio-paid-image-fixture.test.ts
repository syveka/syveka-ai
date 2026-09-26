import { describe, expect, it } from "vitest";
import {
  PAID_IMAGE_TEST,
  assertDedicatedFixture,
  assertExperimentId,
  assertWithinBudget,
  billedMegapixels,
  creditShortfall,
  decideState,
  detectImageFormat,
  evaluateOutcome,
  maxImageCostUsd,
  readClaim,
  type GenerationRecord,
} from "../../scripts/lib/creator-studio-paid-image";

const claim = {
  experimentId: "cs-paid-img-test-1",
  claimedAt: "2026-09-26T00:00:00Z",
  githubRunId: "1",
  githubRunAttempt: "1",
};

describe("paid image cost bound", () => {
  it("bills a 1024x1024 flux/schnell image as 2 megapixels and stays within USD 0.10", () => {
    expect(billedMegapixels(1024, 1024)).toBe(2);
    expect(maxImageCostUsd()).toBeCloseTo(0.006, 6);
    expect(() => assertWithinBudget()).not.toThrow();
    expect(PAID_IMAGE_TEST.model).toBe("fal-ai/flux/schnell");
  });
});

describe("experiment id", () => {
  it.each(["cs-paid-img-2026-09-26-a", "cs-paid-img-abcd"])("accepts %s", (id) => {
    expect(assertExperimentId(id)).toBe(id);
  });
  it.each([undefined, "", "paid", "cs-paid-img-", "CS-PAID-IMG-ABCD", "cs-paid-img-a b c"])(
    "rejects %s",
    (id) => {
      expect(() => assertExperimentId(id as string | undefined)).toThrow();
    },
  );
});

describe("duplicate-spend decision (at most one paid request per fixture org)", () => {
  it("is ready only when the org never generated and holds no claim", () => {
    expect(decideState({ generationCount: 0, claim: null })).toEqual({ state: "ready" });
  });
  it("only inspects once any generation exists (e.g. a GitHub rerun after the paid run)", () => {
    expect(decideState({ generationCount: 1, claim })).toMatchObject({ state: "inspect" });
    expect(decideState({ generationCount: 1, claim: null })).toMatchObject({ state: "inspect" });
  });
  it("only inspects when a claim exists even with zero generations (ambiguous outcome)", () => {
    expect(decideState({ generationCount: 0, claim })).toMatchObject({ state: "inspect" });
  });
  it("treats a malformed claim as a claim, never as permission to spend", () => {
    const malformed = readClaim({ [PAID_IMAGE_TEST.claimKey]: "garbage" });
    expect(malformed).not.toBeNull();
    expect(decideState({ generationCount: 0, claim: malformed })).toMatchObject({
      state: "inspect",
    });
  });
  it("reads no claim from empty or unrelated settings", () => {
    expect(readClaim({})).toBeNull();
    expect(readClaim(null)).toBeNull();
    expect(readClaim({ creator_studio_v1: true })).toBeNull();
  });
});

describe("credit top-up grants only the shortfall to 20", () => {
  it.each([
    [null, 20],
    [{ available: 0, reserved: 0 }, 20],
    [{ available: 5, reserved: 0 }, 15],
    [{ available: 20, reserved: 0 }, 0],
  ])("balance %j -> grant %i", (balance, grant) => {
    expect(creditShortfall(balance)).toBe(grant);
  });
  it("refuses when credits are reserved (in-flight generation)", () => {
    expect(() => creditShortfall({ available: 0, reserved: 20 })).toThrow(/reserved/);
  });
  it("refuses when the org holds more than one image needs", () => {
    expect(() => creditShortfall({ available: 21, reserved: 0 })).toThrow(/more credits/);
  });
});

describe("positive fixture ownership", () => {
  const good = {
    orgMarker: PAID_IMAGE_TEST.fixtureTag,
    fixtureUserMarker: PAID_IMAGE_TEST.fixtureTag,
    orgMembers: [{ userId: "u1", role: "OWNER" }],
    fixtureUserId: "u1",
    fixtureUserMembershipCount: 1,
  };
  it("accepts the marked org owned solely by the marked identity", () => {
    expect(() => assertDedicatedFixture(good)).not.toThrow();
  });
  it.each([
    ["unmarked identity", { fixtureUserMarker: undefined }],
    ["unmarked org", { orgMarker: undefined }],
    [
      "a second member (e.g. a personal account)",
      {
        orgMembers: [
          { userId: "u1", role: "OWNER" },
          { userId: "u2", role: "MEMBER" },
        ],
      },
    ],
    ["a different owner", { orgMembers: [{ userId: "u2", role: "OWNER" }] }],
    ["a non-owner fixture member", { orgMembers: [{ userId: "u1", role: "MEMBER" }] }],
    ["an identity in another org too", { fixtureUserMembershipCount: 2 }],
  ])("rejects %s", (_label, override) => {
    expect(() => assertDedicatedFixture({ ...good, ...override })).toThrow();
  });
});

describe("stored image detection", () => {
  it("recognizes PNG, JPEG and WebP magic bytes and rejects other data", () => {
    expect(
      detectImageFormat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png");
    expect(detectImageFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(detectImageFormat(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(detectImageFormat(new TextEncoder().encode("<html>"))).toBeNull();
  });
});

describe("outcome verification", () => {
  const generation: GenerationRecord = {
    id: "g1",
    provider: "fal",
    model: "fal-ai/flux/schnell",
    status: "COMPLETED",
    generationType: "IMAGE",
    outputAssetIds: ["a1"],
    creditsReserved: 20,
    creditsConsumed: 20,
    hasProviderRequestId: true,
  };
  const good = {
    generations: [generation],
    ledger: [
      { generationId: null, type: "GRANT", amount: 20 },
      { generationId: "g1", type: "RESERVE", amount: 20 },
      { generationId: "g1", type: "COMMIT", amount: 20 },
    ],
    balance: { available: 0, reserved: 0 },
    storedImageFormat: "jpeg",
    storedImageBytes: 12345,
  };

  it("passes for one fal image with one 20-credit charge and a stored image", () => {
    expect(evaluateOutcome(good)).toEqual([]);
  });
  it("flags a duplicate provider request (two generations)", () => {
    expect(
      evaluateOutcome({ ...good, generations: [generation, { ...generation, id: "g2" }] }),
    ).toEqual(["expected exactly 1 generation in the fixture org, found 2"]);
  });
  it("flags the mock provider", () => {
    expect(
      evaluateOutcome({
        ...good,
        generations: [{ ...generation, provider: "mock", model: "mock-image-v1" }],
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("provider mock")]));
  });
  it("flags a failed generation whose reservation was released", () => {
    const problems = evaluateOutcome({
      ...good,
      generations: [{ ...generation, status: "FAILED", creditsConsumed: 0, outputAssetIds: [] }],
      ledger: [
        { generationId: "g1", type: "RESERVE", amount: 20 },
        { generationId: "g1", type: "RELEASE", amount: 20 },
      ],
      balance: { available: 20, reserved: 0 },
      storedImageFormat: null,
      storedImageBytes: 0,
    });
    expect(problems.join("|")).toMatch(/status FAILED/);
    expect(problems.join("|")).toMatch(/ledger/);
  });
  it("flags a double charge in the ledger", () => {
    const problems = evaluateOutcome({
      ...good,
      ledger: [...good.ledger, { generationId: "g1", type: "COMMIT", amount: 20 }],
    });
    expect(problems.join("|")).toMatch(/ledger for the generation/);
  });
  it("flags a missing or non-image stored output", () => {
    expect(evaluateOutcome({ ...good, storedImageFormat: null, storedImageBytes: 0 }).length).toBe(
      2,
    );
  });
});
