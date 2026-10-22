// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type * as ReactDom from "react-dom";

/**
 * The billing forms' submit button: while its form is submitting (a
 * Checkout or portal redirect being prepared) it is disabled and says so,
 * so a second click can't send a second request.
 */
const form = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactDom>();
  return { ...actual, useFormStatus: () => ({ pending: form.pending }) };
});

import { PendingSubmitButton } from "@/components/billing/pending-submit-button";

const en = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
) as { billingPage: Record<string, string> };

function renderButton(props: { disabled?: boolean } = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PendingSubmitButton {...props}>{en.billingPage.choosePlan}</PendingSubmitButton>
    </NextIntlClientProvider>,
  );
  return screen.getByRole("button") as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  form.pending = false;
});

describe("PendingSubmitButton", () => {
  it("idle: an enabled submit button with its label", () => {
    const button = renderButton();
    expect(button.type).toBe("submit");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(en.billingPage.choosePlan);
  });

  it("submitting: disabled, busy, and says it is opening", () => {
    form.pending = true;
    const button = renderButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe(en.billingPage.redirecting);
  });

  it("stays disabled when its caller disables it (the current plan)", () => {
    expect(renderButton({ disabled: true }).disabled).toBe(true);
  });
});
