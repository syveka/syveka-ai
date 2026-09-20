import "server-only";

import { PrismaClient } from "@/generated/prisma/client/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  ensurePgbouncerCompatibility,
  sanitizeConnectionString,
} from "./connection-string-sanitizer";

/**
 * Raw Prisma client on the SERVICE-ROLE connection (bypasses RLS).
 * ⚠ Only importable inside src/server/db (ESLint boundary, §4.3).
 * All business code uses tenantDb() from ./tenant.
 *
 * The connection URL itself is read by Prisma directly from
 * `process.env.DATABASE_URL` (see `datasource db` in schema.prisma) — this
 * module never routes through `@/env`'s full schema validation, so an
 * unrelated missing var (Stripe, Vapi, ...) elsewhere in that schema can't
 * make DB connectivity checks fail for the wrong reason. `sanitizeConnectionString`
 * strips whitespace/CR-LF/a trailing bare `?` that a dashboard paste can
 * introduce and that Prisma's stricter parser (unlike a lenient WHATWG URL
 * parse) rejects outright.
 *
 * Uses the @prisma/adapter-pg driver adapter (Prisma + Supabase's own
 * current official guidance for Supavisor transaction-mode pooling on a
 * serverless runtime), not the classic engine's own `datasourceUrl`
 * option. `ensurePgbouncerCompatibility`'s `pgbouncer=true`/
 * `connection_limit=1` query-string params are specific to Prisma's
 * classic Rust query engine -- confirmed empirically (pg-connection-string
 * parses them through as harmless unused keys; `pg.Pool`/`pg.PoolConfig`
 * never reads a `pgbouncer` or `connection_limit` field) they have no
 * effect on `pg`/PrismaPg. Left in place anyway (harmless) so the exact
 * connection string handed to the pool is unchanged in shape, and because
 * `sanitizeConnectionString` alone is still load-bearing (a raw
 * dashboard-pasted value's stray newline/trailing `?` would break `pg`'s
 * own connection-string parser too). Actual connection sizing for the
 * pool is `pg`'s own native `max` option (PrismaPgOptions has no
 * connection-count field of its own — confirmed against the installed
 * @prisma/adapter-pg 6.19.3 type declarations).
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function resolveDatasourceUrl(): string | undefined {
  if (!process.env.DATABASE_URL) return undefined;
  return ensurePgbouncerCompatibility(sanitizeConnectionString(process.env.DATABASE_URL));
}

function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const adapter = new PrismaPg({ connectionString: resolveDatasourceUrl(), max: 1 });
    globalForPrisma.prisma = new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }

  return globalForPrisma.prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop: keyof PrismaClient) {
    const client = getPrisma();
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});
