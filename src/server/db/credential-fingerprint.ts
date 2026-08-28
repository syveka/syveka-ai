import { createHash } from "node:crypto";

/**
 * TEMPORARY staging-only diagnostic (2026-08-28) for proving whether
 * DATABASE_URL's password matches a separately-known-working credential,
 * without ever exposing either secret. A SHA-256 digest is one-way — it
 * lets two parties compare "are these the same string?" by comparing only
 * non-reversible digests. Remove once the credential investigation is
 * concluded.
 */
export function passwordFingerprint(connectionString: string): string {
  const url = new URL(connectionString);
  return createHash("sha256").update(url.password).digest("hex");
}
