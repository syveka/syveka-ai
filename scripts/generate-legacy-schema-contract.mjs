import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";

const models = Prisma.dmmf.datamodel.models;
const modelByName = new Map(models.map((model) => [model.name, model]));

const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const columnName = (field) => field.dbName ?? field.name;
const tableName = (model) => model.dbName ?? model.name;

// Tables that may not exist YET on a legacy-upgrade database because the
// migration that creates them runs later in the same `prisma migrate deploy`.
// Every entry is fail-closed against both the current Prisma schema and the
// migration that owns the CREATE TABLE statement. Keep this empty until a real
// legacy-upgrade gap requires an exemption.
//   - business_dna: does not exist on any legacy (pre-migration-system)
//     database; created for the first time by 20260811000000_business_dna_v1,
//     which runs later in the same deploy as this baseline's preflight.
//   - inbox_threads, inbox_messages: same situation, created for the first
//     time by 20260811010000_inbox_mvp_foundation.
const LEGACY_MISSING_TABLE_ENTRIES = [
  ["business_dna", "20260811000000_business_dna_v1"],
  ["inbox_threads", "20260811010000_inbox_mvp_foundation"],
  ["inbox_messages", "20260811010000_inbox_mvp_foundation"],
  ["inbox_mailboxes", "20260812000000_inbox_mailboxes"],
];

const actualTableNames = new Set(models.map(tableName));
const seenMissingTableNames = new Set();
for (const [expectedTable, migrationDir] of LEGACY_MISSING_TABLE_ENTRIES) {
  if (seenMissingTableNames.has(expectedTable)) {
    throw new Error(`Duplicate LEGACY_MISSING_TABLE entry for table "${expectedTable}".`);
  }
  seenMissingTableNames.add(expectedTable);

  if (!actualTableNames.has(expectedTable)) {
    throw new Error(
      `LEGACY_MISSING_TABLE_ENTRIES references "${expectedTable}", which is not a real table ` +
        "in the current Prisma schema.",
    );
  }

  const migrationPath = path.join("prisma/migrations", migrationDir, "migration.sql");
  if (!existsSync(migrationPath)) {
    throw new Error(
      `LEGACY_MISSING_TABLE_ENTRIES references migration "${migrationDir}", which does not ` +
        `exist at ${migrationPath}.`,
    );
  }

  const migrationSql = readFileSync(migrationPath, "utf8");
  const escapedTable = expectedTable.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const createTablePattern = new RegExp(
    `CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?(?:"public"\\.)?"${escapedTable}"(?:\\s|\\()`,
    "i",
  );
  if (!createTablePattern.test(migrationSql)) {
    throw new Error(
      `LEGACY_MISSING_TABLE_ENTRIES references migration "${migrationDir}", whose ` +
        `migration.sql does not create table "${expectedTable}".`,
    );
  }
}

// Prisma's DMMF cannot express PostgreSQL nullability for scalar-list (array) columns:
// Prisma has no optional-list syntax (`Int[]?` / `String[]?` are invalid schema syntax), so
// `field.isRequired` is structurally always `true` for every list field regardless of whether
// the underlying column actually has a NOT NULL constraint. This map is the explicit, verified
// source of truth instead, keyed by "<table>.<column>". Each entry was confirmed against real
// migration history (see the CREATE TABLE statement cited, and confirmed no later migration
// alters that column's nullability):
//   - api_keys.scopes                 -> nullable  (prisma/migrations/20260701000000_initial_baseline/migration.sql:1691, no NOT NULL)
//   - webhook_endpoints.events        -> nullable  (prisma/migrations/20260701000000_initial_baseline/migration.sql:1706, no NOT NULL)
//   - booking_types.duration_options  -> NOT NULL  (prisma/migrations/20260713000000_calendar_booking_v1/migration.sql:237)
//   - calendar_connections.scopes     -> NOT NULL  (prisma/migrations/20260713000000_calendar_booking_v1/migration.sql:104)
//   - business_dna.supported_locales  -> NOT NULL  (prisma/migrations/20260811000000_business_dna_v1/migration.sql:10)
//   - business_dna.key_facts          -> NOT NULL  (prisma/migrations/20260811000000_business_dna_v1/migration.sql:17)
const LIST_COLUMN_NOT_NULL_ENTRIES = [
  ["api_keys.scopes", false],
  ["webhook_endpoints.events", false],
  ["booking_types.duration_options", true],
  ["calendar_connections.scopes", true],
  ["business_dna.supported_locales", true],
  ["business_dna.key_facts", true],
];

