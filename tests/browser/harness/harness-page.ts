/**
 * Builds and serves the browser harness: the real UI components bundled with
 * esbuild (harness/entry.tsx), the app's compiled Tailwind CSS (so layout is
 * what users get), and the real locale messages. The page is served on an
 * unreachable origin and every request it makes is either answered by the
 * test or aborted: nothing leaves the machine.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import type { Page } from "@playwright/test";

export const ROOT = path.resolve(__dirname, "../../..");
const OUT = path.join(ROOT, "test-results/browser-harness");

export function readMessages(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8"));
}

/** next-intl's navigation (next/link, next/navigation) has no app router here. */
const routingStub: Plugin = {
  name: "routing-stub",
  setup(b) {
    b.onResolve({ filter: /^@\/i18n\/routing$/ }, () => ({
      path: path.join(__dirname, "routing-stub.tsx"),
    }));
  },
};

let cached: Promise<{ js: string; css: string }> | null = null;

/** The bundle and the CSS, built once per worker. */
export function harnessAssets(): Promise<{ js: string; css: string }> {
  cached ??= (async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const cssFile = path.join(OUT, `app-${process.pid}.css`);
    execFileSync(
      path.join(ROOT, "node_modules/.bin/tailwindcss"),
      ["-c", "tailwind.config.ts", "-i", "src/app/globals.css", "-o", cssFile],
      { cwd: ROOT, stdio: "ignore" },
    );
    const result = await build({
      entryPoints: [path.join(__dirname, "entry.tsx")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      tsconfig: path.join(ROOT, "tsconfig.json"),
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [routingStub],
      logLevel: "error",
    });
    return { js: result.outputFiles[0]!.text, css: fs.readFileSync(cssFile, "utf8") };
  })();
  return cached;
}

export type HarnessConfig = {
  component: "widget" | "manage" | "action";
  locale: string;
  props: Record<string, unknown>;
};

export async function openHarness(page: Page, config: HarnessConfig, now: Date): Promise<void> {
  const { js, css } = await harnessAssets();
  const dir = config.locale === "ar" ? "rtl" : "ltr";
  const payload = JSON.stringify({ ...config, messages: readMessages(config.locale) }).replace(
    /</g,
    "\\u003c",
  );
  await page.clock.install({ time: now });
  // Page routes (this page, and each test's API fake) take precedence over
  // context routes, whatever order they are registered in: anything they
  // don't answer (a stray same-origin path, fonts, analytics, any other
  // origin) falls through to this and is aborted. Nothing leaves the machine.
  await page.context().route("**/*", (route) => route.abort());
  await page.route("http://booking.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="${config.locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><main class="container max-w-2xl p-4" id="root"></main><script>window.__HARNESS__=${payload}</script><script>${js}</script></body></html>`,
    }),
  );
  await page.goto("/");
}

/** The page is no wider than the viewport: nothing forces sideways scrolling on a phone. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}
