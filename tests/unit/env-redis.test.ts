import { afterEach, describe, expect, it } from "vitest";
import { getRedisEnv } from "@/env";

const SNAPSHOT_KEYS = [
  "SKIP_ENV_VALIDATION",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;
const snapshot = Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of SNAPSHOT_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

describe("getRedisEnv", () => {
  it("resolves Redis credentials without requiring unrelated required server vars", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    // tests/setup/env.ts only seeds NEXT_PUBLIC_*/OPENAI_API_KEY, so
    // STRIPE_SECRET_KEY, QSTASH_TOKEN, VAPI_API_KEY, etc. are unset here —
    // getRedisEnv must succeed regardless, unlike the full server schema.
    expect(getRedisEnv()).toEqual({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
    });
  });

  it("throws a field-name-only error when a Redis var itself is missing", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

    expect(() => getRedisEnv()).toThrow(/UPSTASH_REDIS_REST_URL/);
  });
});
