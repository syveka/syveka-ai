import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";

/**
 * The register and login pages carry an invitation (and only an invitation)
 * from `?next=` into the submitted form and into the link that switches
 * between them, so an invited person who already has an account can sign in
 * from the register page without losing the invitation.
 */

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/actions/auth", () => ({ loginAction: vi.fn(), registerAction: vi.fn() }));

import RegisterPage from "@/app/[locale]/(auth)/register/page";
import LoginPage from "@/app/[locale]/(auth)/login/page";

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

const INVITE = "/invite/3f0c2b9e-8a41-4d2e-9b7c-1e5f6a7b8c9d";

async function render(
  Page: typeof RegisterPage | typeof LoginPage,
  next?: string | string[],
): Promise<string> {
  const element = await Page({ searchParams: Promise.resolve(next === undefined ? {} : { next }) });
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {element}
    </NextIntlClientProvider>,
  );
}

const hiddenNext = (html: string) => /<input[^>]*name="next"[^>]*>/.exec(html)?.[0];

describe.each([
  ["register", RegisterPage, "/login"],
  ["login", LoginPage, "/register"],
] as const)("%s page", (_name, Page, otherPage) => {
  it("carries an invitation into the form and the switch link", async () => {
    const html = await render(Page, INVITE);
    expect(hiddenNext(html)).toContain(`value="${INVITE}"`);
    expect(html).toContain(`href="${otherPage}?next=${encodeURIComponent(INVITE)}"`);
  });

  it.each([
    ["no next", undefined],
    ["a non-invitation path", "/settings/members"],
    ["another origin", `https://evil.example${INVITE}`],
    ["a repeated parameter", [INVITE, INVITE]],
  ])("without an invitation (%s) the form is unchanged", async (_label, next) => {
    const html = await render(Page, next);
    expect(hiddenNext(html)).toBeUndefined();
    expect(html).toContain(`href="${otherPage}"`);
    expect(html).not.toContain("evil.example");
  });
});

describe("login page after an email link that couldn't be completed", () => {
  const renderLogin = async (searchParams: Record<string, string>) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {await LoginPage({ searchParams: Promise.resolve(searchParams) })}
      </NextIntlClientProvider>,
    );

  it("says so and keeps the invitation", async () => {
    const html = await renderLogin({ error: "auth_callback_failed", next: INVITE });
    expect(html).toContain(messages.auth.callbackFailed);
    expect(hiddenNext(html)).toContain(`value="${INVITE}"`);
  });

  it("an ordinary login shows no notice", async () => {
    expect(await renderLogin({})).not.toContain(messages.auth.callbackFailed);
    expect(await renderLogin({ error: "something_else" })).not.toContain(
      messages.auth.callbackFailed,
    );
  });
});
