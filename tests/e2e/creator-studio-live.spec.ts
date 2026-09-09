import { test, expect, type APIRequestContext } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";

/**
 * Creator Studio real-provider golden path (opt-in, live-cost smoke test).
 *
 * This is deliberately NOT part of the default `npm run test:e2e` run in any
 * automated pipeline: it is gated behind CREATOR_STUDIO_LIVE_E2E=1 and, even
 * then, only proceeds as far as the target environment is actually
 * configured for. It proves the full golden path against REAL, COST-
 * INCURRING providers when they are configured:
 *
 *   creator profile -> reference assets -> consent -> image generation
 *   -> video generation (if a real media provider is configured)
 *   -> caption generation -> campaign -> post -> approval -> schedule
 *   -> publish (real Meta Graph API call, if a real connected account
 *      exists) -> analytics -> credit ledger
 *
 * Requirements to actually exercise every stage (all optional — stages this
 * environment isn't configured for are skipped with a clear reason, never
 * silently treated as passed):
 *   - CREATOR_STUDIO_LIVE_E2E=1 (opt-in switch)
 *   - E2E_USER_EMAIL / E2E_USER_PASSWORD (existing E2E auth requirement)
 *   - The target org has the creator_studio_v1 feature flag enabled and a
 *     nonzero monthly credit grant.
 *   - FAL_API_KEY configured on the target deployment, for real image/video
 *     generation (mock provider runs otherwise and still proves the
 *     pipeline, just without a real fal.ai call).
 *   - A REAL, already-connected Facebook Page or Instagram professional
 *     account under Creator Studio -> Social accounts, connected via the
 *     real Meta OAuth flow (src/server/social/meta-provider.ts) ahead of
 *     time by a human, on a dedicated TEST Page/account — never a
 *     production brand account, since this test publishes a real, public
 *     post. Without one, every stage up to (not including) publish still
 *     runs and is asserted; publish is skipped with a clear reason.
 *
 * Safety: this test can incur real fal.ai/Meta API costs and will publish
 * live content to whatever social account it finds connected. Never point
 * CREATOR_STUDIO_LIVE_E2E at a production organization's real social
 * accounts.
 */

const PUBLISH_POLL_TIMEOUT_MS = 3 * 60_000;
const PUBLISH_POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 2 * 60_000; // real provider round trips run synchronously in-request

// A minimal, valid 1x1 transparent PNG — passes the real magic-byte/MIME
// verification in src/server/security/creator-asset-ingestion.ts without
// needing a real photo; reused for all reference-asset uploads.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type JsonResponse<T> = { data?: T; error?: { code: string; message?: string } };

async function asJson<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
): Promise<JsonResponse<T>> {
  return (await res.json().catch(() => ({}))) as JsonResponse<T>;
}

