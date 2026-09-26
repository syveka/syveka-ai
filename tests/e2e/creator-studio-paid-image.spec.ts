import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";
import {
  PAID_IMAGE_TEST,
  parseProviderReference,
  sanitizedCall,
} from "../../scripts/lib/creator-studio-paid-image";

/**
 * ONE human-approved, real-provider (fal.ai) Creator Studio image, driven only
 * by .github/workflows/staging-creator-studio-paid-image.yml against the
 * dedicated fixture org that scripts/creator-studio-paid-image-fixture.ts
 * prepares. Skipped everywhere else (staging release smoke, PR previews,
 * local runs) because CREATOR_STUDIO_PAID_IMAGE_TEST is never set there.
 *
 * Scope: backend generation/storage plus UI-status test. Creator Studio has no
 * UI that displays a generated image, so "the image displays" is NOT tested.
 *
 *   @preflight  free: synthetic character (tiny generated PNGs, not a real
 *               person's likeness); proves through the app that the provider
 *               is fal (image estimate 20 credits; mock/unknown would be 10),
 *               the org never generated, and holds exactly 20 credits.
 *   @submit     the single paid request: "No template" + 1:1 pinned (the
 *               deployed code maps this to one 1024x1024 fal-ai/flux/schnell
 *               image), build SHA re-checked, one click on Generate, never
 *               repeated. Only runs when the claim step set
 *               CREATOR_STUDIO_PAID_IMAGE_SUBMIT=1. On a UI timeout it only
 *               inspects the existing job.
 *
 * HTTP failures are reported as fixed labels + status codes only
 * (sanitizedCall): never URLs (signed upload URLs carry tokens) or bodies.
 */
const ENABLED = process.env.CREATOR_STUDIO_PAID_IMAGE_TEST === "1";
const SUBMIT = process.env.CREATOR_STUDIO_PAID_IMAGE_SUBMIT === "1";
export const PAID_IMAGE_PROMPT =
  "A clean studio photograph of a small green plant in a white ceramic pot on a light neutral background, soft daylight, no text, no logos.";

// Synthetic 1x1 PNG (same bytes as creator-studio-live.spec.ts): passes the
// real magic-byte check without being anyone's photo.
const SYNTHETIC_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const REQUEST_TIMEOUT_MS = 60_000;
const GENERATION_WAIT_MS = 5 * 60_000;

type Json<T> = { data?: T };
type Generation = {
  id: string;
  status: string;
  provider: string;
  generationType: string;
  outputAssetIds: string[];
  creditsConsumed: number;
  providerRequestId: unknown;
};

async function getJson<T>(api: APIRequestContext, label: string, url: string): Promise<T> {
  const res = await sanitizedCall(label, () => api.get(url, { timeout: REQUEST_TIMEOUT_MS }));
  return ((await res.json().catch(() => ({}))) as Json<T>).data as T;
}

