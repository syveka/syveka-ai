import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { INTERNAL_ONLY_WORKFLOWS_FLAG } from "@/lib/workflows/internal-scope";

/**
 * Organization.settings is one JSON object shared by several features (AI
 * instructions, feature flags, operator restrictions). Every app write goes
 * through patchOrganizationSettings: one SQL statement that sets or removes
 * only the named keys on the row's CURRENT value, so two overlapping saves
 * can't drop each other's keys (a read-then-write of the whole object could).
 *
 * Operator-only keys restrict an organization (workflow_steps_internal_only)
 * and are installed and removed only by an explicitly authorized operator
 * operation (owner SQL). No app path may set or remove them.
 *
 * A stored value that isn't a JSON object (never written by the app) is
 * treated as {} and replaced by an object holding only the patch.
 */
export const OPERATOR_ONLY_SETTINGS: readonly string[] = Object.freeze([
  INTERNAL_ONLY_WORKFLOWS_FLAG,
]);

export class ProtectedSettingError extends Error {
  constructor(key: string) {
    super(`Organization setting "${key}" can only be changed by an operator`);
    this.name = "ProtectedSettingError";
  }
}

type RawClient = Pick<typeof unscopedPrisma, "$executeRaw">;
type SettingsPatch = { set?: Record<string, unknown>; remove?: string[] };

function checkedPatch(patch: SettingsPatch): { set: Record<string, unknown>; remove: string[] } {
  const set = patch.set ?? {};
  const remove = patch.remove ?? [];
  for (const key of [...Object.keys(set), ...remove]) {
    if (OPERATOR_ONLY_SETTINGS.includes(key)) throw new ProtectedSettingError(key);
  }
  return { set, remove };
}

/**
 * The organization profile form: its columns and its settings keys in ONE
 * statement (no interactive transaction, so a row lock held by an operator
 * makes the save wait instead of hitting a transaction timeout).
 */
export async function updateOrganizationProfile(
  orgId: string,
  columns: { name: string; businessId: string | null; vatId: string | null },
  patch: SettingsPatch,
  client: RawClient = unscopedPrisma,
): Promise<number> {
  const { set, remove } = checkedPatch(patch);
  return client.$executeRaw`
    update organizations
       set name = ${columns.name},
           business_id = ${columns.businessId},
           vat_id = ${columns.vatId},
           settings = (case when jsonb_typeof(settings) = 'object' then settings else '{}'::jsonb end
                         - ${remove}::text[])
                      || ${JSON.stringify(set)}::jsonb,
           updated_at = now() at time zone 'UTC'
     where id = ${orgId}::uuid`;
}

export async function patchOrganizationSettings(
  orgId: string,
  patch: SettingsPatch,
  client: RawClient = unscopedPrisma,
): Promise<number> {
  const { set, remove } = checkedPatch(patch);
  if (Object.keys(set).length === 0 && remove.length === 0) return 0;
  // updated_at is timestamp(3) without time zone, stored in UTC like Prisma writes it.
  return client.$executeRaw`
    update organizations
       set settings = (case when jsonb_typeof(settings) = 'object' then settings else '{}'::jsonb end
                         - ${remove}::text[])
                      || ${JSON.stringify(set)}::jsonb,
           updated_at = now() at time zone 'UTC'
     where id = ${orgId}::uuid`;
}
