import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wires the REAL getTenantContextOrNull() (src/server/auth/session.ts) into
 * the two pages that treat its null result as "show Create your
 * organization": (app)/layout.tsx and (onboarding)/onboarding/page.tsx.
 * Only the Supabase Auth client and Prisma are mocked, so a regression that
 * converts a DB failure back into null is caught at the page level, not just
 * at the helper.
 */

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/server/db/prisma", () => ({
  prisma: {
    organizationMember: { findFirst: mocks.findFirst, count: mocks.count },
    organization: { findUniqueOrThrow: mocks.findUniqueOrThrow },
  },
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: { organization: { findUniqueOrThrow: mocks.findUniqueOrThrow } },
}));

vi.mock("@/server/services/notifications", () => ({ unreadCount: vi.fn(async () => 0) }));
vi.mock("@/components/layout/app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/components/layout/topbar", () => ({ Topbar: () => null }));
vi.mock("@/app/[locale]/(onboarding)/onboarding/onboarding-form", () => ({
  OnboardingForm: () => null,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function authenticatedUser() {
  mocks.getUser.mockResolvedValue({
    data: { user: { id: USER_ID, email: "member@example.test", app_metadata: {} } },
    error: null,
  });
}

function dbConnectionError() {
  return Object.assign(new Error("Can't reach database server"), {
    name: "PrismaClientInitializationError",
  });
}

async function loadPages() {
  const { default: AppLayout } = await import("@/app/[locale]/(app)/layout");
  const { default: OnboardingPage } = await import("@/app/[locale]/(onboarding)/onboarding/page");
  return {
    renderLayout: () => AppLayout({ children: null }),
    renderOnboarding: () => OnboardingPage({ params: Promise.resolve({ locale: "en" }) }),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.count.mockResolvedValue(0);
  mocks.findUniqueOrThrow.mockResolvedValue({ name: "Acme Oy" });
});

describe("existing member", () => {
  beforeEach(() => {
    authenticatedUser();
    mocks.findFirst.mockResolvedValue({
      organizationId: ORG_ID,
      role: "OWNER",
      organization: { defaultLocale: "FI", deletedAt: null },
    });
  });

  it("renders the app layout without redirecting to onboarding", async () => {
    const { renderLayout } = await loadPages();
    await expect(renderLayout()).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("is sent from onboarding to the dashboard", async () => {
    const { renderOnboarding } = await loadPages();
    await expect(renderOnboarding()).rejects.toThrow("NEXT_REDIRECT:/en/dashboard");
  });
});

describe("authenticated user with no usable membership", () => {
  beforeEach(() => {
    authenticatedUser();
    mocks.findFirst.mockResolvedValue(null);
  });

  it("is redirected from the app layout to onboarding", async () => {
    const { renderLayout } = await loadPages();
    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });

  it("sees the organization-creation page", async () => {
    const { renderOnboarding } = await loadPages();
    await expect(renderOnboarding()).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("unauthenticated visitor", () => {
  beforeEach(() => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  it("is sent from onboarding to login, never shown organization creation", async () => {
    const { renderOnboarding } = await loadPages();
    await expect(renderOnboarding()).rejects.toThrow("NEXT_REDIRECT:/en/login");
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
});

describe("tenant lookup fails with a database error", () => {
  beforeEach(() => {
    authenticatedUser();
    mocks.findFirst.mockRejectedValue(dbConnectionError());
  });

  it("fails the app layout instead of redirecting to onboarding", async () => {
    const { renderLayout } = await loadPages();
    await expect(renderLayout()).rejects.toMatchObject({ name: "PrismaClientInitializationError" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("fails the onboarding page instead of rendering organization creation", async () => {
    const { renderOnboarding } = await loadPages();
    await expect(renderOnboarding()).rejects.toMatchObject({
      name: "PrismaClientInitializationError",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("also fails when the no-membership diagnostic recount itself errors", async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockRejectedValue(dbConnectionError());

    const { renderOnboarding } = await loadPages();
    await expect(renderOnboarding()).rejects.toMatchObject({
      name: "PrismaClientInitializationError",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
