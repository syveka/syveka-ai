/**
 * GDPR erasure of an organization: the decision logic of the gdpr-erasure
 * Edge Function (index.ts wires it to Supabase). Plain TypeScript with no
 * imports, so the Deno function and the Vitest suite
 * (tests/unit/gdpr-erasure.test.ts) run exactly this code. The 30-day grace
 * period is the existing behavior (§13.3), unchanged here.
 */

/**
 * Storage purge: removes every Storage object an organization owns.
 *
 * The five private buckets' Storage policies (prisma/sql/004_storage.sql)
 * require an object's first folder to be the organization id, so the
 * organization owns exactly the objects under `<orgId>/` in each of them.
 * Objects are nested deeper (documents: `<orgId>/<uuid>/<file>`, creator
 * reference assets: `<orgId>/<profileId>/<uuid>/<file>`), and `list()`
 * returns one level at a time: entries with `id === null` are folders.
 * `avatars` is per user (first folder = the user's id), not per
 * organization, so it is not purged here.
 *
 * Every listing and removal error throws: the caller must not delete the
 * organization's database rows unless all of its files are gone, or the
 * files would remain with nothing left that links them to anyone.
 */

export const ORGANIZATION_BUCKETS = [
  "documents",
  "voice-recordings",
  "exports",
  "creator-reference-assets",
  "creator-generated-media",
] as const;

export type OrganizationBucket = (typeof ORGANIZATION_BUCKETS)[number];

type StorageError = { message: string } | null;

/** The subset of a Supabase Storage bucket client this module uses. */
export interface BucketClient {
  list(
    path: string,
    options: { limit: number; offset: number },
  ): Promise<{ data: Array<{ name: string; id: string | null }> | null; error: StorageError }>;
  remove(paths: string[]): Promise<{ data: unknown; error: StorageError }>;
}

export class StoragePurgeError extends Error {
  constructor(
    readonly bucket: string,
    readonly operation: "list" | "remove",
  ) {
    super(`Storage ${operation} failed in bucket ${bucket}`);
    this.name = "StoragePurgeError";
  }
}

const PAGE_SIZE = 100;
const REMOVE_BATCH = 100;
const MAX_DEPTH = 8;

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every object path under `prefix`, following folders (paginated). */
async function listObjects(
  bucket: string,
  client: BucketClient,
  prefix: string,
  depth: number,
): Promise<string[]> {
  if (depth > MAX_DEPTH) throw new StoragePurgeError(bucket, "list");
  const paths: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.list(prefix, { limit: PAGE_SIZE, offset });
    if (error || !data) throw new StoragePurgeError(bucket, "list");
    for (const entry of data) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id === null) {
        paths.push(...(await listObjects(bucket, client, path, depth + 1)));
      } else {
        paths.push(path);
      }
    }
    if (data.length < PAGE_SIZE) return paths;
  }
}

/**
 * Removes all of the organization's objects from every organization bucket.
 * Lists everything before removing anything, so pagination isn't disturbed
 * by deletions. Returns how many objects were removed per bucket.
 */
export async function purgeOrganizationStorage(
  orgId: string,
  bucketClient: (bucket: OrganizationBucket) => BucketClient,
): Promise<Record<OrganizationBucket, number>> {
  // A malformed id could be a prefix of other organizations' folders.
  if (!ORG_ID.test(orgId)) throw new Error("orgId must be a UUID");
  const removed = {} as Record<OrganizationBucket, number>;
  for (const bucket of ORGANIZATION_BUCKETS) {
    const client = bucketClient(bucket);
    const paths = await listObjects(bucket, client, orgId, 1);
    for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
      const { error } = await client.remove(paths.slice(i, i + REMOVE_BATCH));
      if (error) throw new StoragePurgeError(bucket, "remove");
    }
    removed[bucket] = paths.length;
  }
  return removed;
}

export const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export interface ErasureDeps {
  /** The organization's soft-delete time, or null when it isn't soft-deleted or doesn't exist. */
  findDeletedAt(orgId: string): Promise<string | null>;
  bucket(name: OrganizationBucket): BucketClient;
  /** Hard-deletes the organization row (tenant rows cascade). */
  deleteOrganization(orgId: string): Promise<{ error: { message: string } | null }>;
}

export type ErasureResult =
  | { status: 200; body: { ok: true; purged: string; removed: Record<OrganizationBucket, number> } }
  | { status: 409 | 500; body: { error: string } };

export async function eraseOrganization(
  deps: ErasureDeps,
  orgId: string,
  now: number = Date.now(),
): Promise<ErasureResult> {
  const deletedAt = await deps.findDeletedAt(orgId);
  if (!deletedAt) return { status: 409, body: { error: "org not marked for deletion" } };
  if (now - new Date(deletedAt).getTime() < GRACE_PERIOD_MS) {
    return { status: 409, body: { error: "grace period not over" } };
  }

  // Every file first. If any can't be listed or removed, stop before the
  // database delete: deleting the rows first would leave files with nothing
  // that links them to an organization. A later run retries.
  let removed: Record<OrganizationBucket, number>;
  try {
    removed = await purgeOrganizationStorage(orgId, deps.bucket);
  } catch {
    return { status: 500, body: { error: "storage purge failed; organization not deleted" } };
  }

  const { error } = await deps.deleteOrganization(orgId);
  if (error) return { status: 500, body: { error: "organization delete failed" } };
  return { status: 200, body: { ok: true, purged: orgId, removed } };
}
