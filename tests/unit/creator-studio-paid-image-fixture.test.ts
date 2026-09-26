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
  classifyOutcome,
  evaluateDeployment,
  parseProviderReference,
  parseProviderSubmission,
  sanitizedCall,
  sanitizedHttpFailure,
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

const SUBMISSION = JSON.stringify({
  requestId: "req-1",
  statusUrl: "https://queue.fal.run/fal-ai/flux/requests/req-1/status",
  responseUrl: "https://queue.fal.run/fal-ai/flux/requests/req-1",
  model: "fal-ai/flux/schnell",
});

describe("provider request metadata (the real fal endpoint)", () => {
  it("reads the endpoint from providerRequestId, not the row's model field", () => {
    expect(parseProviderSubmission(SUBMISSION)).toEqual({
      ok: true,
      model: "fal-ai/flux/schnell",
    });
  });
  it.each([
    [null, "missing"],
    [undefined, "missing"],
    ["", "missing"],
    ["{not json", "malformed"],
    [42, "unexpected"],
    ['["array"]', "unexpected"],
    [JSON.stringify({ requestId: "r", model: 7 }), "unexpected"],
    [JSON.stringify({ model: "fal-ai/flux/schnell" }), "unexpected"],
    [JSON.stringify({ requestId: "r", model: "https://evil.example/x" }), "unexpected"],
  ])("rejects %j as %s without echoing it", (raw, reason) => {
    const parsed = parseProviderSubmission(raw);
    expect(parsed).toEqual({ ok: false, reason });
    expect(JSON.stringify(parsed)).not.toContain("queue.fal.run");
  });
});

describe("pre-submission deployment check (env names only)", () => {
  const SHA = "a".repeat(40);
  const alias = { deploymentId: "dpl_abc123", projectId: "prj_staging" };
  const deployment = {
    id: "dpl_abc123",
    projectId: "prj_staging",
    readyState: "READY",
    target: "production",
    meta: { githubCommitSha: SHA },
    env: ["DATABASE_URL", "FAL_API_KEY", "VERCEL_URL"],
  };
  const check = (a: unknown, d: unknown) =>
    evaluateDeployment({ alias: a, deployment: d, expectedBuildSha: SHA });

  it("accepts the serving staging deployment with FAL_API_KEY and no overrides", () => {
    expect(check(alias, deployment)).toEqual({
      problems: [],
      deploymentId: "dpl_abc123",
    });
  });
  it.each(["FAL_IMAGE_MODEL", "CREATOR_MEDIA_PROVIDER"])(
    "rejects a runtime %s override",
    (name) => {
      expect(
        check(alias, {
          ...deployment,
          env: [...deployment.env, name],
        }).problems.join("|"),
      ).toContain(name);
    },
  );
  it.each([
    ["missing FAL_API_KEY", { env: ["DATABASE_URL"] }, /FAL_API_KEY is not/],
    ["malformed env list", { env: "FAL_API_KEY" }, /env name list/],
    ["env list with values", { env: [{ key: "FAL_API_KEY" }] }, /env name list/],
    ["another build", { meta: { githubCommitSha: "b".repeat(40) } }, /commit SHA/],
    ["no build metadata", { meta: undefined }, /commit SHA/],
    ["not ready", { readyState: "BUILDING" }, /not READY/],
    ["a preview deployment", { target: null }, /stable/],
    ["another project", { projectId: "prj_other" }, /same project/],
    ["a malformed id", { id: "x" }, /id is missing or malformed/],
  ])("rejects %s", (_label, override, message) => {
    expect(check(alias, { ...deployment, ...override }).problems.join("|")).toMatch(message);
  });
  it("rejects an alias pointing elsewhere, and non-object responses", () => {
    expect(check({ ...alias, deploymentId: "dpl_other" }, deployment).problems.join("|")).toMatch(
      /does not point/,
    );
    expect(check("oops", deployment).problems).toEqual([
      "the alias or deployment response is not a JSON object",
    ]);
    expect(check(alias, null).problems).toEqual([
      "the alias or deployment response is not a JSON object",
    ]);
  });
});

