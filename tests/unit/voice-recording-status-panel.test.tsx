import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import fi from "../../messages/fi.json";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/actions/voice", () => ({ retryAssistantSyncAction: async () => ({}) }));

import { RecordingStatusPanel } from "@/components/voice/recording-status-panel";

const panel = (over: Partial<Parameters<typeof RecordingStatusPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <RecordingStatusPanel
      assistantId="assistant-1"
      kind="failed"
      requested={false}
      reportedByVapi={null}
      lastAccepted={null}
      {...over}
    />,
  );

describe("the recording status panel", () => {
  it("shows a failed setting as an alert, apart from what was asked for, with a way to retry", () => {
    const html = panel({ lastAccepted: { enabled: true, at: "6 Nov 2026, 12:00" } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("failed.title");
    expect(html).toContain("requestedLabel");
    expect(html).toContain("valueOff");
    expect(html).toContain("lastAcceptedLabel");
    expect(html).toContain("valueOn");
    expect(html).toContain("sendAgain");
  });

  it.each(["uncertain", "mismatch", "unreadable"] as const)("offers a retry when %s", (kind) => {
    const html = panel({ kind });
    expect(html).toContain('role="alert"');
    expect(html).toContain("sendAgain");
  });

  it("asks for a review of an assistant never set here, and has nothing to resend", () => {
    const html = panel({ kind: "needsReview", requested: null });
    expect(html).toContain('role="alert"');
    expect(html).toContain("needsReview.title");
    expect(html).not.toContain("requestedLabel");
    expect(html).not.toContain("sendAgain");
  });

  it("shows what Vapi reports for such an assistant, without treating it as a choice", () => {
    const html = panel({ kind: "needsReview", requested: null, reportedByVapi: true });
    expect(html).toContain("reportedLabel");
    expect(html).toContain("valueOn");
  });

  it("doesn't raise an alert or offer a retry once accepted", () => {
    const html = panel({ kind: "applied" });
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("sendAgain");
  });

  it("shows nothing for an assistant not connected yet", () => {
    expect(panel({ kind: "notConnected" })).toBe("");
  });

  it("has every state's text in FI, EN and AR", () => {
    const kinds = [
      "needsReview",
      "unreadable",
      "mismatch",
      "failed",
      "uncertain",
      "pending",
      "applied",
    ];
    for (const messages of [en, fi, ar]) {
      const status = messages.voice.recording.status as unknown as Record<
        string,
        { title?: string; body?: string }
      >;
      for (const kind of kinds) {
        expect(status[kind]?.title, kind).toBeTruthy();
        expect(status[kind]?.body, kind).toBeTruthy();
      }
    }
  });
});
