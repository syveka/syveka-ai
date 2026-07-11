import "server-only";

import { PrismaClient } from "@prisma/client";
import { env } from "@/env";

/**
 * Raw Prisma client on the SERVICE-ROLE connection (bypasses RLS).
 * ⚠ Only importable inside src/server/db (ESLint boundary, §4.3).
 * All business code uses tenantDb() from ./tenant.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function getPrisma(): PrismaClient {
  globalForPrisma.prisma ??= new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
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