const seenListColumnKeys = new Set();
for (const [key] of LIST_COLUMN_NOT_NULL_ENTRIES) {
  if (seenListColumnKeys.has(key)) {
    throw new Error(`Duplicate LIST_COLUMN_NOT_NULL entry for scalar-list column "${key}".`);
  }
  seenListColumnKeys.add(key);
}

const LIST_COLUMN_NOT_NULL = new Map(LIST_COLUMN_NOT_NULL_ENTRIES);

// `columnNotNull()` below looks up any list field regardless of scalar vs.
// enum kind (Postgres enum-array columns need the same explicit NOT NULL
// source of truth as text[]/integer[] ones), so this completeness check must
// cover both — excluding only relation ("object") list fields like Contact[].
const actualScalarListKeys = new Set(
  models.flatMap((model) =>
    model.fields
      .filter((field) => field.isList && field.kind !== "object")
      .map((field) => `${tableName(model)}.${columnName(field)}`),
  ),
);

const missingListColumnKeys = [...actualScalarListKeys].filter(
  (key) => !LIST_COLUMN_NOT_NULL.has(key),
);
if (missingListColumnKeys.length > 0) {
  throw new Error(
    "LIST_COLUMN_NOT_NULL is missing an entry for scalar-list column(s): " +
      missingListColumnKeys.join(", ") +
      ". Determine each column's real PostgreSQL NOT NULL status from migration history " +
      "and add it explicitly to scripts/generate-legacy-schema-contract.mjs.",
  );
}

const staleListColumnKeys = [...LIST_COLUMN_NOT_NULL.keys()].filter(
  (key) => !actualScalarListKeys.has(key),
);
if (staleListColumnKeys.length > 0) {
  throw new Error(
    "LIST_COLUMN_NOT_NULL has stale entry/entries no longer present as a scalar-list field " +
      "in the Prisma schema: " +
      staleListColumnKeys.join(", ") +
      ". Remove the stale entry/entries from scripts/generate-legacy-schema-contract.mjs.",
  );
}

function columnNotNull(model, field) {
  if (!field.isList) return field.isRequired;
  return LIST_COLUMN_NOT_NULL.get(`${tableName(model)}.${columnName(field)}`);
}

// Scalar-list columns whose NOT NULL constraint (recorded as `true` above) could not be
// produced by `prisma db push` against this project's pre-migration-system legacy schema:
// Prisma's db push does not emit NOT NULL for scalar-list columns even when the Prisma field
// is required, unlike the hand-authored migration SQL that later created these same columns
// with an explicit NOT NULL (see scripts/ci/provision-legacy-database.sh, legacy_sha
// 6f6ab84f0f3849a172e0fdfdc49610058640d56c, and
// prisma/migrations/20260713000000_calendar_booking_v1). The pre-upgrade compatibility
// preflight must tolerate this specific, verified historical state without weakening the
// check for any other column; the fully-migrated target state (both NOT NULL, recorded above)
// is enforced for real by prisma/migrations/20260726000000_normalize_list_column_nullability,
// since a legacy database has 20260713000000_calendar_booking_v1 marked as already-applied
// and so never actually runs its DDL.
const LEGACY_NULLABLE_LIST_COLUMNS = [
  "booking_types.duration_options",
  "calendar_connections.scopes",
];

for (const key of LEGACY_NULLABLE_LIST_COLUMNS) {
  if (!LIST_COLUMN_NOT_NULL.has(key)) {
    throw new Error(
      `LEGACY_NULLABLE_LIST_COLUMNS references "${key}", which has no LIST_COLUMN_NOT_NULL entry.`,
    );
  }
  if (LIST_COLUMN_NOT_NULL.get(key) !== true) {
    throw new Error(
      `LEGACY_NULLABLE_LIST_COLUMNS references "${key}", whose target nullability is not NOT ` +
        "NULL (true) — a legacy tolerance is only meaningful for a column whose fully-migrated " +
        "target is NOT NULL.",
    );
  }
}

