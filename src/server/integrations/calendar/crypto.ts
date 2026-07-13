import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for OAuth tokens at rest.
 * Key: CALENDAR_TOKEN_ENCRYPTION_KEY — 32 bytes, base64 (see .env.example).
 * Ciphertext format: base64(iv[12] || authTag[16] || data).
 */

function getKey(): Buffer {
  const raw = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("CALENDAR_TOKEN_ENCRYPTION_KEY is not set (required for calendar OAuth)");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("CALENDAR_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decryptToken(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 29) throw new Error("Malformed ciphertext");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
