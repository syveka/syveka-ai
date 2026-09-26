import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";
import type { ChatStreamEvent } from "../../src/lib/validators/chat";

/**
 * Assistant voice mode, end to end in a real browser on both the desktop and
 * the Pixel 7 (mobile) projects. Zero cost by construction:
 * - The Web Speech API and microphone are replaced before any page script
 *   runs — no real audio, no browser speech service.
 * - `/api/v1/ai/chat` is answered in the browser (same as the chat smoke
 *   test), so no billed model call is ever made. No "meta" event, so the
 *   client stays on /chat.
 */

const TRANSCRIPT = "Milloin olette auki?";
const REPLY = "Olemme auki arkisin yhdeksästä viiteen.";

test.describe("assistant voice mode", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ transcript }) => {
        const w = window as unknown as Record<string, unknown>;
        (w as { __spoken: string[] }).__spoken = [];
        let listenCount = 0;

        class FakeRecognition {
          lang = "";
          interimResults = false;
          continuous = false;
          maxAlternatives = 1;
          onresult: ((e: unknown) => void) | null = null;
          onerror: ((e: unknown) => void) | null = null;
          onend: (() => void) | null = null;
          start() {
            listenCount += 1;
            // Only the first listen "hears" something; later listens stay
            // open, leaving the session in the listening state.
            if (listenCount !== 1) return;
            setTimeout(() => {
              this.onresult?.({
                resultIndex: 0,
                results: [Object.assign([{ transcript }], { isFinal: true })],
              });
              this.onend?.();
            }, 50);
          }
          stop() {
            this.onend?.();
          }
          abort() {
            this.onend?.();
          }
        }
        w.SpeechRecognition = FakeRecognition;
        w.webkitSpeechRecognition = FakeRecognition;

        const fakeSynth = {
          speak(u: { text: string; onend?: () => void }) {
            if (u.text) (w as { __spoken: string[] }).__spoken.push(u.text);
            setTimeout(() => u.onend?.(), 50);
          },
          cancel() {},
          getVoices: () => [],
        };
        Object.defineProperty(window, "speechSynthesis", { value: fakeSynth, configurable: true });
        Object.defineProperty(navigator, "mediaDevices", {
          value: { getUserMedia: async () => ({ getTracks: () => [] }) },
          configurable: true,
        });
      },
      { transcript: TRANSCRIPT },
    );

    await openAuthenticatedE2EDashboard(page);
  });

  test("talks to the assistant hands-free and ends cleanly", async ({ page }) => {
    const requests: Array<Record<string, unknown>> = [];
    await page.route("**/api/v1/ai/chat", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      const events: ChatStreamEvent[] = [
        { type: "text", delta: REPLY },
        { type: "done", tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 },
      ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      });
    });

    await page.goto("/chat");
    await page.getByTestId("start-voice").click();

    const panel = page.getByTestId("voice-session-panel");
    await expect(panel).toBeVisible();
    // One full turn, then back to listening for the next one.
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
    expect(requests[0]).toMatchObject({ message: TRANSCRIPT, responseMode: "voice" });
    expect(requests[0]).not.toHaveProperty("orgId");
    await expect(panel).toHaveAttribute("data-status", "listening", { timeout: 15_000 });
    expect(
      await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken),
    ).toEqual([REPLY]);

    // Controls stay reachable inside the viewport (mobile priority).
    const viewport = page.viewportSize()!;
    for (const name of [/mykistä mikrofoni|mute microphone/i, /lopeta puhekeskustelu|end voice/i]) {
      const box = await panel.getByRole("button", { name }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await panel.getByRole("button", { name: /mykistä mikrofoni|mute microphone/i }).click();
    await expect(panel).toHaveAttribute("data-status", "muted");

    await panel.getByRole("button", { name: /lopeta puhekeskustelu|end voice/i }).click();
    await expect(panel).toBeHidden();
    // The spoken exchange is kept in the normal chat thread.
    await expect(page.getByText(TRANSCRIPT)).toBeVisible();
    await expect(page.getByText(REPLY)).toBeVisible();
  });
});
