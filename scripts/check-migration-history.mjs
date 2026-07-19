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
    "cba1cac3bc1dbc634c44a54a14433387050908e24c9411e086f57b6031085feb",
  ],
  [
    "20260712120000_crm_contacts_companies_v1",
    "d132bcc6f762c8bfde8a24a232e4870634d2ccf8f07f892200d91c6053323f5c",
  ],
  [
    "20260712180000_crm_deals_v1",
    "ad9f5ccc7b4bf60f38c39638a635d24fd3c09c6e32d72b32a03bd00e39b34045",
  ],
  [
    "20260713000000_calendar_booking_v1",
    "6e741258313aa56c3506c11b279c89355c0458c8ede67dd101eb355cb51610e8",
  ],
  [
    "20260714000000_secure_document_upload_intents",
    "bccaa57055102940d1c717b9270ca17a1267737c9350d671c3b1ff21a033b17c",
  ],
  [
    "20260715000000_ai_chat_production_hardening",
    "09d8e132a5a1368da61c2fac2b6b4ad675fad1c827d2b493daca311207fc6bf8",
  ],
  [
    "20260715230000_security_invariant_corrections",
    "2394c4e331292145089beb7e90994611dc4818f670abd62f014571afc8f309b4",
  ],
  [
    "20260718000000_calendar_booking_rls",
    "d7d4ff3910d5a6f1469ba53da4d82e91fc0da6f0d5681af6dd5703afbf6f4a4e",
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
  const contents = await readFile(path.join(migrationRoot, migration, "migration.sql"));
  const checksum = createHash("sha256").update(contents).digest("hex");
  if (checksum !== expectedChecksum) {
    throw new Error(`Published migration ${migration} was modified (${checksum}).`);
  }
}

console.log(
  `Migration history is ordered and ${publishedChecksums.size} published checksums match.`,
);
