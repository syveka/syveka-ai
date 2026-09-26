// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import {
  GeneratedImagePreview,
  generatedImageSrc,
} from "@/components/creator-studio/generated-image-preview";

const load = (locale: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"));
const GEN = "22222222-2222-4222-8222-222222222222";

function renderPreview(props: { hasOutput: boolean }, locale = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={load(locale)}>
      <div dir={locale === "ar" ? "rtl" : "ltr"}>
        <GeneratedImagePreview generationId={GEN} {...props} />
      </div>
    </NextIntlClientProvider>,
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Rendering, failing and retrying must never call any API (no generation,
  // no credits); the only request is the browser loading <img src>.
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GeneratedImagePreview", () => {
  it("loads only through the authenticated preview route, with an accessible label", () => {
    renderPreview({ hasOutput: true });
    const img = screen.getByRole("img", { name: "Generated image" });
    expect(img.getAttribute("src")).toBe(`/api/v1/creator-studio/generations/${GEN}/image`);
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByText("Loading image…")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open generated image in a new tab" })).toBeTruthy();
    fireEvent.load(img);
    expect(screen.queryByText("Loading image…")).toBeNull();
  });

  it("shows an error state and retries by re-requesting the same read-only route", () => {
    renderPreview({ hasOutput: true });
    fireEvent.error(screen.getByRole("img", { name: "Generated image" }));
    expect(screen.getByRole("alert").textContent).toContain("Image could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const img = screen.getByRole("img", { name: "Generated image" });
    expect(img.getAttribute("src")).toBe(
      `/api/v1/creator-studio/generations/${GEN}/image?attempt=1`,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a missing-image state without requesting anything when there is no output", () => {
    renderPreview({ hasOutput: false });
    expect(screen.getByRole("img", { name: "No image available" })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["fi", "Luotu kuva"],
    ["ar", "صورة مُنشأة"],
  ])("is translated (%s) and renders inside an RTL container", (locale, alt) => {
    renderPreview({ hasOutput: true }, locale);
    expect(screen.getByRole("img", { name: alt })).toBeTruthy();
  });

  it("encodes the id into the route and never accepts a URL or path", () => {
    expect(generatedImageSrc("a/../b")).toBe("/api/v1/creator-studio/generations/a%2F..%2Fb/image");
    expect(generatedImageSrc(GEN, 2)).toBe(
      `/api/v1/creator-studio/generations/${GEN}/image?attempt=2`,
    );
  });
});
