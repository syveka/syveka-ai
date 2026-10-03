import { expect } from "vitest";

/**
 * Synthetic personal data, tenant data and credentials used by the error
 * tracking tests. None of it is real, and none of it may appear in anything
 * the error tracker would send.
 */
export const ORG_ID = "9b2f5c1e-4d3a-4b7e-8f60-1a2b3c4d5e6f";
export const NAME = "Maria Virtanen"; // unquoted, plain words
export const ARABIC_NAME = "أحمد الهاشمي";
export const ARABIC_CHAT = "مرحبا، أريد حجز موعد يوم الخميس";
export const CHAT_TEXT = "Please book a meeting with Maria about the Q4 contract renewal";
export const CRM_DETAIL = "Nordic Oy deal 45000 EUR closes Friday";
export const EMAIL = "maria.virtanen@example.fi";
export const PHONE = "+358 40 123 4567";
export const BOOKING_SLUG = "acme-oy";
// Credentials are assembled at runtime so they never appear verbatim in the repository.
export const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiI5YjJmIn0", "c2lnbmF0dXJl"].join(".");
export const STRIPE_KEY = ["sk", "live", "51HxQ2rKj8xYzAbCdEfGh1234"].join("_");
export const INVITE_TOKEN = ["inv8Kq2Lm9", "Zx4Rt7Wv1Yb3"].join("");

export const NEVER_SENT = [
  ORG_ID,
  "Maria",
  "Virtanen",
  ARABIC_NAME,
  "أحمد",
  ARABIC_CHAT,
  "الخميس",
  CHAT_TEXT,
  "contract",
  "Nordic",
  "45000",
  EMAIL,
  "40 123",
  INVITE_TOKEN,
  BOOKING_SLUG,
  JWT,
  STRIPE_KEY,
  "hunter2",
  "sb-access-token",
];

/** A message mixing every kind of sensitive content. */
export const SENSITIVE_MESSAGE = `Contact ${NAME} (${EMAIL}, ${PHONE}) for org ${ORG_ID} failed: ${ARABIC_CHAT} ${CHAT_TEXT}\n${CRM_DETAIL} ${JWT}`;

export function expectClean(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of NEVER_SENT) expect(text).not.toContain(secret);
}