function postgresType(field) {
  if (field.name === "embedding") return "vector(1536)";
  if (field.isList) {
    if (field.type === "String") return "text[]";
    if (field.type === "Int") return "integer[]";
    if (field.kind === "enum") return `"${field.type}"[]`;
  }
  if (field.kind === "enum") return `"${field.type}"`;
  if (field.nativeType?.[0] === "Uuid") return "uuid";
  if (field.nativeType?.[0] === "Date") return "date";
  if (field.nativeType?.[0] === "Decimal") {
    return `numeric(${field.nativeType[1].join(",")})`;
  }
  return {
    String: "text",
    Int: "integer",
    BigInt: "bigint",
    Float: "double precision",
    Boolean: "boolean",
    DateTime: "timestamp(3) without time zone",
    Json: "jsonb",
    Bytes: "bytea",
    Decimal: "numeric(65,30)",
  }[field.type];
}

function normalizedDefault(field) {
  if (!field.hasDefaultValue) return "";
  const value = field.default;
  if (value?.name === "now") return "current_timestamp";
  if (value?.name === "dbgenerated") {
    return String(value.args[0])
      .toLowerCase()
      .replaceAll(/[\s()]/g, "");
  }
  if (Array.isArray(value)) return `array[${value.join(",").toLowerCase()}]`;
  if (typeof value === "string") return `'${value.toLowerCase()}'`;
  return String(value).toLowerCase();
}

const scalarFields = models.flatMap((model) =>
  model.fields.filter((field) => field.kind !== "object").map((field) => ({ model, field })),
);

// Unsupported fields are intentionally absent from Prisma's generated DMMF.
scalarFields.push({
  model: modelByName.get("DocumentChunk"),
  field: {
    name: "embedding",
    kind: "unsupported",
    type: "Unsupported",
    isRequired: false,
    isList: false,
    hasDefaultValue: false,
  },
});

// Columns that may not exist YET on a legacy-upgrade database when this preflight
// check runs, because their governing migration is intentionally NOT in the
// "already resolved" published-migrations list (scripts/ci/provision-legacy-database.sh)
// — it runs for real, later in the very same `prisma migrate deploy` invocation, not
// before it. Unlike LEGACY_NULLABLE_LIST_COLUMNS (an existing column with a
// temporarily-wrong attribute), these columns may be entirely absent at check time.
// Each entry is verified below against the exact migration that adds it, so this can
// never silently mask a column that was never actually added by anything. This list
// must never grow speculatively — one entry per case actually shipped, added only
// when the same before/after situation genuinely recurs.
//   - calendar_sync_states.webhook_verification_secret_hash: the pinned legacy
//     snapshot (6f6ab84f0f3849a172e0fdfdc49610058640d56c) predates this column;
//     20260728000000_calendar_webhook_verification_secret (not a published/resolved
//     migration) adds it for real later in the same deploy; after that migration
//     completes, the database must have the correctly shaped column like any other.
const LEGACY_MISSING_COLUMN_ENTRIES = [
  [
    "calendar_sync_states.webhook_verification_secret_hash",
    "20260728000000_calendar_webhook_verification_secret",
  ],
];

const seenMissingColumnKeys = new Set();
for (const [key] of LEGACY_MISSING_COLUMN_ENTRIES) {
  if (seenMissingColumnKeys.has(key)) {
    throw new Error(`Duplicate LEGACY_MISSING_COLUMN entry for column "${key}".`);
  }
  seenMissingColumnKeys.add(key);
}

// Reusing scalarFields (rather than filtering separately) is what guarantees this
// column can never be silently removed from the complete target column contract
// below: an entry can only validate against a key that columnRows will also emit.
const actualScalarColumnKeys = new Set(
  scalarFields.map(({ model, field }) => `${tableName(model)}.${columnName(field)}`),
);

