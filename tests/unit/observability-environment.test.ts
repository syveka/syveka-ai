// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/browser";
import { sentryEnvironment, sentryOptions } from "@/lib/observability/options";

/**
 * The Sentry environment label comes only from NEXT_PUBLIC_SENTRY_ENVIRONMENT.
 * Without it the SDK keeps its own default, which reads "production" for any
 * `vercel build --prod`, including the stable staging alias.
 */
const DSN = "https://publickey@o1.ingest.de.sentry.io/2";

afterEach(async () => {
  await Sentry.close();
  vi.unstubAllEnvs();
});

describe("sentryEnvironment", () => {
  it.each([
    ["staging", "staging"],
    ["production", "production"],
    ["  staging \n", "staging"],
    ["staging-preview", "staging-preview"],
  ])("%j is used as %j", (raw, expected) => {
    expect(sentryEnvironment(raw)).toBe(expected);
  });

  it.each([undefined, "", "   ", "Staging", "stag ing", "a/b", "line\nbreak", "x".repeat(33)])(
    "%j is ignored",
    (raw) => {
      expect(sentryEnvironment(raw)).toBeUndefined();
    },
  );
});

describe("sentryOptions environment", () => {
  it("unset: the key is absent, so the SDK default is untouched", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "");
    expect("environment" in sentryOptions(DSN)).toBe(false);
  });

  it("configured: both runtimes get the same label", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "staging");
    expect(sentryOptions(DSN).environment).toBe("staging");
    expect(sentryOptions(DSN, "abc123").environment).toBe("staging");
  });

  it("configuring it changes nothing else about the errors-only options", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "");
    const { ...unset } = sentryOptions(DSN);
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "staging");
    const { environment, ...configured } = sentryOptions(DSN);
    expect(environment).toBe("staging");
    expect(Object.keys(configured).sort()).toEqual(Object.keys(unset).sort());
    expect(configured.tracesSampleRate).toBeUndefined();
    expect(configured.tracePropagationTargets).toEqual([]);
  });
});

/** Captures one error through the real browser SDK and returns its event. */
async function capturedEvent(): Promise<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  Sentry.init({
    ...(sentryOptions(DSN) as Sentry.BrowserOptions),
    transport: () => ({
      send: async (envelope: unknown) => {
        const [, items] = envelope as [unknown, Array<[{ type: string }, unknown]>];
        for (const [header, payload] of items) {
          if (header.type === "event") sent.push(payload as Record<string, unknown>);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  Sentry.captureException(new Error("synthetic"));
  await Sentry.flush(2000);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe("real browser SDK", () => {
  it("events carry the configured environment", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "staging");
    expect((await capturedEvent()).environment).toBe("staging");
  });

  it("without it, events keep the SDK's own default", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "");
    expect((await capturedEvent()).environment).toBe("production");
  });
});
