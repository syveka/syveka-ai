import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn((_url: string, _key: string, _options: unknown) => ({ auth: {} })),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));

import { createSupabaseMiddlewareClient } from "@/server/supabase/server";

const snapshot = {
  SKIP_ENV_VALIDATION: process.env.SKIP_ENV_VALIDATION,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

type GlobalOptions = { fetch: typeof fetch };

describe("Supabase middleware client — bounded auth fetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.SKIP_ENV_VALIDATION = "1";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [name, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function customFetch(): typeof fetch {
    const options = mocks.createServerClient.mock.calls[0]?.[2] as { global: GlobalOptions };
    return options.global.fetch;
  }

  it("passes an AbortSignal through to the underlying fetch", () => {
    createSupabaseMiddlewareClient(new NextRequest("https://staging.example.test/en/dashboard"));
    const realFetch = vi.fn(
      (_input: unknown, _init?: RequestInit) => new Promise<Response>(() => {}),
    );
    vi.stubGlobal("fetch", realFetch);

    void customFetch()("https://example.supabase.co/auth/v1/user", {});

    expect(realFetch).toHaveBeenCalledTimes(1);
    const init = realFetch.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("aborts the request once the bounded timeout elapses, instead of hanging indefinitely", () => {
    createSupabaseMiddlewareClient(new NextRequest("https://staging.example.test/en/dashboard"));
    let capturedSignal: AbortSignal | undefined;
    const hangingFetch = vi.fn((_input: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", hangingFetch);

    void customFetch()("https://example.supabase.co/auth/v1/user", {});

    expect(capturedSignal?.aborted).toBe(false);
    vi.advanceTimersByTime(8000);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("does not abort a fetch that resolves well within the timeout", async () => {
    createSupabaseMiddlewareClient(new NextRequest("https://staging.example.test/en/dashboard"));
    const fastFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fastFetch);

    const result = await customFetch()("https://example.supabase.co/auth/v1/user", {});

    expect(result.status).toBe(200);
    expect(fastFetch).toHaveBeenCalledTimes(1);
  });
});