for (const [key, migrationDir] of LEGACY_MISSING_COLUMN_ENTRIES) {
  if (!actualScalarColumnKeys.has(key)) {
    throw new Error(
      `LEGACY_MISSING_COLUMN_ENTRIES references "${key}", which is not a real scalar column ` +
        "in the current Prisma schema.",
    );
  }
  const migrationPath = path.join("prisma/migrations", migrationDir, "migration.sql");
  if (!existsSync(migrationPath)) {
    throw new Error(
      `LEGACY_MISSING_COLUMN_ENTRIES references migration "${migrationDir}", which does not ` +
        `exist at ${migrationPath}.`,
    );
  }
  const [expectedTable, expectedColumn] = key.split(".");
  const migrationSql = readFileSync(migrationPath, "utf8");
  const addColumnPattern = new RegExp(
    `ALTER TABLE\\s+"${expectedTable}"\\s+ADD COLUMN\\s+"${expectedColumn}"`,
    "i",
  );
  if (!addColumnPattern.test(migrationSql)) {
    throw new Error(
      `LEGACY_MISSING_COLUMN_ENTRIES references migration "${migrationDir}", whose migration.sql ` +
        `does not add column "${expectedColumn}" to table "${expectedTable}".`,
    );
  }
}

const columnRows = scalarFields
  .sort((left, right) => {
    const tableOrder = tableName(left.model).localeCompare(tableName(right.model));
    return tableOrder || columnName(left.field).localeCompare(columnName(right.field));
  })
  .map(
    ({ model, field }) =>
      `      (${[
        tableName(model),
        columnName(field),
        postgresType(field),
        columnNotNull(model, field),
        "",
        "",
        normalizedDefault(field),
      ]
        .map(sqlString)
        .join(", ")})`,
  );

const fkRows = [];
const fkByConstraint = new Map();
for (const model of models) {
  for (const relation of model.fields.filter(
    (field) => field.kind === "object" && field.relationFromFields?.length,
  )) {
    const target = modelByName.get(relation.type);
    const sourceColumns = relation.relationFromFields.map((name) =>
      columnName(model.fields.find((field) => field.name === name)),
    );
    const targetColumns = relation.relationToFields.map((name) =>
      columnName(target.fields.find((field) => field.name === name)),
    );
    const constraint = `${tableName(model)}_${sourceColumns.join("_")}_fkey`;
    const deleteAction =
      relation.relationOnDelete ?? (relation.isRequired ? "Restrict" : "SetNull");
    const updateAction = "Cascade";
    fkByConstraint.set(constraint, { deleteAction, updateAction });
    fkRows.push(
      `      (${[
        "public",
        tableName(model),
        constraint,
        `{${sourceColumns.join(",")}}`,
        "public",
        tableName(target),
        `{${targetColumns.join(",")}}`,
        deleteAction,
        updateAction,
        false,
        false,
        true,
      ]
        .map(sqlString)
        .join(", ")})`,
    );
  }
}

// Foreign keys whose ON UPDATE action may still show a specific, verified
// pre-correction legacy value on a database whose governing migration has not yet
// been successfully applied (per public._prisma_migrations -- see the preflight SQL
// for the exact applied-state query). The tolerance is state-gated, not
// unconditional: once the named migration is recorded as successfully applied, the
// exact same legacy value is a real regression and must fail closed again, not
// silently pass forever. Only the single named attribute below may legacy-differ for
// the one named constraint, and only pre-migration; every other attribute (columns,
// referenced table, delete action, deferrability, validation) -- and every other
// constraint's update action -- must still match the final contract exactly, so a
// present-but-differently-malformed constraint, or drift on any other constraint,
// still fails closed. This list must never grow speculatively -- one entry per case
// actually shipped, added only when the same before/after situation genuinely
// recurs.
//   - conversation_documents_organization_id_fkey: created by
//     20260715000000_ai_chat_production_hardening with no ON UPDATE clause (Postgres
//     default NO ACTION). 20260715230000_security_invariant_corrections upgraded this
//     table's other two foreign keys (conversation_id, document_id) to composite keys
//     with ON UPDATE CASCADE but intentionally left this one alone,
//     20260729000000_conversation_documents_organization_fk_on_update (not a
//     published/resolved migration) drops and re-adds it with ON UPDATE CASCADE for
//     real, later in the same deploy.
const LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES = [
  [
    "conversation_documents_organization_id_fkey",
    "NoAction",
    "20260729000000_conversation_documents_organization_fk_on_update",
  ],
];

