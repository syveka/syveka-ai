import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_BUCKETS,
  StoragePurgeError,
  purgeOrganizationStorage,
  type BucketClient,
  type OrganizationBucket,
} from "../../supabase/functions/gdpr-erasure/erasure";
import {
  GRACE_PERIOD_MS,
  eraseOrganization,
  type ErasureDeps,
} from "../../supabase/functions/gdpr-erasure/erasure";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-10T12:00:00.000Z");

/**
 * In-memory Storage that behaves like supabase-js list()/remove() where it
 * matters: list() returns ONE level (folders have id null), sorted by name,
 * paginated by limit/offset; remove() deletes only exact object paths.
 */
function fakeStorage(objects: Record<string, string[]>) {
  const buckets = new Map(Object.entries(objects).map(([b, paths]) => [b, new Set(paths)]));
  const calls: string[] = [];
  const failures: { bucket: string; op: "list" | "remove" }[] = [];
  const client = (bucket: string): BucketClient => ({
    async list(path, { limit, offset }) {
      calls.push(`list:${bucket}:${path}:${offset}`);
      if (failures.some((f) => f.bucket === bucket && f.op === "list")) {
        return { data: null, error: { message: "boom" } };
      }
      const prefix = `${path}/`;
      const children = new Map<string, boolean>();
      for (const p of buckets.get(bucket) ?? []) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        children.set(head!, children.get(head!) === true || tail.length > 0);
      }
      const entries = [...children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, isFolder]) => ({ name, id: isFolder ? null : `id-${name}` }));
      return { data: entries.slice(offset, offset + limit), error: null };
    },
    async remove(paths) {
      calls.push(`remove:${bucket}:${paths.length}`);
      if (failures.some((f) => f.bucket === bucket && f.op === "remove")) {
        return { data: null, error: { message: "boom" } };
      }
      for (const p of paths) buckets.get(bucket)?.delete(p);
      return { data: [], error: null };
    },
  });
  return {
    client: client as (bucket: OrganizationBucket) => BucketClient,
    remaining: (bucket: string) => [...(buckets.get(bucket) ?? [])].sort(),
    calls,
    failures,
  };
}

describe("purgeOrganizationStorage", () => {
  it("removes the organization's nested objects in all five organization buckets", async () => {
    const s = fakeStorage({
      documents: [`${ORG}/u1/handbook.pdf`, `${ORG}/u2/prices.csv`],
      "voice-recordings": [`${ORG}/call-1.mp3`],
      exports: [`${ORG}/2026/10/export.zip`],
      "creator-reference-assets": [`${ORG}/profile-1/u3/face.jpg`],
      "creator-generated-media": [`${ORG}/gen-1/image.png`],
    });

    const removed = await purgeOrganizationStorage(ORG, s.client);

    expect(removed).toEqual({
      documents: 2,
      "voice-recordings": 1,
      exports: 1,
      "creator-reference-assets": 1,
      "creator-generated-media": 1,
    });
    for (const bucket of ORGANIZATION_BUCKETS) expect(s.remaining(bucket)).toEqual([]);
  });

  it("leaves other organizations' objects and the per-user avatars bucket untouched", async () => {
    const s = fakeStorage({
      documents: [`${ORG}/u1/a.pdf`, `${OTHER}/u9/b.pdf`],
      "creator-reference-assets": [`${OTHER}/p/u/face.jpg`],
      avatars: [`${ORG}/avatar.png`],
    });

    await purgeOrganizationStorage(ORG, s.client);

    expect(s.remaining("documents")).toEqual([`${OTHER}/u9/b.pdf`]);
    expect(s.remaining("creator-reference-assets")).toEqual([`${OTHER}/p/u/face.jpg`]);
    expect(s.remaining("avatars")).toEqual([`${ORG}/avatar.png`]);
    expect(s.calls.some((c) => c.includes(":avatars:"))).toBe(false);
  });

  it("follows pagination past one page and removes in batches of at most 100", async () => {
    const files = Array.from(
      { length: 250 },
      (_, i) => `${ORG}/f${String(i).padStart(3, "0")}.pdf`,
    );
    const s = fakeStorage({ documents: files });

    const removed = await purgeOrganizationStorage(ORG, s.client);

    expect(removed.documents).toBe(250);
    expect(s.remaining("documents")).toEqual([]);
    const batches = s.calls.filter((c) => c.startsWith("remove:documents:"));
    expect(batches).toEqual([
      "remove:documents:100",
      "remove:documents:100",
      "remove:documents:50",
    ]);
  });

  it("lists everything in a bucket before removing anything from it", async () => {
    const s = fakeStorage({ documents: [`${ORG}/a/1.pdf`, `${ORG}/b/2.pdf`] });

    await purgeOrganizationStorage(ORG, s.client);

    const docCalls = s.calls.filter((c) => c.includes(":documents:"));
    const firstRemove = docCalls.findIndex((c) => c.startsWith("remove:"));
    expect(docCalls.slice(firstRemove).every((c) => c.startsWith("remove:"))).toBe(true);
  });

  it("throws when a listing fails, removing nothing from that bucket", async () => {
    const s = fakeStorage({ documents: [`${ORG}/a/1.pdf`] });
    s.failures.push({ bucket: "documents", op: "list" });

    await expect(purgeOrganizationStorage(ORG, s.client)).rejects.toBeInstanceOf(StoragePurgeError);
    expect(s.remaining("documents")).toEqual([`${ORG}/a/1.pdf`]);
  });

  it("throws when a removal fails", async () => {
    const s = fakeStorage({ exports: [`${ORG}/x.zip`] });
    s.failures.push({ bucket: "exports", op: "remove" });

    await expect(purgeOrganizationStorage(ORG, s.client)).rejects.toMatchObject({
      bucket: "exports",
      operation: "remove",
    });
  });

  it("refuses an id that isn't a UUID, touching no bucket", async () => {
    const s = fakeStorage({ documents: [`${ORG}/a/1.pdf`] });

    for (const bad of ["", "1111", `${ORG}/..`, "*"]) {
      await expect(purgeOrganizationStorage(bad, s.client)).rejects.toThrow("orgId must be a UUID");
    }
    expect(s.calls).toEqual([]);
  });
});