describe("sanitized HTTP failures (no URLs, tokens or bodies)", () => {
  const signed = "https://x.supabase.co/storage/v1/object/upload/sign/b/p?token=SECRET";
  const response = (status: number) => ({
    status: () => status,
    ok: () => status < 400,
  });

  it("replaces a network error (which may embed the signed URL) with a fixed label", async () => {
    const error = await sanitizedCall("reference upload", async () => {
      throw new Error(`apiRequestContext.put: connect ECONNRESET ${signed}`);
    }).catch((e: Error) => e);
    expect((error as Error).message).toBe("reference upload failed (network error)");
    expect((error as Error).message).not.toContain("SECRET");
  });
  it("reports HTTP failures by status code only", async () => {
    await expect(sanitizedCall("reference upload", async () => response(403))).rejects.toThrow(
      /^reference upload failed \(HTTP 403\)$/,
    );
    await expect(
      sanitizedCall("reference confirm", async () => response(200), {
        expectStatus: 201,
      }),
    ).rejects.toThrow("reference confirm failed (HTTP 200)");
  });
  it("passes successful responses through", async () => {
    const ok = response(201);
    await expect(sanitizedCall("create", async () => ok, { expectStatus: 201 })).resolves.toBe(ok);
  });
  it("never lets a caller-supplied label smuggle data", () => {
    expect(sanitizedHttpFailure(signed, null)).toBe("request failed (network error)");
    expect(sanitizedHttpFailure("read credits", 500)).toBe("read credits failed (HTTP 500)");
  });
});