const seenFkOverrideConstraints = new Set();
for (const [
  constraintName,
  legacyUpdateAction,
  migrationDir,
] of LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES) {
  if (seenFkOverrideConstraints.has(constraintName)) {
    throw new Error(
      `Duplicate LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES entry for constraint "${constraintName}".`,
    );
  }
  seenFkOverrideConstraints.add(constraintName);

  if (
    constraintName.includes("=") ||
    legacyUpdateAction.includes("=") ||
    migrationDir.includes("=")
  ) {
    throw new Error(
      `LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES entry for constraint "${constraintName}" ` +
        'contains a literal "=", which would corrupt the ' +
        '"constraint_name=legacy_update_action=governing_migration" SQL encoding.',
    );
  }

  const fk = fkByConstraint.get(constraintName);
  if (!fk) {
    throw new Error(
      `LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES references constraint "${constraintName}", ` +
        "which is not a real foreign key in the current Prisma schema.",
    );
  }
  if (legacyUpdateAction === fk.updateAction) {
    throw new Error(
      `LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES references constraint "${constraintName}" ` +
        `with legacy update action "${legacyUpdateAction}", which matches its final target ` +
        "update action -- a legacy tolerance is only meaningful when it differs from the " +
        "final target.",
    );
  }
  const migrationPath = path.join("prisma/migrations", migrationDir, "migration.sql");
  if (!existsSync(migrationPath)) {
    throw new Error(
      `LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES references migration "${migrationDir}", ` +
        `which does not exist at ${migrationPath}.`,
    );
  }
  const migrationSql = readFileSync(migrationPath, "utf8");
  const dropPattern = new RegExp(`DROP CONSTRAINT\\s+"${constraintName}"`, "i");
  const addPattern = new RegExp(
    `ADD CONSTRAINT\\s+"${constraintName}"[\\s\\S]*?ON UPDATE ${fk.updateAction === "Cascade" ? "CASCADE" : fk.updateAction.toUpperCase()}`,
    "i",
  );
  if (!dropPattern.test(migrationSql) || !addPattern.test(migrationSql)) {
    throw new Error(
      `LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES references migration "${migrationDir}", whose ` +
        `migration.sql does not drop and re-add constraint "${constraintName}" with the final ` +
        "target update action.",
    );
  }
}

console.log("-- BEGIN COMPLETE COLUMN CONTRACT");
console.log(columnRows.join(",\n"));
console.log("-- END COMPLETE COLUMN CONTRACT");
console.log("-- BEGIN LEGACY NULLABLE LIST COLUMNS");
console.log(LEGACY_NULLABLE_LIST_COLUMNS.map((key) => `    ${sqlString(key)}`).join(",\n"));
console.log("-- END LEGACY NULLABLE LIST COLUMNS");
console.log("-- BEGIN LEGACY MISSING COLUMNS");
console.log(LEGACY_MISSING_COLUMN_ENTRIES.map(([key]) => `    ${sqlString(key)}`).join(",\n"));
console.log("-- END LEGACY MISSING COLUMNS");
console.log("-- BEGIN LEGACY MISSING TABLES");
if (LEGACY_MISSING_TABLE_ENTRIES.length === 0) {
  console.log("  legacy_missing_tables TEXT[] := '{}'::TEXT[];");
} else {
  console.log("  legacy_missing_tables TEXT[] := ARRAY[");
  console.log(LEGACY_MISSING_TABLE_ENTRIES.map(([table]) => `    ${sqlString(table)}`).join(",\n"));
  console.log("  ];");
}
console.log("-- END LEGACY MISSING TABLES");
console.log("-- BEGIN COMPLETE FOREIGN KEY CONTRACT");
console.log(fkRows.join(",\n"));
console.log("-- END COMPLETE FOREIGN KEY CONTRACT");
console.log("-- BEGIN LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES");
console.log(
  LEGACY_FOREIGN_KEY_UPDATE_ACTION_OVERRIDES.map(
    ([constraintName, legacyUpdateAction, migrationDir]) =>
      `    ${sqlString(`${constraintName}=${legacyUpdateAction}=${migrationDir}`)}`,
  ).join(",\n"),
);
console.log("-- END LEGACY FOREIGN KEY UPDATE ACTION OVERRIDES");

const policies = [];
const addPolicy = (table, name, command, using = "", check = "") => {
  policies.push(["public", table, name, "PERMISSIVE", command, "{authenticated}", using, check]);
};