function deps(
  storage: ReturnType<typeof fakeStorage>,
  overrides: Partial<ErasureDeps> & { deletedAt?: string | null } = {},
) {
  const deleted: string[] = [];
  const d: ErasureDeps = {
    findDeletedAt: async () =>
      overrides.deletedAt === undefined
        ? new Date(NOW - GRACE_PERIOD_MS - 1).toISOString()
        : overrides.deletedAt,
    bucket: storage.client,
    deleteOrganization: async (id) => {
      deleted.push(id);
      return { error: null };
    },
    ...overrides,
  };
  return { d, deleted };
}

describe("eraseOrganization", () => {
  it("purges the files, then deletes the organization", async () => {
    const s = fakeStorage({ documents: [`${ORG}/u1/a.pdf`] });
    const { d, deleted } = deps(s);

    const result = await eraseOrganization(d, ORG, NOW);

    expect(result.status).toBe(200);
    expect(s.remaining("documents")).toEqual([]);
    expect(deleted).toEqual([ORG]);
  });

  it("never deletes the organization when a file can't be removed", async () => {
    const s = fakeStorage({ documents: [`${ORG}/u1/a.pdf`] });
    s.failures.push({ bucket: "documents", op: "remove" });
    const { d, deleted } = deps(s);

    const result = await eraseOrganization(d, ORG, NOW);

    expect(result).toEqual({
      status: 500,
      body: { error: "storage purge failed; organization not deleted" },
    });
    expect(deleted).toEqual([]);
  });

  it("reports a failed database delete instead of claiming success", async () => {
    const s = fakeStorage({});
    const { d } = deps(s, { deleteOrganization: async () => ({ error: { message: "x" } }) });

    expect(await eraseOrganization(d, ORG, NOW)).toEqual({
      status: 500,
      body: { error: "organization delete failed" },
    });
  });

  it("keeps the existing 30-day grace period and touches nothing before it ends", async () => {
    const s = fakeStorage({ documents: [`${ORG}/u1/a.pdf`] });
    const { d, deleted } = deps(s, {
      deletedAt: new Date(NOW - GRACE_PERIOD_MS + 60_000).toISOString(),
    });

    expect(await eraseOrganization(d, ORG, NOW)).toEqual({
      status: 409,
      body: { error: "grace period not over" },
    });
    expect(s.calls).toEqual([]);
    expect(deleted).toEqual([]);
    expect(GRACE_PERIOD_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("refuses an organization that isn't marked for deletion", async () => {
    const s = fakeStorage({ documents: [`${ORG}/u1/a.pdf`] });
    const { d, deleted } = deps(s, { deletedAt: null });

    expect((await eraseOrganization(d, ORG, NOW)).status).toBe(409);
    expect(s.calls).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
