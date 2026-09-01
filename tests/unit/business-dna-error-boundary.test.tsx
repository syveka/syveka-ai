// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import BusinessDnaError from "../../src/app/[locale]/(app)/settings/business-dna/error";

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

/**
 * /settings/business-dna had no error.tsx boundary at all, so any client
 * exception on that page (whatever throws it) fell through to Next.js's
 * generic, unrecoverable "Application error: a client-side exception has
 * occurred" screen -- the exact message from the staging report. This
 * boundary makes the failure recoverable and, by surfacing error.message /
 * error.digest on screen, gives the next occurrence a captureable stack
 * instead of an opaque dead end.
 */
describe("BusinessDnaError boundary", () => {
  afterEach(cleanup);

  it("renders a recoverable error card and calls reset on click", () => {
    const reset = vi.fn();
    const error = Object.assign(new Error("Cannot read properties of undefined (reading 'x')"), {
      digest: "1234567890",
    });

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BusinessDnaError error={error} reset={reset} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("reveals the underlying error message and digest behind the details toggle", () => {
    const error = Object.assign(new Error("Cannot read properties of undefined (reading 'x')"), {
      digest: "1234567890",
    });

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BusinessDnaError error={error} reset={vi.fn()} />
      </NextIntlClientProvider>,
    );

    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
    fireEvent.click(screen.getByText("Show details"));
    expect(screen.getByText(/Cannot read properties of undefined/)).toBeTruthy();
    expect(screen.getByText(/1234567890/)).toBeTruthy();
  });
});