for (const table of [
  "teams",
  "companies",
  "contacts",
  "pipelines",
  "deals",
  "activities",
  "tags",
  "calendar_events",
  "conversations",
  "documents",
  "collections",
  "workflows",
  "voice_assistants",
  "webhook_endpoints",
  "business_dna",
]) {
  addPolicy(table, `${table}_select`, "SELECT", "organization_id=auth_org_id");
  addPolicy(table, `${table}_insert`, "INSERT", "", "organization_id=auth_org_id");
  addPolicy(table, `${table}_update`, "UPDATE", "organization_id=auth_org_id");
  addPolicy(
    table,
    `${table}_delete`,
    "DELETE",
    "organization_id=auth_org_idandauth_role=anyarray['owner','admin','manager']",
  );
}
for (const table of [
  "subscriptions",
  "usage_records",
  "voice_calls",
  "workflow_runs",
  "invitations",
  "api_keys",
  "conversation_documents",
]) {
  addPolicy(table, `${table}_select`, "SELECT", "organization_id=auth_org_id");
}
addPolicy("users", "users_self_select", "SELECT", "id=uid");
addPolicy("users", "users_self_update", "UPDATE", "id=uid");
addPolicy("organizations", "org_member_select", "SELECT", "id=auth_org_id");
addPolicy("organization_members", "members_select", "SELECT", "organization_id=auth_org_id");
addPolicy(
  "messages",
  "messages_select",
  "SELECT",
  "existsselect1fromconversationswhereid=conversation_idandorganization_id=auth_org_id",
);
addPolicy("document_chunks", "chunks_select", "SELECT", "organization_id=auth_org_id");
addPolicy(
  "pipeline_stages",
  "stages_select",
  "SELECT",
  "existsselect1frompipelineswhereid=pipeline_idandorganization_id=auth_org_id",
);
addPolicy(
  "tags_on_contacts",
  "contact_tags_select",
  "SELECT",
  "existsselect1fromcontactswhereid=contact_idandorganization_id=auth_org_id",
);
addPolicy(
  "prompts",
  "prompts_select",
  "SELECT",
  "organization_idisnullororganization_id=auth_org_id",
);
addPolicy("prompts", "prompts_insert", "INSERT", "", "organization_id=auth_org_id");
addPolicy("prompts", "prompts_update", "UPDATE", "organization_id=auth_org_id");
addPolicy(
  "prompts",
  "prompts_delete",
  "DELETE",
  "organization_id=auth_org_idandauth_role=anyarray['owner','admin','manager']",
);
addPolicy(
  "notifications",
  "notifications_select",
  "SELECT",
  "user_id=uidandorganization_id=auth_org_id",
);
addPolicy("notifications", "notifications_update", "UPDATE", "user_id=uid");
addPolicy(
  "audit_logs",
  "audit_select",
  "SELECT",
  "organization_id=auth_org_idandauth_role=anyarray['owner','admin']",
);
for (const table of ["external_calendars", "availability_schedules", "booking_types", "bookings"]) {
  addPolicy(table, `${table}_select`, "SELECT", "organization_id=auth_org_id");
}
addPolicy(
  "event_attendees",
  "event_attendees_select",
  "SELECT",
  "existsselect1fromcalendar_eventswhereid=event_idandorganization_id=auth_org_id",
);
addPolicy(
  "availability_rules",
  "availability_rules_select",
  "SELECT",
  "existsselect1fromavailability_scheduleswhereid=schedule_idandorganization_id=auth_org_id",
);
addPolicy(
  "availability_overrides",
  "availability_overrides_select",
  "SELECT",
  "existsselect1fromavailability_scheduleswhereid=schedule_idandorganization_id=auth_org_id",
);
addPolicy(
  "conversation_documents",
  "conversation_documents_tenant_isolation",
  "SELECT",
  "organization_id=auth_org_id",
);

console.log("-- BEGIN COMPLETE RLS POLICY CONTRACT");
console.log(
  policies
    .sort((left, right) => left.slice(0, 3).join(".").localeCompare(right.slice(0, 3).join(".")))
    .map((row) => `      (${row.map(sqlString).join(", ")})`)
    .join(",\n"),
);
console.log("-- END COMPLETE RLS POLICY CONTRACT");
