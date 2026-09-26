import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";
import { PAID_IMAGE_TEST } from "../../scripts/lib/creator-studio-paid-image";

/**
 * ONE human-approved, real-provider (fal.ai) Creator Studio image, driven only
 * by .github/workflows/staging-creator-studio-paid-image.yml against the
 * dedicated fixture org that scripts/creator-studio-paid-image-fixture.ts
 * prepares. Skipped everywhere else (staging release smoke, PR previews,
 * local runs) because CREATOR_STUDIO_PAID_IMAGE_TEST is never set there.
 *
 *   @preflight  free: sets up a synthetic character (tiny generated PNGs, not a
 *               real person's likeness) and proves through the app that the
 *               provider is fal (image estimate 20 credits; mock would be 10),
 *               that the org has never generated, and holds exactly 20 credits.
 *   @submit     the single paid request: one click on Generate, never
 *               repeated. Only runs when the claim step set
 *               CREATOR_STUDIO_PAID_IMAGE_SUBMIT=1. If the UI times out, it only
 *               inspects the existing job.
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

type Json<T> = { data?: T; error?: { code: string } };
type Generation = {
  id: string;
  status: string;
  provider: string;
  model: string;
  generationType: string;
  outputAssetIds: string[];
  creditsConsumed: number;
};

async function getJson<T>(api: APIRequestContext, url: string): Promise<T> {
  const res = await api.get(url, { timeout: REQUEST_TIMEOUT_MS });
  const body = (await res.json().catch(() => ({}))) as Json<T>;
  expect(res.ok(), `GET ${url} failed with ${res.status()} ${body.error?.code ?? ""}`).toBeTruthy();
  return body.data as T;
}

async function ensureSyntheticProfile(api: APIRequestContext): Promise<string> {
  const profiles = await getJson<Array<{ id: string; displayName: string; status: string }>>(
    api,
    "/api/v1/creator-studio/profiles",
  );
  let profile = profiles.find((p) => p.displayName === PAID_IMAGE_TEST.profileDisplayName);
  if (!profile) {
    const res = await api.post("/api/v1/creator-studio/profiles", {
      data: { displayName: PAID_IMAGE_TEST.profileDisplayName },
      timeout: REQUEST_TIMEOUT_MS,
    });
    expect(res.status(), "create synthetic profile").toBe(201);
    profile = ((await res.json()) as Json<{ id: string; displayName: string; status: string }>)
      .data!;
  }
  if (profile.status === "ACTIVE") return profile.id;

  const detail = await getJson<{ referenceAssets: Array<{ validationStatus: string }> }>(
    api,
    `/api/v1/creator-studio/profiles/${profile.id}`,
  );
  const approved = detail.referenceAssets.filter((a) => a.validationStatus === "APPROVED").length;
  for (let i = approved; i < 3; i++) {
    const intent = await api.post(
      `/api/v1/creator-studio/profiles/${profile.id}/reference-assets/upload-url`,
      {
        data: {
          fileName: `synthetic-${i}.png`,
          mimeType: "image/png",
          sizeBytes: SYNTHETIC_PNG.length,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
    expect(intent.ok(), "reference upload intent").toBeTruthy();
    const { uploadIntentId, signedUrl } = (
      (await intent.json()) as Json<{
        uploadIntentId: string;
        signedUrl: string;
      }>
    ).data!;
    const put = await api.put(signedUrl, {
      data: SYNTHETIC_PNG,
      headers: { "Content-Type": "image/png" },
      timeout: REQUEST_TIMEOUT_MS,
    });
    expect(put.ok(), "reference upload").toBeTruthy();
    const confirm = await api.post(
      `/api/v1/creator-studio/profiles/${profile.id}/reference-assets/confirm`,
      { data: { uploadIntentId }, timeout: REQUEST_TIMEOUT_MS },
    );
    expect(confirm.status(), "reference confirm").toBe(201);
  }
  // Operator attestation for a synthetic test subject; no real person is depicted.
  const consent = await api.post(`/api/v1/creator-studio/profiles/${profile.id}/consent`, {
    data: { consentConfirmed: true },
    timeout: REQUEST_TIMEOUT_MS,
  });
  expect(consent.ok(), "synthetic profile activation").toBeTruthy();
  return profile.id;
}

async function assertNeverSpentAndFunded(api: APIRequestContext): Promise<void> {
  const generations = await getJson<Generation[]>(api, "/api/v1/creator-studio/generations");
  expect(generations, "the fixture org must never have generated before").toHaveLength(0);
  const credits = await getJson<{ availableCredits: number; reservedCredits: number }>(
    api,
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
  });

  test("@submit exactly one generation, persisted after refresh, one 20-credit charge", async ({
    page,
  }) => {
    test.skip(!SUBMIT, "The claim step did not authorize a submission for this run.");
    test.setTimeout(10 * 60_000);
    await openAuthenticatedE2EDashboard(page);
    const profileId = await ensureSyntheticProfile(page.request);
    await assertNeverSpentAndFunded(page.request);
    await openCreateAndAssertFalEstimate(page, profileId);

    await page.getByPlaceholder("Describe the scene, setting, and style…").fill(PAID_IMAGE_PROMPT);
    const generate = page.getByRole("button", { name: "Generate", exact: true });
    await expect(generate).toBeEnabled();
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
      generations = await getJson<Generation[]>(page.request, "/api/v1/creator-studio/generations");
      if (generations.every((g) => g.status === "COMPLETED" || g.status === "FAILED")) break;
      await page.waitForTimeout(5_000);
    } while (Date.now() < deadline);

    expect(generations, "exactly one generation from one click").toHaveLength(1);
    const g = generations[0]!;
    expect(g).toMatchObject({
      generationType: "IMAGE",
      status: "COMPLETED",
      provider: PAID_IMAGE_TEST.provider,
      model: PAID_IMAGE_TEST.model,
      creditsConsumed: PAID_IMAGE_TEST.targetCredits,
    });
    expect(g.outputAssetIds).toHaveLength(1);

    await page.goto("/en/creator-studio/library");
    await page.reload();
    await expect(page.getByText("Image · Completed")).toHaveCount(1);
    await expect(page.getByText(`${PAID_IMAGE_TEST.targetCredits} credits`)).toBeVisible();

    const credits = await getJson<{ availableCredits: number; reservedCredits: number }>(
      page.request,
      "/api/v1/creator-studio/credits",
    );
    expect(credits).toEqual({ availableCredits: 0, reservedCredits: 0 });
  });
});
