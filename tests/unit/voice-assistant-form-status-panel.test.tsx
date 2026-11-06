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

  const assistant = {
    id: "a1",
    isActive: false,
    phoneNumber: "+358401234567",
    name: "Reception",
    language: "FI" as const,
    voiceProvider: "azure" as const,
    voiceId: "",
    firstMessage: "Hei",
    systemPrompt: "Olet avulias.",
    enabledTools: [],
    useKnowledgeBase: false,
    transferNumber: "",
    recording: "off" as const,
  };

  it("keeps the recording status outside the settings form, which can't hold a form", () => {
    const html = renderToStaticMarkup(
      <AssistantForm initial={assistant} recordingStatus={<p>recording-status</p>} />,
    );
    const status = html.indexOf("recording-status");
    expect(status).toBeGreaterThan(-1);
    expect(status).toBeLessThan(html.indexOf('name="name"'));
    const settingsForm = html.lastIndexOf("<form", html.indexOf('name="name"'));
    expect(status).toBeLessThan(settingsForm);
  });

  it("says Vapi still holds an assistant it failed to delete, and offers deactivating again", () => {
    const html = renderToStaticMarkup(<AssistantForm initial={assistant} deactivationIncomplete />);
    expect(html).toContain("deactivateIncomplete");
    expect(html).toContain(">deactivate<");
  });

  it("offers no deactivation for an assistant that's simply off", () => {
    const html = renderToStaticMarkup(<AssistantForm initial={assistant} />);
    expect(html).not.toContain("deactivateIncomplete");
    expect(html).not.toContain(">deactivate<");
  });
});
