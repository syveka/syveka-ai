import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Secure preview of completed IMAGE generations: server-side authorization by
 * database relationship, a fixed private bucket, short-lived signed URLs,
 * private/no-store responses, and strictly read-only behaviour (viewing or
 * refreshing never generates, reserves, commits or releases anything).
 */
const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  generationFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
  createSignedUrl: vi.fn(),
  storageFrom: vi.fn(),
  assertFeatureEnabled: vi.fn(),
  requirePermission: vi.fn(),
  writes: vi.fn(),
}));

const { FakeAuthError, FakeFeatureDisabledError } = vi.hoisted(() => {
  class FakeAuthError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  class FakeFeatureDisabledError extends Error {
    readonly code = "feature_disabled";
  }
  return { FakeAuthError, FakeFeatureDisabledError };
});

vi.mock("@/server/db/tenant", () => ({ tenantDb: mocks.tenantDb }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ storage: { from: mocks.storageFrom } }),
}));
vi.mock("@/server/services/feature-flags", () => ({
  assertFeatureEnabled: mocks.assertFeatureEnabled,
  FeatureDisabledError: FakeFeatureDisabledError,
}));
vi.mock("@/server/services/creator-profiles", () => ({ CREATOR_STUDIO_FLAG: "creator_studio_v1" }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/auth/session", () => ({ AuthError: FakeAuthError }));
vi.mock("@/server/services/creator-studio-http", () => ({
  // Same status mapping as creator-studio-http.ts, using the standard Response.
  handleCreatorStudioError: (e: unknown) => {
    if (e instanceof FakeAuthError) {
      return Response.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    if (e instanceof FakeFeatureDisabledError) {
      return Response.json({ error: { code: "feature_disabled" } }, { status: 403 });
    }
    return Response.json({ error: { code: "internal_error" } }, { status: 500 });
  },
}));

import {
  GENERATED_MEDIA_BUCKET,
  PREVIEW_SIGNED_URL_TTL_SECONDS,
  isSafeGeneratedStoragePath,
  resolveGeneratedImage,
  signGeneratedImage,
} from "@/server/services/creator-generated-images";
import { GET } from "@/app/api/v1/creator-studio/generations/[id]/image/route";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const GEN = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const SIGNED =
  "https://staging.supabase.co/storage/v1/object/sign/creator-generated-media/fal/x.jpeg?token=SECRET";
const ctx = {
  userId: "u1",
  email: "a@example.com",
  orgId: ORG_A,
  role: "MEMBER",
  locale: "en",
} as const;

/** Any write on the tenant client fails the test: previews are read-only. */
function readOnlyDb() {
  const deny = (name: string) => () => {
    mocks.writes(name);
    throw new Error(`unexpected write: ${name}`);
  };
  return {
    creatorGeneration: {
      findFirst: mocks.generationFindFirst,
      create: deny("creatorGeneration.create"),
      update: deny("creatorGeneration.update"),
      updateMany: deny("creatorGeneration.updateMany"),
    },
    creatorReferenceAsset: {
      findFirst: mocks.assetFindFirst,
      create: deny("creatorReferenceAsset.create"),
    },
    creatorCreditBalance: { updateMany: deny("creatorCreditBalance.updateMany") },
    creatorCreditTransaction: { create: deny("creatorCreditTransaction.create") },
  };
}

function request(id: string) {
  return GET(new Request(`https://app.example/api/v1/creator-studio/generations/${id}/image`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenantDb.mockImplementation(() => readOnlyDb());
  mocks.assertFeatureEnabled.mockResolvedValue(undefined);
  mocks.requirePermission.mockResolvedValue(ctx);
  mocks.generationFindFirst.mockResolvedValue({ outputAssetIds: [ASSET] });
  mocks.assetFindFirst.mockResolvedValue({
    storagePath: "fal/0a1b2c3d-0000-4000-8000-000000000001.jpeg",
    mimeType: "image/jpeg",
    sizeBytes: 405934,
  });
  mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED }, error: null });
  mocks.storageFrom.mockReturnValue({ createSignedUrl: mocks.createSignedUrl });
});

describe("resolveGeneratedImage (authorization by database relationship)", () => {
  it("resolves a completed IMAGE generation's GENERATED asset inside the caller's org", async () => {
    await expect(resolveGeneratedImage(ctx, GEN)).resolves.toEqual({
      storagePath: "fal/0a1b2c3d-0000-4000-8000-000000000001.jpeg",
      mimeType: "image/jpeg",
    });
    expect(mocks.tenantDb).toHaveBeenCalledWith(ORG_A);
    expect(mocks.assertFeatureEnabled).toHaveBeenCalledWith(ORG_A, "creator_studio_v1");
    expect(mocks.generationFindFirst).toHaveBeenCalledWith({
      where: { id: GEN, status: "COMPLETED", generationType: "IMAGE" },
      select: { outputAssetIds: true },
    });
    // The asset id comes from the generation, never from the client.
    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { id: ASSET, source: "GENERATED" },
      select: { storagePath: true, mimeType: true, sizeBytes: true },
    });
  });

  it("denies another tenant's generation (not found in the caller's org)", async () => {
    mocks.generationFindFirst.mockResolvedValue(null);
    await expect(resolveGeneratedImage(ctx, GEN)).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
  });

  it("rejects an asset that is not this generation's GENERATED output in this org", async () => {
    mocks.assetFindFirst.mockResolvedValue(null);
    await expect(resolveGeneratedImage(ctx, GEN)).rejects.toMatchObject({ code: "asset_missing" });
  });

  it("reports a completed generation without output as no_output", async () => {
    mocks.generationFindFirst.mockResolvedValue({ outputAssetIds: [] });
    await expect(resolveGeneratedImage(ctx, GEN)).rejects.toMatchObject({ code: "no_output" });
  });

  it.each([
    ["a non-image asset", { mimeType: "video/mp4" }, "not_an_image"],
    ["a mock output without stored bytes", { sizeBytes: 0 }, "unavailable"],
    ["a traversal path", { storagePath: "../../etc/passwd.png" }, "invalid_path"],
    ["an absolute path", { storagePath: "/fal/x.png" }, "invalid_path"],
    ["a foreign-looking path", { storagePath: "org-b/secret/../x.png" }, "invalid_path"],
    ["a non-image extension", { storagePath: "fal/x.pdf" }, "invalid_path"],
    ["a URL instead of a key", { storagePath: "https://evil.example/x.png" }, "invalid_path"],
  ])("rejects %s", async (_label, override, code) => {
    mocks.assetFindFirst.mockResolvedValue({
      storagePath: "fal/0a1b2c3d-0000-4000-8000-000000000001.jpeg",
      mimeType: "image/jpeg",
      sizeBytes: 405934,
      ...override,
    });
    await expect(resolveGeneratedImage(ctx, GEN)).rejects.toMatchObject({ code });
  });

  it("rejects a malformed generation id before touching the database", async () => {
    await expect(resolveGeneratedImage(ctx, "../x")).rejects.toMatchObject({ code: "invalid_id" });
    expect(mocks.tenantDb).not.toHaveBeenCalled();
  });

  it("requires the Creator Studio feature flag", async () => {
    mocks.assertFeatureEnabled.mockRejectedValue(new FakeFeatureDisabledError("off"));
    await expect(resolveGeneratedImage(ctx, GEN)).rejects.toBeInstanceOf(FakeFeatureDisabledError);
    expect(mocks.generationFindFirst).not.toHaveBeenCalled();
  });

  it("accepts only server-written key shapes", () => {
    expect(isSafeGeneratedStoragePath("fal/0a1b2c3d-0000-4000-8000-000000000001.jpeg")).toBe(true);
    expect(isSafeGeneratedStoragePath("mock/image/0a1b2c3d.png")).toBe(true);
    expect(isSafeGeneratedStoragePath("fal/a/b/c.png")).toBe(false);
    expect(isSafeGeneratedStoragePath("fal/..png")).toBe(false);
  });
});

