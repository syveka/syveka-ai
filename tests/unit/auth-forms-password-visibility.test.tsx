// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";

/**
 * Website UX task, Part A: confirms the three real auth forms
 * (login/register/reset-password) were actually wired to the shared
 * PasswordInput -- not just that PasswordInput itself works in isolation
 * (tests/unit/password-input.test.tsx). Render-only, like the existing
 * BusinessDnaForm render tests: mounting a client component that binds a
 * "use server" action to useActionState is safe without invoking the
 * action (Next never calls it during render), but actually submitting it
 * needs a real request context this suite doesn't have.
 */
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

function withProvider(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe("auth forms use the shared password-visibility control", () => {
  afterEach(cleanup);

  // First test in the file: its dynamic import pays a one-time cold-module-load cost
  // (RegisterForm/ResetPasswordForm below reuse Node's warm module cache and run in
  // single-digit ms). Directly measured at ~5.3s under full-suite contention from
  // tests/unit/legacy-schema-contract-generator.test.ts's ~36 concurrent subprocess
  // spawns, just over the default 5s budget, with no change in what this test does or
  // asserts. Scoped to this one test only; see the migration report for the measurement.
  it("LoginForm: one password field, hidden by default, current-password autocomplete", async () => {
    const { LoginForm } = await import("../../src/app/[locale]/(auth)/login/login-form");
    const { container } = render(withProvider(<LoginForm />));

    const input = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("current-password");
    expect(input.required).toBe(true);
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
  }, 15000);

  it("RegisterForm: one password field, hidden by default, new-password autocomplete", async () => {
    const { RegisterForm } = await import("../../src/app/[locale]/(auth)/register/register-form");
    const { container } = render(withProvider(<RegisterForm />));

    const input = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
    expect(input.minLength).toBe(12);
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
  });

  it("ResetPasswordForm: one password field, hidden by default, new-password autocomplete", async () => {
    const { ResetPasswordForm } =
      await import("../../src/app/[locale]/(auth)/reset-password/reset-form");
    const { container } = render(withProvider(<ResetPasswordForm />));

    const input = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
    expect(input.minLength).toBe(12);
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
  });
});