describe("outcome classification (job status and ledger reported separately)", () => {
  const completed: GenerationRecord = {
    id: "g1",
    provider: "fal",
    status: "COMPLETED",
    generationType: "IMAGE",
    errorCode: null,
    outputAssetIds: ["a1"],
    creditsConsumed: 20,
    providerRequestIdRaw: SUBMISSION,
  };
  const good = {
    claimPresent: true,
    generations: [completed],
    ledger: [
      { generationId: null, type: "GRANT", amount: 20 },
      { generationId: "g1", type: "RESERVE", amount: 20 },
      { generationId: "g1", type: "COMMIT", amount: 20 },
    ],
    balance: { available: 0, reserved: 0 },
    storedImageFormat: "jpeg",
    storedImageBytes: 12345,
  };
  const failedLedger = [
    { generationId: "g1", type: "RESERVE", amount: 20 },
    { generationId: "g1", type: "RELEASE", amount: 20 },
  ];

  it("PASSes one completed flux/schnell image with one 20-credit charge and a stored image", () => {
    const result = classifyOutcome(good);
    expect(result).toMatchObject({
      outcome: "COMPLETED_VERIFIED",
      pass: true,
      automaticRetry: false,
      providerModel: "fal-ai/flux/schnell",
      ledger: { reserved: 20, committed: 20, released: 0 },
      problems: [],
    });
  });

  it("regression: a row whose model column is 'default' still passes via the provider metadata", () => {
    const withDefaultModel = {
      ...completed,
      model: "default",
    } as GenerationRecord;
    expect(classifyOutcome({ ...good, generations: [withDefaultModel] }).pass).toBe(true);
  });

  it("fails when the provider metadata names a different fal endpoint", () => {
    const other = {
      ...completed,
      providerRequestIdRaw: JSON.stringify({
        requestId: "r",
        model: "fal-ai/flux-pro/v1.1-ultra",
      }),
    };
    const result = classifyOutcome({ ...good, generations: [other] });
    expect(result.pass).toBe(false);
    expect(result.problems.join("|")).toMatch(/fal endpoint fal-ai\/flux-pro/);
  });

  it("distinguishes 'not attempted' from 'claimed but no generation'", () => {
    expect(classifyOutcome({ ...good, claimPresent: false, generations: [] }).outcome).toBe(
      "NOT_ATTEMPTED",
    );
    const claimed = classifyOutcome({ ...good, generations: [] });
    expect(claimed.outcome).toBe("CLAIMED_NO_GENERATION");
    expect(claimed.pass).toBe(false);
    expect(claimed.billing).toMatch(/before the provider call/);
  });

  it("marks a generation without provider metadata as ambiguous (may be billed)", () => {
    const result = classifyOutcome({
      ...good,
      generations: [{ ...completed, status: "GENERATING", providerRequestIdRaw: null }],
    });
    expect(result.outcome).toBe("NO_PROVIDER_REQUEST_ID");
    expect(result.billing).toMatch(/AMBIGUOUS.*may be billed/);
    expect(result.automaticRetry).toBe(false);
  });

  it("marks malformed provider metadata as ambiguous, never as success", () => {
    const result = classifyOutcome({
      ...good,
      generations: [{ ...completed, providerRequestIdRaw: "{broken" }],
    });
    expect(result).toMatchObject({
      outcome: "NO_PROVIDER_REQUEST_ID",
      pass: false,
    });
    expect(result.problems.join("|")).toMatch(/malformed/);
  });

  it("recognizes a reservation failure (provider never called) separately", () => {
    const result = classifyOutcome({
      ...good,
      generations: [
        {
          ...completed,
          status: "FAILED",
          errorCode: "insufficient_credits",
          providerRequestIdRaw: null,
        },
      ],
    });
    expect(result.outcome).toBe("NO_PROVIDER_REQUEST_ID");
    expect(result.billing).toMatch(/provider was not called/);
  });

  it("reports an accepted job that has not finished as pending", () => {
    const result = classifyOutcome({
      ...good,
      generations: [{ ...completed, status: "GENERATING" }],
    });
    expect(result).toMatchObject({
      outcome: "PROVIDER_JOB_PENDING",
      pass: false,
    });
  });

  it("reports a failed accepted job without assuming a refund", () => {
    const refunded = classifyOutcome({
      ...good,
      generations: [
        {
          ...completed,
          status: "FAILED",
          errorCode: "provider_error",
          outputAssetIds: [],
        },
      ],
      ledger: failedLedger,
      balance: { available: 20, reserved: 0 },
    });
    expect(refunded).toMatchObject({
      outcome: "GENERATION_FAILED",
      ledger: { reserved: 20, committed: 0, released: 20 },
    });
    const notRefunded = classifyOutcome({
      ...good,
      generations: [
        {
          ...completed,
          status: "FAILED",
          errorCode: "provider_error",
          outputAssetIds: [],
        },
      ],
      ledger: [{ generationId: "g1", type: "RESERVE", amount: 20 }],
    });
    expect(notRefunded.ledger).toEqual({
      reserved: 20,
      committed: 0,
      released: 0,
    });
    expect(notRefunded.billing).toMatch(/not assumed/);
  });

  it("flags duplicates, double charges and missing stored images", () => {
    expect(
      classifyOutcome({
        ...good,
        generations: [completed, { ...completed, id: "g2" }],
      }).outcome,
    ).toBe("MULTIPLE_GENERATIONS");
    const doubled = classifyOutcome({
      ...good,
      ledger: [...good.ledger, { generationId: "g1", type: "COMMIT", amount: 20 }],
    });
    expect(doubled).toMatchObject({
      outcome: "COMPLETED_UNVERIFIED",
      pass: false,
    });
    const noImage = classifyOutcome({
      ...good,
      storedImageFormat: null,
      storedImageBytes: 0,
    });
    expect(noImage.outcome).toBe("COMPLETED_UNVERIFIED");
    expect(noImage.problems).toHaveLength(2);
  });
});
/**
 * Regression for run 36235671519: at the served SHA, claimGenerationCompleted
 * overwrites providerRequestId with the final output URL (persistFirstImage
 * `providerRequestId: url`). The fixture below is synthetic but has the real
 * stored shape: a plain https URL string, not JSON.
 */
const COMPLETED_RESULT_URL = "https://v3.fal.media/files/synthetic/output-0001.jpeg";

