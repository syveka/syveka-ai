import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiKeysService from "@/server/services/api-keys";

/**
 * createApiKeyAction bounds the scopes it accepts: no more entries than there
 * are scopes, each a short string. An oversized list is refused before any
 * entry is read (GHSA-mrhx-c7xc-m3w5) and never reaches the key service.
 */

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-a", role: "OWNER" })),
  createApiKey: vi.fn(async () => ({ plaintext: "syv_live_test" })),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeysService>()),
  createApiKey: mocks.createApiKey,
}));

import { createApiKeyAction } from "@/actions/api-keys";
import { API_SCOPES } from "@/server/services/api-keys";

beforeEach(() => vi.clearAllMocks());

/** An array that counts reads of its entries. */
function countingArray(values: string[]) {
  const reads = { count: 0 };
  const proxy = new Proxy(values, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads.count++;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { reads, proxy };
}

describe("createApiKeyAction scopes", () => {
  it("accepts every scope at once", async () => {
    const scopes = [...API_SCOPES];
    await expect(createApiKeyAction({ name: "All", scopes })).resolves.toEqual({
      plaintext: "syv_live_test",
    });
    expect(mocks.createApiKey).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a" }), {
      name: "All",
      scopes,
    });
  });

  it("refuses more entries than there are scopes", async () => {
    const scopes = [...API_SCOPES, API_SCOPES[0]];
    await expect(createApiKeyAction({ name: "Too many", scopes })).resolves.toEqual({
      error: "invalid_input",
    });
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("refuses an oversized list without reading any entry", async () => {
    const { reads, proxy } = countingArray(Array(100_000).fill("crm:read"));
    await expect(createApiKeyAction({ name: "Huge", scopes: proxy })).resolves.toEqual({
      error: "invalid_input",
    });
    expect(reads.count).toBe(0);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("refuses an over-long scope string", async () => {
    await expect(createApiKeyAction({ name: "Long", scopes: ["x".repeat(65)] })).resolves.toEqual({
      error: "invalid_input",
    });
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("still requires at least one scope", async () => {
    await expect(createApiKeyAction({ name: "None", scopes: [] })).resolves.toEqual({
      error: "invalid_input",
    });
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("checks the permission before the input", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(createApiKeyAction({ name: "x", scopes: ["crm:read"] })).rejects.toThrow(
      "Forbidden",
    );
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });
});

describe("createApiKeyAction error codes", () => {
  it("a plan without API access → entitlement_exceeded", async () => {
    const { EntitlementError } = await import("@/server/services/billing/entitlements");
    mocks.createApiKey.mockRejectedValueOnce(
      new EntitlementError("apiAccess", "API access requires the PRO plan"),
    );

    await expect(createApiKeyAction({ name: "k", scopes: ["crm:read"] })).resolves.toEqual({
      error: "entitlement_exceeded",
    });
  });

  it("an unexpected failure → failed, without leaking its message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createApiKey.mockRejectedValueOnce(
      Object.assign(new Error("Invalid `prisma.apiKey.create()` invocation"), {
        name: "PrismaClientKnownRequestError",
      }),
    );

    await expect(createApiKeyAction({ name: "k", scopes: ["crm:read"] })).resolves.toEqual({
      error: "failed",
    });
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({
      event: "create_api_key_failed",
      name: "PrismaClientKnownRequestError",
    });
    error.mockRestore();
  });
});
