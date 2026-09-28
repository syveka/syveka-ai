// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { UsageMeters } from "@/components/billing/usage-meters";

/**
 * In an RTL page an unisolated "0 / 25" is laid out by the bidi algorithm as
 * "25 / 0" (the numbers and the neutral " / " become right-to-left runs).
 * The ratio must be an LTR-isolated element; the row itself must not be
 * forced LTR, so label/ratio placement still follows the page direction.
 * jsdom has no layout: visual order is verified in real Chromium separately.
 */
const ITEMS = [
  { label: "AI", used: 0, limit: 25 },
  { label: "Contacts", used: 1234, limit: 5000 },
  { label: "Seats", used: 1, limit: 2 },
  { label: "Unlimited", used: 48213, limit: Number.MAX_SAFE_INTEGER },
];

afterEach(cleanup);

function ratios(locale: string) {
  const { container } = render(
    <div dir={locale === "ar" ? "rtl" : "ltr"}>
      <UsageMeters items={ITEMS} locale={locale} />
    </div>,
  );
  return [...container.querySelectorAll(".mb-1.flex.justify-between")].map((row) => ({
    row,
    ratio: row.lastElementChild as HTMLElement,
  }));
}

describe("UsageMeters ratio direction", () => {
  it.each(["ar", "fi", "en"])("isolates only the used / limit ratio as LTR (%s)", (locale) => {
    for (const { row, ratio } of ratios(locale)) {
      expect(ratio.getAttribute("dir")).toBe("ltr");
      expect(row.getAttribute("dir")).toBeNull();
      expect((row.firstElementChild as HTMLElement).getAttribute("dir")).toBeNull();
    }
  });

  it("keeps values, order and the unlimited marker unchanged (Latin digits in Arabic)", () => {
    const text = ratios("ar").map(({ ratio }) => ratio.textContent!.replace(/[\s  ]+/g, " "));
    expect(text[0]).toBe("0 / 25");
    expect(text[1]).toMatch(/^1.?234 \/ 5.?000$/);
    expect(text[2]).toBe("1 / 2");
    expect(text[3]).toMatch(/^48.?213 \/ ∞$/);
    expect(text.join("")).not.toMatch(/[٠-٩]/);
  });

  it("leaves the progress bars' widths unchanged", () => {
    const { container } = render(<UsageMeters items={ITEMS} locale="ar" />);
    const widths = [...container.querySelectorAll<HTMLElement>(".h-full.rounded-full")].map(
      (b) => b.style.width,
    );
    expect(widths).toEqual(["0%", "25%", "50%", "0%"]);
  });
});