describe("signGeneratedImage", () => {
  it("signs only in the fixed private bucket with a short TTL", async () => {
    await expect(signGeneratedImage("fal/x.jpeg")).resolves.toBe(SIGNED);
    expect(mocks.storageFrom).toHaveBeenCalledWith(GENERATED_MEDIA_BUCKET);
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(
      "fal/x.jpeg",
      PREVIEW_SIGNED_URL_TTL_SECONDS,
    );
    expect(PREVIEW_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(60);
  });
  it("refuses to sign an unsafe path and reports signing failures as unavailable", async () => {
    await expect(signGeneratedImage("../x.png")).rejects.toMatchObject({ code: "invalid_path" });
    mocks.createSignedUrl.mockResolvedValue({ data: null, error: { message: "not found" } });
    await expect(signGeneratedImage("fal/x.jpeg")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("GET /api/v1/creator-studio/generations/:id/image", () => {
  const expectNoStore = (res: Response) => {
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  };

  it("redirects an authorized same-tenant viewer to a fresh signed URL, uncacheable", async () => {
    const res = await request(GEN);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED);
    expectNoStore(res);
    expect(mocks.requirePermission).toHaveBeenCalledWith("creator:read");
  });

  it("denies unauthenticated requests without resolving or signing anything", async () => {
    mocks.requirePermission.mockRejectedValue(new FakeAuthError("Not authenticated", 401));
    const res = await request(GEN);
    expect(res.status).toBe(401);
    expectNoStore(res);
    expect(mocks.tenantDb).not.toHaveBeenCalled();
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns 404 without signing for another tenant's or a missing generation", async () => {
    mocks.generationFindFirst.mockResolvedValue(null);
    const res = await request(GEN);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "image_unavailable" } });
    expectNoStore(res);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request("not-a-uuid");
    expect(res.status).toBe(400);
    expectNoStore(res);
  });

  it("is read-only: repeated views re-sign each time and never write or charge", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    for (let i = 0; i < 3; i++) expect((await request(GEN)).status).toBe(302);
    expect(mocks.createSignedUrl).toHaveBeenCalledTimes(3);
    expect(mocks.writes).not.toHaveBeenCalled();
    for (const spy of [log, warn, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET");
    }
  });
});
