import { afterEach, describe, expect, it } from "vitest";
import { getQstashEnv } from "@/env";

const SNAPSHOT_KEYS = [
  "SKIP_ENV_VALIDATION",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "NEXT_PUBLIC_APP_URL",
] as const;
const snapshot = Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of SNAPSHOT_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

describe("getQstashEnv", () => {
  it("resolves QStash credentials without requiring unrelated required server vars", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.QSTASH_TOKEN = "test-qstash-token";
    process.env.QSTASH_CURRENT_SIGNING_KEY = "test-current-signing-key";
    process.env.QSTASH_NEXT_SIGNING_KEY = "test-next-signing-key";
    process.env.NEXT_PUBLIC_APP_URL = "https://example.test";
    // tests/setup/env.ts only seeds NEXT_PUBLIC_*/OPENAI_API_KEY, so
    // STRIPE_SECRET_KEY, VAPI_API_KEY, RESEND_API_KEY, etc. are unset here --
    // getQstashEnv must succeed regardless, unlike the full server schema.
    expect(getQstashEnv()).toEqual({
      QSTASH_TOKEN: "test-qstash-token",
      QSTASH_CURRENT_SIGNING_KEY: "test-current-signing-key",
      QSTASH_NEXT_SIGNING_KEY: "test-next-signing-key",
      NEXT_PUBLIC_APP_URL: "https://example.test",
    });
  });

  it("throws a field-name-only error when a required QStash var is missing", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    process.env.QSTASH_TOKEN = "test-qstash-token";
    process.env.QSTASH_NEXT_SIGNING_KEY = "test-next-signing-key";
    process.env.NEXT_PUBLIC_APP_URL = "https://example.test";

    expect(() => getQstashEnv()).toThrow(/QSTASH_CURRENT_SIGNING_KEY/);
  });

  it("throws a field-name-only error when NEXT_PUBLIC_APP_URL is malformed", () => {
    delete process.env.SKIP_ENV_VALIDATION;
    process.env.QSTASH_TOKEN = "test-qstash-token";
    process.env.QSTASH_CURRENT_SIGNING_KEY = "test-current-signing-key";
    process.env.QSTASH_NEXT_SIGNING_KEY = "test-next-signing-key";
    process.env.NEXT_PUBLIC_APP_URL = "not-a-valid-url";

    expect(() => getQstashEnv()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });
});
