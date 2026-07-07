import "server-only";

import { PrismaClient } from "@prisma/client";
import { env } from "@/env";

/**
 * Raw Prisma client on the SERVICE-ROLE connection (bypasses RLS).
 * ⚠ Only importable inside src/server/db (ESLint boundary, §4.3).
 * All business code uses tenantDb() from ./tenant.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
