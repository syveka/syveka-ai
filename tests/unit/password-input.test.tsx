// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PasswordInput } from "../../src/components/ui/password-input";

/**
 * Website UX task, Part A: password show/hide control. Covers the toggle
 * behavior itself -- the three auth forms that consume this component
 * (login/register/reset) are exercised separately by their own existing
 * server-action tests, which are untouched by this change. Queries the
 * input by `name` rather than by ARIA role: input[type=password] has no
 * reliable implicit ARIA role across engines/spec versions to query by, and
 * these tests render the bare component without the surrounding
 * <Label htmlFor> the real forms provide.
 */
describe("PasswordInput", () => {
  afterEach(cleanup);

  const labels = { show: "Show password", hide: "Hide password" };
  const getInput = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[name="password"]')!;

  it("is hidden by default", () => {
    const { container } = render(<PasswordInput name="password" toggleLabels={labels} />);
    expect(getInput(container).type).toBe("password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
  });

  it("reveals the password on the first click and updates the toggle's accessible label", () => {
    const { container } = render(<PasswordInput name="password" toggleLabels={labels} />);

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));

    expect(getInput(container).type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show password" })).toBeNull();
  });

  it("hides the password again on the second click", () => {
    const { container } = render(<PasswordInput name="password" toggleLabels={labels} />);
    const toggle = () => screen.getByRole("button", { name: /password/i });

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(getInput(container).type).toBe("password");
  });

  it("is keyboard accessible as a real <button> and exposes aria-pressed state", () => {
    render(<PasswordInput name="password" toggleLabels={labels} />);
    const toggle = screen.getByRole("button", { name: "Show password" });

    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("never mutates the underlying value -- toggling only changes the DOM type attribute, never the value", () => {
    const { container } = render(
      <PasswordInput
        name="password"
        defaultValue="correct horse battery staple"
        toggleLabels={labels}
      />,
    );

    expect(getInput(container).value).toBe("correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(getInput(container).value).toBe("correct horse battery staple");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(getInput(container).value).toBe("correct horse battery staple");
  });

  it("preserves autocomplete, required, and other passed-through input attributes", () => {
    const { container } = render(
      <PasswordInput
        name="password"
        autoComplete="new-password"
        required
        minLength={12}
        toggleLabels={labels}
      />,
    );
    const input = getInput(container);
    expect(input.autocomplete).toBe("new-password");
    expect(input.required).toBe(true);
    expect(input.minLength).toBe(12);
  });
});
