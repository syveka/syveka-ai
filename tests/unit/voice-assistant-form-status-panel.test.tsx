import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** The real form, so removing its slot for the readiness panel would fail here. */
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/actions/voice", () => ({
  saveAssistantAction: async () => ({}),
  activateAssistantAction: async () => ({}),
  deactivateAssistantAction: async () => ({}),
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/voice/attach-phone-number-form", () => ({
  AttachPhoneNumberForm: () => null,
}));

import { AssistantForm } from "@/components/voice/assistant-form";

describe("the assistant form", () => {
  it("shows the status panel under the heading and above the settings", () => {
    const html = renderToStaticMarkup(<AssistantForm statusPanel={<p>status-panel</p>} />);
    const panel = html.indexOf("status-panel");
    expect(panel).toBeGreaterThan(html.indexOf("</h1>"));
    expect(panel).toBeLessThan(html.indexOf('type="submit"'));
  });
});
