// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { PublicSyvekaAssistant } from "../../src/components/marketing/public-syveka-assistant";

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

function renderWidget() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PublicSyvekaAssistant locale="en" />
    </NextIntlClientProvider>,
  );
}

describe("PublicSyvekaAssistant", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders only the launcher, closed, when first mounted", () => {
    renderWidget();
    expect(screen.getByRole("button", { name: "Chat with Syveka" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the panel and shows the greeting on launcher click, then closes on the close button", () => {
    renderWidget();

    fireEvent.click(screen.getByRole("button", { name: "Chat with Syveka" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Hi! How can I help you today?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders every suggested action before the first message is sent", () => {
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Chat with Syveka" }));

    expect(screen.getByText("What can Syveka do?")).toBeTruthy();
    expect(screen.getByText("Tell me about AI Voice")).toBeTruthy();
    expect(screen.getByText("How does Syveka help my business?")).toBeTruthy();
    expect(screen.getByText("Pricing")).toBeTruthy();
    expect(screen.getByText("Create an account")).toBeTruthy();
    expect(screen.getByText("Contact Syveka")).toBeTruthy();
  });

  it("routes the Pricing and Create an account suggestions to real links, not the AI endpoint", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Chat with Syveka" }));

    const pricingLink = screen.getByText("Pricing").closest("a");
    expect(pricingLink?.getAttribute("href")).toBe("/pricing");
    const registerLink = screen.getByText("Create an account").closest("a");
    expect(registerLink?.getAttribute("href")).toBe("/register");
    const contactLink = screen.getByText("Contact Syveka").closest("a");
    expect(contactLink?.getAttribute("href")).toBe("mailto:sales@syveka.ai");

    // None of these are clicked through jsdom (that would navigate), but
    // confirming they're plain links rather than buttons wired to send()
    // is exactly what guarantees fetch was never called for them.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a chat-kind suggestion calls the public endpoint with the suggestion text and renders the reply", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reply: "Syveka combines AI chat, Voice, CRM and booking." }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Chat with Syveka" }));

    fireEvent.click(screen.getByText("What can Syveka do?"));

    await waitFor(() =>
      expect(screen.getByText("Syveka combines AI chat, Voice, CRM and booking.")).toBeTruthy(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/public-assistant");
    const body = JSON.parse(init.body as string);
    expect(body.message).toBe("What can Syveka do?");
    expect(body.locale).toBe("en");
    expect(Array.isArray(body.history)).toBe(true);
  });

  it("shows a translated rate-limit message on a 429, never a raw error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchSpy);
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Chat with Syveka" }));

    fireEvent.click(screen.getByText("What can Syveka do?"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("sales@syveka.ai");
  });

  it("never sends a malformed (non-alternating) history after a failed attempt is retried -- the failed user turn is not folded into history", async () => {
    const fetchSpy = vi
      .fn()
      // First two sends fail (e.g. transient network/server error) -- the
      // widget still shows both attempts in the transcript, but must not
      // treat either as a completed (user, assistant) exchange.
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ reply: "Sure!" }) });
    vi.stubGlobal("fetch", fetchSpy);
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Chat with Syveka" }));
    const input = () => screen.getByPlaceholderText("Ask a question…") as HTMLInputElement;
    const submit = () => screen.getByRole("button", { name: "Send" });

    fireEvent.change(input(), { target: { value: "first attempt" } });
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    fireEvent.change(input(), { target: { value: "second attempt" } });
    fireEvent.click(submit());
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    fireEvent.change(input(), { target: { value: "third attempt" } });
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByText("Sure!")).toBeTruthy());

    // The third call's `history` must be empty -- neither of the two
    // failed attempts ever completed, so nothing is a valid prior turn.
    const thirdCallBody = JSON.parse(
      (fetchSpy.mock.calls[2] as [string, RequestInit])[1].body as string,
    );
    expect(thirdCallBody.history).toEqual([]);
  });

  it("sends the free-text input via the form and clears the draft afterward", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ reply: "Sure!" }) });
    vi.stubGlobal("fetch", fetchSpy);
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: "Chat with Syveka" }));

    const input = screen.getByPlaceholderText("Ask a question…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Does Syveka support Arabic?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(input.value).toBe("");
    await waitFor(() => expect(screen.getByText("Does Syveka support Arabic?")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Sure!")).toBeTruthy());
  });
});
