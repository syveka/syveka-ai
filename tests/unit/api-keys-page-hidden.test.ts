import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API keys are not offered to customers until a public API accepts them
 * (resolveApiKey has no callers). The settings page must be not found by
 * direct URL for everyone, and nothing in the app may link to it or wire the
 * create/revoke actions to a route.
 */
const m = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  listApiKeys: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: m.notFound }));
vi.mock("@/server/services/api-keys", () => ({ listApiKeys: m.listApiKeys }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: m.requirePermission }));

import ApiKeysPage from "@/app/[locale]/(app)/settings/api-keys/page";

const root = path.join(__dirname, "../..");
const pageFile = "src/app/[locale]/(app)/settings/api-keys/page.tsx";

beforeEach(() => {
  m.notFound.mockClear();
  m.listApiKeys.mockClear();
  m.requirePermission.mockClear();
});

describe("API keys settings page (unfinished feature)", () => {
  it("is not found by direct URL, and never loads keys", () => {
    expect(() => ApiKeysPage()).toThrow("NEXT_NOT_FOUND");
    expect(m.notFound).toHaveBeenCalledTimes(1);
    expect(m.listApiKeys).not.toHaveBeenCalled();
  });

  it("is not found regardless of role (no permission check reveals it exists)", () => {
    expect(() => ApiKeysPage()).toThrow("NEXT_NOT_FOUND");
    expect(m.requirePermission).not.toHaveBeenCalled();
  });

  it("does not render the key manager, so the create/revoke actions aren't wired to a route", () => {
    const source = fs.readFileSync(path.join(root, pageFile), "utf8");
    expect(source).not.toMatch(/import[^;]*api-keys-manager/);
    expect(source).not.toMatch(/import[^;]*@\/actions\/api-keys/);
    expect(source).not.toMatch(/import[^;]*@\/server\/services\/api-keys/);
  });

  it("nothing in the app links to the page or imports the manager/actions", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--", "src"], { encoding: "utf8" })
      .split("\0")
      .filter((f) => /\.(ts|tsx)$/.test(f));
    const linking = files.filter((f) => {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      // The actions file revalidates its own path; that isn't a link.
      return f !== "src/actions/api-keys.ts" && text.includes("/settings/api-keys");
    });
    const importing = files.filter((f) => {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      return (
        !f.startsWith("src/app/[locale]/(app)/settings/api-keys/") &&
        /from\s+["'](@\/actions\/api-keys|.*api-keys-manager)["']/.test(text)
      );
    });
    expect(linking).toEqual([]);
    expect(importing).toEqual([]);
  });
});