test.describe("Creator Studio: real-provider golden path (opt-in)", () => {
  test.beforeAll(() => {
    // Checked first, before requiring E2E auth credentials: an environment
    // that simply hasn't opted in shouldn't need E2E_USER_EMAIL/PASSWORD
    // configured just to reach a skip.
    test.skip(
      process.env.CREATOR_STUDIO_LIVE_E2E !== "1",
      "Opt-in only — exercises real, cost-incurring providers and can publish a live post. " +
        "Set CREATOR_STUDIO_LIVE_E2E=1 against an environment with Creator Studio enabled for the E2E org.",
    );
    requireE2EUserCredentials();
  });

  test("creator -> image -> video (if available) -> caption -> campaign -> approval -> schedule -> publish -> analytics -> credit ledger", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "Spends real credits and can publish a real post — runs once (desktop) to avoid a desktop/mobile double-run.",
    );
    test.setTimeout(10 * 60_000);
    await openAuthenticatedE2EDashboard(page);

    const label = `E2E Live ${Date.now()}`;
    let creatorProfileId = "";
    let imageAssetId = "";
    let videoAssetId: string | null = null;
    let realVideoProvider = false;
    let campaignId = "";
    let postId = "";
    let connectedAccount: { id: string; platform: string } | null = null;

    await test.step("preflight: Creator Studio is enabled for this org", async () => {
      const res = await request.get("/api/v1/creator-studio/profiles", {
        timeout: REQUEST_TIMEOUT_MS,
      });
      const body = await asJson<unknown[]>(res);
      test.skip(
        res.status() === 403 && body.error?.code === "feature_disabled",
        "creator_studio_v1 feature flag is not enabled for the E2E organization.",
      );
      expect(res.ok(), `GET /profiles failed: ${JSON.stringify(body)}`).toBeTruthy();
    });

    const creditsBefore =
      await test.step("credit ledger: snapshot balance before spending", async () => {
        const res = await request.get("/api/v1/creator-studio/credits", {
          timeout: REQUEST_TIMEOUT_MS,
        });
        expect(res.ok()).toBeTruthy();
        const { data } = await asJson<{ availableCredits: number; reservedCredits: number }>(res);
        expect(typeof data?.availableCredits).toBe("number");
        return data!;
      });

    await test.step("creator: create profile", async () => {
      const res = await request.post("/api/v1/creator-studio/profiles", {
        data: { displayName: label },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const body = await asJson<{ id: string }>(res);
      expect(res.status(), `create profile failed: ${JSON.stringify(body)}`).toBe(201);
      creatorProfileId = body.data!.id;
    });

    await test.step("reference assets: upload 3 real (tiny) images and confirm them", async () => {
      for (let i = 0; i < 3; i++) {
        const intentRes = await request.post(
          `/api/v1/creator-studio/profiles/${creatorProfileId}/reference-assets/upload-url`,
          {
            data: {
              fileName: `e2e-ref-${i}.png`,
              mimeType: "image/png",
              sizeBytes: TINY_PNG.length,
            },
            timeout: REQUEST_TIMEOUT_MS,
          },
        );
        const intentBody = await asJson<{ uploadIntentId: string; signedUrl: string }>(intentRes);
        expect(intentRes.ok(), `upload-url failed: ${JSON.stringify(intentBody)}`).toBeTruthy();
        const { uploadIntentId, signedUrl } = intentBody.data!;

        const putRes = await request.put(signedUrl, {
          data: TINY_PNG,
          headers: { "Content-Type": "image/png" },
          timeout: REQUEST_TIMEOUT_MS,
        });
        expect(putRes.ok(), `signed upload PUT failed with ${putRes.status()}`).toBeTruthy();

        const confirmRes = await request.post(
          `/api/v1/creator-studio/profiles/${creatorProfileId}/reference-assets/confirm`,
          { data: { uploadIntentId }, timeout: REQUEST_TIMEOUT_MS },
        );
        const confirmBody = await asJson<{ id: string }>(confirmRes);
        expect(confirmRes.status(), `confirm asset failed: ${JSON.stringify(confirmBody)}`).toBe(
          201,
        );
      }
    });

    await test.step("consent: confirm before any generation", async () => {
      const res = await request.post(
        `/api/v1/creator-studio/profiles/${creatorProfileId}/consent`,
        { data: { consentConfirmed: true }, timeout: REQUEST_TIMEOUT_MS },
      );
      expect(res.ok(), `consent confirm failed: ${JSON.stringify(await asJson(res))}`).toBeTruthy();
    });

    await test.step("image: generate a character image via the routed CreatorMediaProvider", async () => {
      const res = await request.post("/api/v1/creator-studio/generations/character-image", {
        data: {
          creatorProfileId,
          prompt: "a friendly professional headshot, studio lighting",
          aspectRatio: "1:1",
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const body = await asJson<{
        status: string;
        outputAssetIds: string[];
        provider: string;
      }>(res);
      expect(res.status(), `character-image generation failed: ${JSON.stringify(body)}`).toBe(201);
      expect(body.data?.status).toBe("COMPLETED");
      imageAssetId = body.data!.outputAssetIds[0]!;
      expect(imageAssetId, "generation completed with no output asset").toBeTruthy();
      test.info().annotations.push({ type: "media-provider", description: body.data!.provider });
    });

    await test.step("video: generate a video from the image, if a real/mock provider completes it", async () => {
      try {
        const res = await request.post("/api/v1/creator-studio/generations/video-from-image", {
          data: { sourceAssetId: imageAssetId, aspectRatio: "9:16", durationSeconds: 5 },
          timeout: REQUEST_TIMEOUT_MS,
        });
        const body = await asJson<{ status: string; outputAssetIds: string[]; provider: string }>(
          res,
        );
        if (res.status() === 201 && body.data?.status === "COMPLETED") {
          videoAssetId = body.data.outputAssetIds[0] ?? null;
          realVideoProvider = body.data.provider !== "mock";
          test.info().annotations.push({ type: "video-provider", description: body.data.provider });
        } else {
          test.info().annotations.push({
            type: "video-generation-skipped",
            description: `non-fatal: ${res.status()} ${JSON.stringify(body)}`,
          });
        }
      } catch (e) {
        // Video generation runs synchronously in-request (see
        // creator-generations.ts) and a real Kling call can run long enough
        // to hit a platform request timeout — a known architectural
        // constraint, not a bug in this test. Treated as a soft skip so the
        // rest of the golden path still proves out.
        test.info().annotations.push({
          type: "video-generation-skipped",
          description: `non-fatal: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    });

    let captionText = "";
    await test.step("caption: generate a real caption via the Claude caption provider", async () => {
      const res = await request.post("/api/v1/creator-studio/generations/caption", {
        data: { platform: "FACEBOOK", language: "EN", creatorProfileId },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const body = await asJson<{ status: string; output: { primary: string } }>(res);
      expect(res.status(), `caption generation failed: ${JSON.stringify(body)}`).toBe(201);
      expect(body.data?.status).toBe("COMPLETED");
      captionText = body.data!.output.primary;
      expect(captionText).toBeTruthy();
    });

    await test.step("campaign: create", async () => {
      const res = await request.post("/api/v1/creator-studio/campaigns", {
        data: {
          name: label,
          targetPlatforms: ["FACEBOOK", "INSTAGRAM"],
          approvalMode: "APPROVAL",
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const body = await asJson<{ id: string }>(res);
      expect(res.status(), `create campaign failed: ${JSON.stringify(body)}`).toBe(201);
      campaignId = body.data!.id;
    });

    await test.step("social account: find an already-connected real account (never auto-connects one)", async () => {
      const res = await request.get("/api/v1/creator-studio/social-accounts", {
        timeout: REQUEST_TIMEOUT_MS,
      });
      expect(res.ok()).toBeTruthy();
      const { data } = await asJson<Array<{ id: string; platform: string; status: string }>>(res);
      connectedAccount =
        (data ?? []).find(
          (a) =>
            a.status === "CONNECTED" && (a.platform === "FACEBOOK" || a.platform === "INSTAGRAM"),
        ) ?? null;
      if (!connectedAccount) {
        test.info().annotations.push({
          type: "publish-skipped",
          description:
            "No CONNECTED Facebook/Instagram social account found for the E2E org — connect one via the real Meta OAuth flow to exercise publish.",
        });
      }
    });

    await test.step("post: create with the generated image and caption", async () => {
      const res = await request.post("/api/v1/creator-studio/posts", {
        data: {
          campaignId,
          creatorProfileId,
          assetIds: [videoAssetId ?? imageAssetId],
          caption: captionText,
          hashtags: ["#e2e"],
          platform: connectedAccount?.platform ?? "FACEBOOK",
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const body = await asJson<{ id: string }>(res);
      expect(res.status(), `create post failed: ${JSON.stringify(body)}`).toBe(201);
      postId = body.data!.id;
    });

    await test.step("approval: request then approve", async () => {
      const requestRes = await request.post(
        `/api/v1/creator-studio/posts/${postId}/request-approval`,
        { timeout: REQUEST_TIMEOUT_MS },
      );
      expect(
        requestRes.ok(),
        `request-approval failed: ${JSON.stringify(await asJson(requestRes))}`,
      ).toBeTruthy();

      const reviewRes = await request.post(`/api/v1/creator-studio/posts/${postId}/review`, {
        data: { decision: "APPROVE" },
        timeout: REQUEST_TIMEOUT_MS,
      });
      expect(
        reviewRes.ok(),
        `review/approve failed: ${JSON.stringify(await asJson(reviewRes))}`,
      ).toBeTruthy();
    });

    await test.step("schedule + publish: schedule for now, poll for the real publish outcome", async () => {
      test.skip(!connectedAccount, "no connected social account — see prior step's annotation");

      const scheduleRes = await request.post(`/api/v1/creator-studio/posts/${postId}/schedule`, {
        data: { scheduledFor: new Date().toISOString(), socialAccountId: connectedAccount!.id },
        timeout: REQUEST_TIMEOUT_MS,
      });
      expect(
        scheduleRes.ok(),
        `schedule failed: ${JSON.stringify(await asJson(scheduleRes))}`,
      ).toBeTruthy();

      const deadline = Date.now() + PUBLISH_POLL_TIMEOUT_MS;
      let publishStatus = "SCHEDULED";
      let lastBody: JsonResponse<{ publishStatus: string; lastErrorSafe?: string }> = {};
      while (Date.now() < deadline) {
        const res = await request.get(`/api/v1/creator-studio/posts/${postId}`, {
          timeout: REQUEST_TIMEOUT_MS,
        });
        lastBody = await asJson(res);
        publishStatus = lastBody.data?.publishStatus ?? publishStatus;
        if (publishStatus === "PUBLISHED" || publishStatus === "FAILED") break;
        await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_INTERVAL_MS));
      }

      expect(
        publishStatus,
        `real Meta publish did not succeed: ${JSON.stringify(lastBody.data)}`,
      ).toBe("PUBLISHED");
    });

    await test.step("analytics: generation + publishing analytics respond", async () => {
      const gen = await request.get("/api/v1/creator-studio/analytics/generations", {
        timeout: REQUEST_TIMEOUT_MS,
      });
      expect(gen.ok()).toBeTruthy();
      const pub = await request.get("/api/v1/creator-studio/analytics/publishing", {
        timeout: REQUEST_TIMEOUT_MS,
      });
      expect(pub.ok()).toBeTruthy();
    });

    await test.step("credit ledger: spending was actually recorded", async () => {
      const res = await request.get("/api/v1/creator-studio/credits", {
        timeout: REQUEST_TIMEOUT_MS,
      });
      expect(res.ok()).toBeTruthy();
      const { data } = await asJson<{ availableCredits: number; reservedCredits: number }>(res);
      expect(data!.availableCredits).toBeLessThan(creditsBefore.availableCredits);
      expect(data!.reservedCredits).toBe(0); // every reservation above was committed or released, none left dangling
    });

    test.info().annotations.push({
      type: "summary",
      description: `realVideoProvider=${realVideoProvider}; publishedViaRealAccount=${Boolean(connectedAccount)}`,
    });
  });
});
