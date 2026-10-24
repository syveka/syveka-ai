import { z } from "zod";

/**
 * An ISO 8601 UTC timestamp ("…Z"), with or without seconds: what Zod 3's
 * `z.string().datetime()` accepted. Zod 4's default requires seconds, so on its
 * own it would reject "2026-10-24T10:00Z" from a form or a model's tool call.
 */
export const isoDateTime = () =>
  z.union([z.string().datetime(), z.string().datetime({ precision: -1 })]);
