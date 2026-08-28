import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PrismaClientMock = vi.fn();

vi.mock("@prisma/client", () => ({
  PrismaClient: PrismaClientMock,
}));

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe("getPrisma() datasourceUrl sanitization", () => {
  beforeEach(() => {
    vi.resetModules();
    PrismaClientMock.mockClear();
    delete (globalThis as unknown as { prisma?: unknown }).prisma;
  });

  afterEach(() => {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it("passes a sanitized DATABASE_URL as datasourceUrl, stripping a trailing newline and stray '?'", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1\n?";

    const { prisma } = await import("@/server/db/prisma");
    void prisma.$queryRaw;

    expect(PrismaClientMock).toHaveBeenCalledTimes(1);
    const options = PrismaClientMock.mock.calls[0]?.[0] as { datasourceUrl?: string };
    expect(options.datasourceUrl).toBe(
      "postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1",
    );
  });

  it("passes undefined when DATABASE_URL is not set, rather than the literal string 'undefined'", async () => {
    delete process.env.DATABASE_URL;

    const { prisma } = await import("@/server/db/prisma");
    void prisma.$queryRaw;

    const options = PrismaClientMock.mock.calls[0]?.[0] as { datasourceUrl?: string };
    expect(options.datasourceUrl).toBeUndefined();
  });
});
