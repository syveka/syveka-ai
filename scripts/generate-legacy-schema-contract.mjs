import { Prisma } from "@prisma/client";

const models = Prisma.dmmf.datamodel.models;
const modelByName = new Map(models.map((model) => [model.name, model]));

const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const columnName = (field) => field.dbName ?? field.name;
const tableName = (model) => model.dbName ?? model.name;

function postgresType(field) {
  if (field.name === "embedding") return "vector(1536)";
  if (field.isList) {
    if (field.type === "String") return "text[]";
    if (field.type === "Int") return "integer[]";
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
        field.isRequired,
        "",
        "",
        normalizedDefault(field),
      ]
        .map(sqlString)
        .join(", ")})`,
  );

const fkRows = [];
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
        "Cascade",
        false,
        false,
        true,
      ]
        .map(sqlString)
        .join(", ")})`,
    );
  }
}

console.log("-- BEGIN COMPLETE COLUMN CONTRACT");
console.log(columnRows.join(",\n"));
console.log("-- END COMPLETE COLUMN CONTRACT");
console.log("-- BEGIN COMPLETE FOREIGN KEY CONTRACT");
console.log(fkRows.join(",\n"));
console.log("-- END COMPLETE FOREIGN KEY CONTRACT");

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
