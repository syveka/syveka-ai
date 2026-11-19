import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * An inactive assistant whose Vapi assistant is still linked (a failed or
 * timed-out delete) must keep a Deactivate button so cleanup can be retried.
 */
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/actions/voice", () => ({
  saveAssistantAction: vi.fn(),
  activateAssistantAction: vi.fn(),
  deactivateAssistantAction: vi.fn(),
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/voice/attach-phone-number-form", () => ({
  AttachPhoneNumberForm: () => null,
}));

import { AssistantForm } from "@/components/voice/assistant-form";

const base = {
  id: "a-1",
  name: "Bot",
  language: "FI" as const,
  voiceProvider: "azure" as const,
  voiceId: "",
  firstMessage: "Hi",
  systemPrompt: "Be nice",
  enabledTools: [],
  useKnowledgeBase: false,
  transferNumber: "",
  phoneNumber: null,
};

function html(extra: { isActive: boolean; vapiLinked?: boolean }) {
  const initial: NonNullable<Parameters<typeof AssistantForm>[0]["initial"]> = {
    ...base,
    ...extra,
  };
  return renderToStaticMarkup(<AssistantForm initial={initial} />);
}

describe("AssistantForm deactivate button", () => {
  it("renders Deactivate for an inactive assistant that is still linked to Vapi", () => {
    const out = html({ isActive: false, vapiLinked: true });
    expect(out).toContain(">deactivate<");
    expect(out).toContain(">activate<");
  });

  it("renders Deactivate for an active assistant", () => {
    expect(html({ isActive: true, vapiLinked: true })).toContain(">deactivate<");
  });

  it("does not render Deactivate for an inactive, unlinked assistant", () => {
    const out = html({ isActive: false, vapiLinked: false });
    expect(out).not.toContain(">deactivate<");
    expect(out).toContain(">activate<");
  });
});