async function ensureSyntheticProfile(api: APIRequestContext): Promise<string> {
  const profiles = await getJson<Array<{ id: string; displayName: string; status: string }>>(
    api,
    "list profiles",
    "/api/v1/creator-studio/profiles",
  );
  let profile = profiles.find((p) => p.displayName === PAID_IMAGE_TEST.profileDisplayName);
  if (!profile) {
    const res = await sanitizedCall(
      "create synthetic profile",
      () =>
        api.post("/api/v1/creator-studio/profiles", {
          data: { displayName: PAID_IMAGE_TEST.profileDisplayName },
          timeout: REQUEST_TIMEOUT_MS,
        }),
      { expectStatus: 201 },
    );
    profile = ((await res.json()) as Json<{ id: string; displayName: string; status: string }>)
      .data!;
  }
  if (profile.status === "ACTIVE") return profile.id;

  const detail = await getJson<{ referenceAssets: Array<{ validationStatus: string }> }>(
    api,
    "read synthetic profile",
    `/api/v1/creator-studio/profiles/${profile.id}`,
  );
  const approved = detail.referenceAssets.filter((a) => a.validationStatus === "APPROVED").length;
  for (let i = approved; i < 3; i++) {
    const intent = await sanitizedCall("reference upload intent", () =>
      api.post(`/api/v1/creator-studio/profiles/${profile.id}/reference-assets/upload-url`, {
        data: {
          fileName: `synthetic-${i}.png`,
          mimeType: "image/png",
          sizeBytes: SYNTHETIC_PNG.length,
        },
        timeout: REQUEST_TIMEOUT_MS,
      }),
    );
    const { uploadIntentId, signedUrl } = (
      (await intent.json()) as Json<{ uploadIntentId: string; signedUrl: string }>
    ).data!;
    await sanitizedCall("reference upload", () =>
      api.put(signedUrl, {
        data: SYNTHETIC_PNG,
        headers: { "Content-Type": "image/png" },
        timeout: REQUEST_TIMEOUT_MS,
      }),
    );
    await sanitizedCall(
      "reference confirm",
      () =>
        api.post(`/api/v1/creator-studio/profiles/${profile.id}/reference-assets/confirm`, {
          data: { uploadIntentId },
          timeout: REQUEST_TIMEOUT_MS,
        }),
      { expectStatus: 201 },
    );
  }
  // Operator attestation for a synthetic test subject; no real person is depicted.
  await sanitizedCall("synthetic profile activation", () =>
    api.post(`/api/v1/creator-studio/profiles/${profile.id}/consent`, {
      data: { consentConfirmed: true },
      timeout: REQUEST_TIMEOUT_MS,
    }),
  );
  return profile.id;
}

async function assertNeverSpentAndFunded(api: APIRequestContext): Promise<void> {
  const generations = await getJson<Generation[]>(
    api,
    "list generations",
    "/api/v1/creator-studio/generations",
  );
  expect(generations.length, "the fixture org must never have generated before").toBe(0);
  const credits = await getJson<{ availableCredits: number; reservedCredits: number }>(
    api,
    "read credits",
    "/api/v1/creator-studio/credits",
  );
  expect(credits).toEqual({ availableCredits: PAID_IMAGE_TEST.targetCredits, reservedCredits: 0 });
}

/** The app prices a fal IMAGE at 20 credits and a mock (or unknown) one at 10. */
async function openCreateAndAssertFalEstimate(page: Page, profileId: string): Promise<void> {
  await page.goto(`/en/creator-studio/create?creatorProfileId=${profileId}`);
  await expect(
    page.getByText(`Estimated cost: ${PAID_IMAGE_TEST.targetCredits} credits`),
  ).toBeVisible();
  await expect(
    page.getByText(`Estimated cost: ${PAID_IMAGE_TEST.mockImageCredits} credits`),
  ).toHaveCount(0);
}

/**
 * Pins the request the deployed code turns into one 1024x1024
 * fal-ai/flux/schnell image: IMAGE mode, "No template" (a template switches to
 * fal-ai/flux/dev/image-to-image) and aspect ratio 1:1.
 */
async function pinNoTemplateSquareImage(page: Page): Promise<void> {
  const template = page.locator("select", {
    has: page.locator('option[value=""]', { hasText: "No template" }),
  });
  await expect(template).toHaveCount(1);
  await template.selectOption("");
  await expect(template).toHaveValue("");

  const ratio = (label: string) => page.getByRole("button", { name: label, exact: true });
  await ratio("1:1").click();
  const selected = await ratio("1:1").getAttribute("class");
  const others = await Promise.all(
    ["4:5", "9:16", "16:9"].map((r) => ratio(r).getAttribute("class")),
  );
  expect(new Set(others).size, "the unselected ratios share one style").toBe(1);
  expect(selected, "1:1 is the selected ratio").not.toBe(others[0]);
}

/** Final build check immediately before the click; not a deployment lock. */
async function assertServingExpectedBuild(api: APIRequestContext): Promise<void> {
  const expectedSha = process.env.EXPECTED_BUILD_SHA;
  expect(expectedSha, "EXPECTED_BUILD_SHA must be provided").toMatch(/^[0-9a-f]{40}$/);
  const res = await sanitizedCall("staging health", () =>
    api.get("/api/health", { timeout: REQUEST_TIMEOUT_MS }),
  );
  const body = (await res.json().catch(() => ({}))) as { status?: string; build?: string };
  expect(body.status, "staging must be healthy").toBe("healthy");
  expect(body.build, "staging must still serve the expected build").toBe(expectedSha);
}

