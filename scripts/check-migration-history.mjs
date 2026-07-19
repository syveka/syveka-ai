import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const migrationRoot = path.resolve("prisma/migrations");
const expectedOrder = [
  "20260701000000_initial_baseline",
  "20260712000000_dashboard_indexes",
  "20260712120000_crm_contacts_companies_v1",
  "20260712180000_crm_deals_v1",
  "20260713000000_calendar_booking_v1",
  "20260714000000_secure_document_upload_intents",
  "20260715000000_ai_chat_production_hardening",
  "20260715230000_security_invariant_corrections",
  "20260718000000_calendar_booking_rls",
  "20260719000000_initial_security_baseline",
];

// These eight migrations were published before the staging-release branch.
// Pinning their checksums makes accidental edits fail locally and in CI.
const publishedChecksums = new Map([
  [
    "20260712000000_dashboard_indexes",
    "b61caa2883944b056d0c15569ab15ad7cea90bfdcd152e6f7538501ffabbd392",
  ],
  [
    "20260712120000_crm_contacts_companies_v1",
    "59d9262b00014ce2ac69f823058c97982bdb4471157ab570a653ffc54342be8d",
  ],
  [
    "20260712180000_crm_deals_v1",
    "83a7f31822b7d6a8bb8158ae0ef8e57024cc00ae37fd0f816cc2dc3e937f7801",
  ],
  [
    "20260713000000_calendar_booking_v1",
    "bdc4288612b123c92e08c231a10aa434520497ec05b6e623461b0501a2488e8f",
  ],
  [
    "20260714000000_secure_document_upload_intents",
    "13ffd5f1dbda1675ed13243d5ca304312d920e848856f8dedaf06ad8f2928cf2",
  ],
  [
    "20260715000000_ai_chat_production_hardening",
    "ed8b38d98718c08499dc0194ebb39bc22ce46345d18cfb907f46ddcbec54552b",
  ],
  [
    "20260715230000_security_invariant_corrections",
    "318f6e972c6229c4071b6bd6ef4724bec801ae59b4ce380d9d0d7bf593016594",
  ],
  [
    "20260718000000_calendar_booking_rls",
    "9c794259561334354beadb0318cabea8d26513754fde3dc24072758092a14c68",
  ],
]);

const entries = await readdir(migrationRoot, { withFileTypes: true });
const actualOrder = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
  throw new Error(
    `Migration order mismatch.\nExpected: ${expectedOrder.join(", ")}\nActual:   ${actualOrder.join(", ")}`,
  );
}

for (const [migration, expectedChecksum] of publishedChecksums) {
  const contents = await readFile(path.join(migrationRoot, migration, "migration.sql"), "utf8");
  const canonicalContents = contents.replace(/\r\n/g, "\n");
  const checksum = createHash("sha256").update(canonicalContents).digest("hex");
  if (checksum !== expectedChecksum) {
    throw new Error(`Published migration ${migration} was modified (${checksum}).`);
  }
}

console.log(
  `Migration history is ordered and ${publishedChecksums.size} published checksums match.`,
);