describe("provider reference shapes (submission record vs completed result URL)", () => {
  it("regression: a completed row's plain output URL is a result reference, not malformed", () => {
    expect(parseProviderSubmission(COMPLETED_RESULT_URL)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseProviderReference(COMPLETED_RESULT_URL)).toEqual({
      kind: "result-url",
      host: "v3.fal.media",
    });
  });
  it("reads the endpoint from a submission record", () => {
    expect(parseProviderReference(SUBMISSION)).toEqual({
      kind: "submission",
      model: "fal-ai/flux/schnell",
    });
  });
  it.each([
    [null, "missing"],
    ["", "missing"],
    [17, "unexpected"],
    ["not a url", "malformed"],
    ["http://v3.fal.media/files/x.jpeg", "unexpected"],
    ["https://user:secret@v3.fal.media/files/x.jpeg", "unexpected"],
    ['{"requestId":"r","model":7}', "unexpected"],
    ["{broken", "malformed"],
  ])("rejects %j as %s without echoing it", (raw, reason) => {
    const parsed = parseProviderReference(raw);
    expect(parsed).toEqual({ kind: "invalid", reason });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|files\/x/);
  });
  it("returns only the hostname of a result URL, never its path or query", () => {
    const parsed = parseProviderReference("https://v3.fal.media/files/a/b.jpeg?token=SECRET");
    expect(parsed).toEqual({ kind: "result-url", host: "v3.fal.media" });
  });
});

describe("completed generation with the real stored shape", () => {
  const completedWithUrl: GenerationRecord = {
    id: "g1",
    provider: "fal",
    status: "COMPLETED",
    generationType: "IMAGE",
    errorCode: null,
    outputAssetIds: ["a1"],
    creditsConsumed: 20,
    providerRequestIdRaw: COMPLETED_RESULT_URL,
  };
  const evidence = {
    claimPresent: true,
    generations: [completedWithUrl],
    ledger: [
      { generationId: null, type: "GRANT", amount: 20 },
      { generationId: "g1", type: "RESERVE", amount: 20 },
      { generationId: "g1", type: "COMMIT", amount: 20 },
    ],
    balance: { available: 0, reserved: 0 },
    storedImageFormat: "jpeg",
    storedImageBytes: 405934,
  };

  it("PASSes only with this run's pre-submission endpoint verification", () => {
    const result = classifyOutcome({
      ...evidence,
      preSubmissionEndpoint: "fal-ai/flux/schnell",
    });
    expect(result).toMatchObject({
      outcome: "COMPLETED_VERIFIED",
      pass: true,
      providerModel: "fal-ai/flux/schnell",
      endpointEvidence: "pre-submission-deployment-check",
      resultHost: "v3.fal.media",
      ledger: { reserved: 20, committed: 20, released: 0 },
      problems: [],
    });
  });

  it("is COMPLETED_UNVERIFIED (not ambiguous billing) without endpoint evidence, e.g. a later inspect run", () => {
    const result = classifyOutcome(evidence);
    expect(result).toMatchObject({
      outcome: "COMPLETED_UNVERIFIED",
      pass: false,
      providerModel: null,
      endpointEvidence: "none",
    });
    expect(result.problems).toEqual([
      "fal endpoint is not recorded after completion and this run has no pre-submission endpoint verification",
    ]);
    expect(result.billing).toBe("One fal job completed (billed by fal).");
  });

  it("stays strict: a different pre-submission endpoint fails", () => {
    const result = classifyOutcome({
      ...evidence,
      preSubmissionEndpoint: "fal-ai/flux-pro/v1.1-ultra",
    });
    expect(result.pass).toBe(false);
    expect(result.problems.join("|")).toMatch(/pre-submission endpoint fal-ai\/flux-pro/);
  });

  it("prefers a recorded submission and still rejects a wrong recorded endpoint", () => {
    const wrong = {
      ...completedWithUrl,
      providerRequestIdRaw: JSON.stringify({
        requestId: "r",
        model: "fal-ai/flux/dev",
      }),
    };
    const result = classifyOutcome({
      ...evidence,
      generations: [wrong],
      preSubmissionEndpoint: "fal-ai/flux/schnell",
    });
    expect(result.pass).toBe(false);
    expect(result.endpointEvidence).toBe("submission-record");
    expect(result.problems.join("|")).toMatch(/fal endpoint fal-ai\/flux\/dev/);
  });

  it("treats a result URL on a non-completed generation as ambiguous", () => {
    const result = classifyOutcome({
      ...evidence,
      generations: [{ ...completedWithUrl, status: "GENERATING" }],
      preSubmissionEndpoint: "fal-ai/flux/schnell",
    });
    expect(result).toMatchObject({
      outcome: "NO_PROVIDER_REQUEST_ID",
      pass: false,
    });
  });
});