test.describe("Creator Studio paid image (single approved fal request)", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test.beforeEach(({}, testInfo) => {
    test.skip(!ENABLED, "Runs only from the staging paid-image workflow.");
    test.skip(testInfo.project.name !== "desktop", "One browser project only.");
    requireE2EUserCredentials();
  });

  test("@preflight provider is fal, estimate is 20 credits, org never spent", async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
    const profileId = await ensureSyntheticProfile(page.request);
    await assertNeverSpentAndFunded(page.request);
    await openCreateAndAssertFalEstimate(page, profileId);
    await pinNoTemplateSquareImage(page);
  });

  test("@submit one generation, persisted after refresh, one 20-credit charge", async ({
    page,
  }) => {
    test.skip(!SUBMIT, "The claim step did not authorize a submission for this run.");
    test.setTimeout(10 * 60_000);
    await openAuthenticatedE2EDashboard(page);
    const profileId = await ensureSyntheticProfile(page.request);
    await assertNeverSpentAndFunded(page.request);
    await openCreateAndAssertFalEstimate(page, profileId);
    await pinNoTemplateSquareImage(page);

    await page.getByPlaceholder("Describe the scene, setting, and style…").fill(PAID_IMAGE_PROMPT);
    const generate = page.getByRole("button", { name: "Generate", exact: true });
    await expect(generate).toBeEnabled();
    await assertServingExpectedBuild(page.request);
    await generate.click(); // the single paid submission -- never clicked again

    // Wait for the UI outcome, but never resubmit: a timeout falls through to
    // inspecting whatever job the one click created.
    await page
      .getByText(/Generation started|Generation failed|Insufficient/)
      .first()
      .waitFor({ timeout: GENERATION_WAIT_MS })
      .catch(() => undefined);

    let generations: Generation[] = [];
    const deadline = Date.now() + GENERATION_WAIT_MS;
    do {
      generations = await getJson<Generation[]>(
        page.request,
        "list generations",
        "/api/v1/creator-studio/generations",
      );
      if (generations.every((g) => g.status === "COMPLETED" || g.status === "FAILED")) break;
      await page.waitForTimeout(5_000);
    } while (Date.now() < deadline);

    // Field-by-field so a failure never dumps the raw provider metadata.
    expect(generations.length, "exactly one generation from one click").toBe(1);
    const g = generations[0]!;
    expect(g.generationType, "generation type").toBe("IMAGE");
    expect(g.status, "generation status").toBe("COMPLETED");
    expect(g.provider, "provider").toBe(PAID_IMAGE_TEST.provider);
    // Completion now keeps the submission record (with the endpoint actually
    // submitted); rows completed before that change hold the output URL.
    // Either way the endpoint must also be proven by this run's
    // pre-submission deployment check.
    const reference = parseProviderReference(g.providerRequestId);
    expect(["submission", "result-url"], "completed provider reference").toContain(reference.kind);
    if (reference.kind === "submission") {
      expect(reference.model, "recorded fal endpoint").toBe(PAID_IMAGE_TEST.model);
    }
    expect(process.env.VERIFIED_FAL_ENDPOINT, "fal endpoint verified before submission").toBe(
      PAID_IMAGE_TEST.model,
    );
    expect(g.creditsConsumed, "credits consumed").toBe(PAID_IMAGE_TEST.targetCredits);
    expect(g.outputAssetIds.length, "output assets").toBe(1);

    await page.goto("/en/creator-studio/library");
    await page.reload();
    await expect(page.getByText("Image · Completed")).toHaveCount(1);
    await expect(page.getByText(`${PAID_IMAGE_TEST.targetCredits} credits`)).toBeVisible();

    const credits = await getJson<{ availableCredits: number; reservedCredits: number }>(
      page.request,
      "read credits",
      "/api/v1/creator-studio/credits",
    );
    expect(credits).toEqual({ availableCredits: 0, reservedCredits: 0 });
  });
});
