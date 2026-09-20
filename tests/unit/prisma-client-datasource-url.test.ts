import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PrismaClientMock = vi.fn();
const PrismaPgMock = vi.fn();

vi.mock("@/generated/prisma/client/client", () => ({
  PrismaClient: PrismaClientMock,
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: PrismaPgMock,
}));

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe("getPrisma() driver adapter construction", () => {
  beforeEach(() => {
    vi.resetModules();
    PrismaClientMock.mockClear();
    PrismaPgMock.mockClear();
    delete (globalThis as unknown as { prisma?: unknown }).prisma;
  });

  afterEach(() => {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it("constructs PrismaPg with a sanitized connectionString, stripping a trailing newline and stray '?', and a serverless-safe pool size", async () => {
    process.env.DATABASE_URL =
      "postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1\n?";

    const { prisma } = await import("@/server/db/prisma");
    void prisma.$queryRaw;

    expect(PrismaPgMock).toHaveBeenCalledTimes(1);
    const poolConfig = PrismaPgMock.mock.calls[0]?.[0] as {
      connectionString?: string;
      max?: number;
    };
    expect(poolConfig.connectionString).toBe(
      "postgresql://postgres.abc:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1",
    );
    // pg's own native pool-size option -- ensurePgbouncerCompatibility's
    // connection_limit=1 query param has no effect on pg/PrismaPg (see
    // prisma.ts's own comment); this is the one that actually matters for
    // a serverless deployment sharing one warm container's connection.
    expect(poolConfig.max).toBe(1);
  });

  it("passes the constructed PrismaPg adapter (not a raw connection string) to PrismaClient", async () => {
    process.env.DATABASE_URL = "postgresql://postgres.abc:pw@example.supabase.co:6543/postgres";
    const adapterInstance = { marker: "prisma-pg-adapter-instance" };
    PrismaPgMock.mockReturnValue(adapterInstance);

    const { prisma } = await import("@/server/db/prisma");
    void prisma.$queryRaw;

    expect(PrismaClientMock).toHaveBeenCalledTimes(1);
    const options = PrismaClientMock.mock.calls[0]?.[0] as {
      adapter?: unknown;
      datasourceUrl?: unknown;
    };
    expect(options.adapter).toBe(adapterInstance);
    // The classic engine's datasourceUrl option must not also be set --
    // the adapter is the only source of the connection now.
    expect(options.datasourceUrl).toBeUndefined();
  });

  it("constructs PrismaPg with connectionString undefined (not the literal string 'undefined') when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;

    const { prisma } = await import("@/server/db/prisma");
    void prisma.$queryRaw;

    const poolConfig = PrismaPgMock.mock.calls[0]?.[0] as { connectionString?: string };
    expect(poolConfig.connectionString).toBeUndefined();
  });

  it("constructs PrismaPg and PrismaClient exactly once across repeated access (singleton preserved)", async () => {
    process.env.DATABASE_URL = "postgresql://postgres.abc:pw@example.supabase.co:6543/postgres";

    const { prisma } = await import("@/server/db/prisma");
    void prisma.$queryRaw;
    void prisma.$disconnect;
    void prisma.$transaction;

    expect(PrismaPgMock).toHaveBeenCalledTimes(1);
    expect(PrismaClientMock).toHaveBeenCalledTimes(1);
  });
});
