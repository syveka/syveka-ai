import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async (..._args: unknown[]) => ({
    orgId: "org-1",
    userId: "user-1",
  })),
  limit: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  requestCaptionGeneration: vi.fn(async (..._args: unknown[]) => ({
    generation: { id: "gen-1", status: "COMPLETED" },
    reused: false,
  })),
  handleCreatorStudioError: vi.fn((_e: unknown) =>
    NextResponse.json({ error: { code: "mocked_error" } }, { status: 500 }),
  ),
}));

vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/creator-generations", () => ({
  requestCaptionGeneration: mocks.requestCaptionGeneration,
}));
vi.mock("@/server/services/creator-studio-http", () => ({
  handleCreatorStudioError: mocks.handleCreatorStudioError,
}));
vi.mock("@/server/integrations/redis", () => ({
  rateLimiters: { creatorGenerate: { limit: mocks.limit } },
}));

import { POST } from "@/app/api/v1/creator-studio/generations/caption/route";

function captionRequest(body: unknown) {
  return new Request("http://localhost/api/v1/creator-studio/generations/caption", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { platform: "INSTAGRAM", language: "EN" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ orgId: "org-1", userId: "user-1" });
  mocks.limit.mockResolvedValue({ success: true });
  mocks.requestCaptionGeneration.mockResolvedValue({
    generation: { id: "gen-1", status: "COMPLETED" },
    reused: false,
  });
});

describe("caption generation route", () => {
  it("returns the generation object directly under `data`, never double-wrapped in { generation, reused }", async () => {
    const response = await POST(captionRequest(VALID_BODY));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ data: { id: "gen-1", status: "COMPLETED" } });
  });

  it("requires the creator:generate permission before doing anything else", async () => {
    await POST(captionRequest(VALID_BODY));
    expect(mocks.requirePermission).toHaveBeenCalledWith("creator:generate");
  });

  it("returns 429 and never calls the generation service when rate-limited", async () => {
    mocks.limit.mockResolvedValue({ success: false });
    const response = await POST(captionRequest(VALID_BODY));
    expect(response.status).toBe(429);
    expect(mocks.requestCaptionGeneration).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body without calling the generation service", async () => {
    const response = await POST(captionRequest({ platform: "instagram" })); // missing required language
    expect(response.status).toBe(400);
    expect(mocks.requestCaptionGeneration).not.toHaveBeenCalled();
  });

  it("never calls a real provider path directly — only the mocked service function", async () => {
    await POST(captionRequest(VALID_BODY));
    expect(mocks.requestCaptionGeneration).toHaveBeenCalledTimes(1);
    expect(mocks.requestCaptionGeneration).toHaveBeenCalledWith(
      { orgId: "org-1", userId: "user-1" },
      VALID_BODY,
    );
  });

  it("delegates a thrown domain error to handleCreatorStudioError instead of leaking it raw", async () => {
    mocks.requestCaptionGeneration.mockRejectedValue(new Error("boom"));
    const response = await POST(captionRequest(VALID_BODY));
    expect(mocks.handleCreatorStudioError).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
  });
});
