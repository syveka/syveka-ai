// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * DSN gating and wiring, with the SDK mocked: no SDK code runs and nothing
 * can be sent. `sdk.imported` records whether the SDK module was loaded at
 * all, so "no DSN" can be shown to load nothing.
 */
const sdk = vi.hoisted(() => ({
  imported: false,
  init: vi.fn(),
  captureException: vi.fn(),
  captureRequestError: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => {
  sdk.imported = true;
  return {
    init: sdk.init,
    captureException: sdk.captureException,
    captureRequestError: sdk.captureRequestError,
  };
});

import {
  initClientErrorTracking,
  reportBoundaryError,
  resetClientErrorTrackingForTests,
} from "@/lib/observability/client";
import { onRequestError, register } from "@/instrumentation";
import LocaleError from "@/app/[locale]/error";
import DashboardError from "@/app/[locale]/(app)/dashboard/error";
import InboxError from "@/app/[locale]/(app)/inbox/error";
import InboxThreadError from "@/app/[locale]/(app)/inbox/[threadId]/error";
import BusinessDnaError from "@/app/[locale]/(app)/settings/business-dna/error";

const DSN = "https://publickey@o1.ingest.de.sentry.io/2";
const en = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
) as Record<string, Record<string, string>>;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sdk.imported = false;
  sdk.init.mockClear();
  sdk.captureException.mockClear();
  sdk.captureRequestError.mockClear();
  resetClientErrorTrackingForTests();
  delete process.env.SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type InitOptions = {
  dsn: string;
  tracesSampleRate?: number;
  tracesSampler?: unknown;
  tracePropagationTargets: unknown[];
  dataCollection: Record<string, unknown>;
  integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
  beforeSend: (event: unknown) => unknown;
  beforeBreadcrumb: (b: unknown) => unknown;
  initialScope?: unknown;
};
const initOptions = () => sdk.init.mock.calls[0]![0] as InitOptions;

function expectErrorsOnlyOptions(options: InitOptions) {
  expect(options.dsn).toBe(DSN);
  // Tracing disabled: no rate (0 would still enable span recording), no sampler, no propagation.
  expect(options.tracesSampleRate).toBeUndefined();
  expect(options.tracesSampler).toBeUndefined();
  expect(options.tracePropagationTargets).toEqual([]);
  // Nothing identifies a tenant or user.
  expect(options.initialScope).toBeUndefined();
  expect(options.dataCollection).toMatchObject({
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
  });
  // Tracing, Session Replay, feedback, sessions and console capture removed.
  const names = [
    "BrowserTracing",
    "Replay",
    "ReplayCanvas",
    "Feedback",
    "BrowserSession",
    "Console",
    "GlobalHandlers",
    "LinkedErrors",
    "Dedupe",
  ];
  expect(options.integrations(names.map((name) => ({ name }))).map((i) => i.name)).toEqual([
    "GlobalHandlers",
    "LinkedErrors",
    "Dedupe",
  ]);
}

describe("browser", () => {
  it.each([undefined, "", "not-a-dsn"])(
    "DSN %j: nothing is loaded, initialized or reported",
    async (dsn) => {
      expect(initClientErrorTracking(dsn)).toBeNull();
      reportBoundaryError(new Error("boom"));
      await flush();
      expect(sdk.imported).toBe(false);
      expect(sdk.init).not.toHaveBeenCalled();
      expect(sdk.captureException).not.toHaveBeenCalled();
    },
  );

  it("reads NEXT_PUBLIC_SENTRY_DSN by default", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    await initClientErrorTracking();
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it("with a DSN: initialized once, errors only, then boundary errors are captured", async () => {
    await initClientErrorTracking(DSN);
    await initClientErrorTracking(DSN);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expectErrorsOnlyOptions(initOptions());

    const error = new Error("client boom");
    reportBoundaryError(error);
    await flush();
    expect(sdk.captureException).toHaveBeenCalledWith(error);
  });

  it("server errors shown by a boundary (with a digest) aren't reported twice", async () => {
    await initClientErrorTracking(DSN);
    reportBoundaryError(Object.assign(new Error(""), { digest: "123" }));
    await flush();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("an SDK that fails to load never breaks the app", async () => {
    sdk.init.mockImplementationOnce(() => {
      throw new Error("init failed");
    });
    await expect(initClientErrorTracking(DSN)).resolves.toBeNull();
    reportBoundaryError(new Error("x"));
    await flush();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});

describe("route error boundaries", () => {
  const boundaries: Array<[string, React.ComponentType<{ error: Error; reset: () => void }>]> = [
    ["[locale]", LocaleError],
    ["dashboard", DashboardError],
    ["inbox", InboxError],
    ["inbox/[threadId]", InboxThreadError],
    ["settings/business-dna", BusinessDnaError],
  ];
  const show = (Boundary: React.ComponentType<{ error: Error; reset: () => void }>, error: Error) =>
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Boundary error={error} reset={() => {}} />
      </NextIntlClientProvider>,
    );

  it.each(boundaries)("%s: reports the error when a DSN is configured", async (_, Boundary) => {
    await initClientErrorTracking(DSN);
    const error = new Error("render failed");
    show(Boundary, error);
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(sdk.captureException).toHaveBeenCalledWith(error);
  });

  it.each(boundaries)("%s: unchanged and silent without a DSN", async (_, Boundary) => {
    show(Boundary, new Error("render failed"));
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(sdk.imported).toBe(false);
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});

describe("server (instrumentation.ts)", () => {
  const request = {
    path: "/en/dashboard",
    method: "GET",
    headers: { cookie: "sb=secret" },
  };
  const context = {
    routerKind: "App Router" as const,
    routePath: "/[locale]/dashboard",
    routeType: "render" as const,
    renderSource: "react-server-components" as const,
    revalidateReason: undefined,
  };

  it.each([undefined, "", "not-a-dsn"])(
    "DSN %j: register() and onRequestError load and send nothing",
    async (dsn) => {
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      if (dsn !== undefined) vi.stubEnv("SENTRY_DSN", dsn);
      await register();
      await onRequestError(new Error("server boom"), request, context);
      expect(sdk.imported).toBe(false);
      expect(sdk.init).not.toHaveBeenCalled();
      expect(sdk.captureRequestError).not.toHaveBeenCalled();
    },
  );

  it("a malformed DSN is reported without its value", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("SENTRY_DSN", "https://secret-looking-value@");
    await register();
    expect(console.warn).toHaveBeenCalledWith(
      "error_tracking_disabled: SENTRY_DSN is not a valid DSN",
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("secret-looking");
  });

  it("with a DSN (Node.js runtime): initialized errors-only, and request errors are captured", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("SENTRY_DSN", DSN);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    await register();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expectErrorsOnlyOptions(initOptions());
    expect(initOptions()).toMatchObject({ release: "abc123" });

    const error = new Error("server boom");
    await onRequestError(error, request, context);
    expect(sdk.captureRequestError).toHaveBeenCalledWith(error, request, context);
  });

  it("the Edge runtime never loads the SDK", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("SENTRY_DSN", DSN);
    await register();
    await onRequestError(new Error("edge boom"), request, context);
    expect(sdk.imported).toBe(false);
  });
});
