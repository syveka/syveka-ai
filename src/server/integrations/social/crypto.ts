import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for social platform OAuth tokens at rest.
 * Key: SOCIAL_TOKEN_ENCRYPTION_KEY — 32 bytes, base64 (see .env.example).
 * Ciphertext format: base64(iv[12] || authTag[16] || data). Mirrors
 * src/server/integrations/calendar/crypto.ts — kept as its own module (own
 * key, own env var) per CLAUDE.md §4: validate/scope each integration's
 * config independently rather than coupling it to an unrelated one.
 */

function getKey(): Buffer {
  const raw = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY is not set (required for social publishing)");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return key;
}

export function encryptSocialToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decryptSocialToken(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 29) throw new Error("Malformed ciphertext");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
