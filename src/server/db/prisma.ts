import "server-only";

import { PrismaClient } from "@prisma/client";

/**
 * Raw Prisma client on the SERVICE-ROLE connection (bypasses RLS).
 * ⚠ Only importable inside src/server/db (ESLint boundary, §4.3).
 * All business code uses tenantDb() from ./tenant.
 *
 * The connection URL itself is read by Prisma directly from
 * `process.env.DATABASE_URL` (see `datasource db` in schema.prisma) — this
 * module never routes through `@/env`'s full schema validation, so an
 * unrelated missing var (Stripe, Vapi, ...) elsewhere in that schema can't
 * make DB connectivity checks fail for the wrong reason.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function getPrisma(): PrismaClient {
  globalForPrisma.prisma ??= new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  return globalForPrisma.prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop: keyof PrismaClient) {
    const client = getPrisma();
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});
