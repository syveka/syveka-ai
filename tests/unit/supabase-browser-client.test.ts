import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBrowserClient: vi.fn((_url: string, _key: string) => ({ auth: {} })),
}));

vi.mock("@supabase/ssr", () => ({ createBrowserClient: mocks.createBrowserClient }));

import { createClient } from "@/lib/supabase/client";

const snapshot = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

describe("browser Supabase client (src/lib/supabase/client.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("creates the browser client from NEXT_PUBLIC_SUPABASE_URL/ANON_KEY", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    createClient();

    expect(mocks.createBrowserClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key",
    );
  });

  it("trims a copy/paste trailing newline the same way getSupabaseAuthEnv() does server-side", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co\n";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = " anon-key ";

    createClient();

    expect(mocks.createBrowserClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key",
    );
  });

  it("throws a clear error instead of a raw crash when a value is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

    expect(() => createClient()).toThrow(/Missing NEXT_PUBLIC_SUPABASE_URL/);
    expect(mocks.createBrowserClient).not.toHaveBeenCalled();
  });

  /**
   * The actual defect class this whole file guards against is a Next.js
   * build-time behavior (static inlining of `process.env.NEXT_PUBLIC_X`
   * literals into the client bundle) that Vitest/Node cannot reproduce --
   * only real webpack compilation can. This structural check is the part
   * that matters: it fails loudly if this file ever goes back through
   * getSupabaseAuthEnv() or any other whole-object `process.env` access,
   * which is exactly what broke every authenticated staging route (see the
   * file's own doc comment for the live incident this came from).
   */
  it("reads the two env vars as direct literal process.env.NEXT_PUBLIC_X expressions, never via getSupabaseAuthEnv()", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/supabase/client.ts"), "utf8");

    expect(source).not.toContain("import { getSupabaseAuthEnv }");
    expect(source).not.toContain("process.env)");
    expect(source).toContain("process.env.NEXT_PUBLIC_SUPABASE_URL");
    expect(source).toContain("process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });
});
