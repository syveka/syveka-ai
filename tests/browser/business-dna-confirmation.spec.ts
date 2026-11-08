/**
 * The chat's Business DNA confirmation card in a real browser (Chromium;
 * desktop and Pixel 7), with the real ActionConfirmation component, the app's
 * compiled CSS and the real locale messages. The decision endpoint
 * (POST /api/v1/ai/actions/{id}) is answered by the test, following the real
 * route's request schema and response shapes (src/app/api/v1/ai/actions/[id]).
 *
 * Proves what the owner sees and can do: before/after values are shown, nothing
 * happens until Confirm, Cancel changes nothing, a double tap sends one
 * decision, a lost answer can be retried and shows the first decision's
 * result, a change made elsewhere meanwhile is reported as stale, a refusal is
 * explained, and the card fits a phone screen in Arabic (RTL) and Finnish.
 * Does not prove the server side (tool-action and Business DNA patch tests do),
 * nor the deployed chat page (staging).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { horizontalOverflow, openHarness, readMessages } from "./harness/harness-page";

const NOW = new Date("2027-03-24T08:00:00.000Z");
const ACTION_ID = "6f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
const CONVERSATION_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DIGEST = "a".repeat(64);

type ActionMessages = {
  confirm: string;
  cancel: string;
  tryAgain: string;
  nothingYet: string;
  businessDna: { review: string; before: string; after: string };
  result: Record<"done" | "canceled" | "stale" | "permission" | "noAnswer", string>;
};
const actions = (locale: string) =>
  (readMessages(locale) as { chat: { actions: ActionMessages } }).chat.actions;

const proposal = {
  id: ACTION_ID,
  tool: "proposeBusinessDnaUpdate",
  digest: DIGEST,
  conversationId: CONVERSATION_ID,
  expiresAt: NOW.getTime() + 10 * 60_000,
  details: {
    tool: "proposeBusinessDnaUpdate",
    changes: [
      {
        field: "openingHours",
        kind: "modified",
        before: {
          type: "hours",
          days: [{ day: "saturday", closed: false, open: "10:00", close: "16:00" }],
        },
        after: {
          type: "hours",
          days: [{ day: "saturday", closed: false, open: "10:00", close: "14:00" }],
        },
      },
      {
        field: "description",
        kind: "modified",
        before: { type: "text", value: "Parturi Helsingissä" },
        after: {
          type: "text",
          value: "Parturi-kampaamo Helsingin Kalliossa, ajanvaraus verkossa ja puhelimitse",
        },
      },
    ],
    missingAfter: [],
  },
};

type Decision = { decision: "confirm" | "cancel"; conversationId: string; digest: string };

/**
 * The decision endpoint. `answer` decides the reply for each request; the
 * endpoint records every request and how many times a decision was applied.
 */
async function fakeDecisions(
  page: Page,
  answer: (decision: Decision, attempt: number, route: Route) => Promise<void>,
) {
  const seen: Decision[] = [];
  await page.route(`**/api/v1/ai/actions/${ACTION_ID}`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "null") as Decision;
    // The real route's schema: exactly these three fields.
    expect(Object.keys(body).sort()).toEqual(["conversationId", "decision", "digest"]);
    expect(body).toEqual({
      decision: expect.stringMatching(/^(confirm|cancel)$/),
      conversationId: CONVERSATION_ID,
      digest: DIGEST,
    });
    seen.push(body);
    await answer(body, seen.length, route);
  });
  return seen;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const open = (page: Page, locale: string) =>
  openHarness(page, { component: "action", locale, props: { action: proposal } }, NOW);

test("the harness answers only what a test handles; everything else is aborted", async ({
  page,
}) => {
  // Aborted by the harness: net::ERR_FAILED. A request that reached the
  // network instead would fail differently (e.g. ERR_NAME_NOT_RESOLVED).
  const failures = new Map<string, string>();
  page.on("requestfailed", (request) =>
    failures.set(new URL(request.url()).pathname, request.failure()?.errorText ?? ""),
  );
  await open(page, "en");
  await page.evaluate(() =>
    Promise.allSettled([fetch("/unhandled-path"), fetch("https://example.com/elsewhere")]),
  );
  expect(failures.get("/unhandled-path")).toBe("net::ERR_FAILED");
  expect(failures.get("/elsewhere")).toBe("net::ERR_FAILED");
});

test.describe("Arabic, right-to-left", () => {
  test.use({ locale: "ar", timezoneId: "Europe/Helsinki" });

  test("shows the change, fits the screen, and applies it only on Confirm", async ({ page }) => {
    const a = actions("ar");
    const seen = await fakeDecisions(page, (_d, _n, route) =>
      json(route, 200, { data: { ok: true, status: "done", tool: "proposeBusinessDnaUpdate" } }),
    );
    await open(page, "ar");

    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    await expect(page.getByText(a.nothingYet)).toBeVisible();
    await expect(page.getByText("Parturi Helsingissä")).toBeVisible();
    await expect(page.getByText(/Kalliossa/)).toBeVisible();
    await expect(page.getByText(/14:00/)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    // The app's CSS is applied (min-h-10): a touch target of at least 40 px.
    const box = await page.getByRole("button", { name: a.confirm }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(seen).toHaveLength(0);

    await page.getByRole("button", { name: a.confirm }).click();
    await expect(page.getByRole("status")).toHaveText(a.result.done);
    expect(seen.map((d) => d.decision)).toEqual(["confirm"]);
    await expect(page.getByRole("link", { name: a.businessDna.review })).toHaveAttribute(
      "href",
      "/settings/business-dna",
    );
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("Finnish", () => {
  test.use({ locale: "fi-FI", timezoneId: "Europe/Helsinki" });

  test("Cancel changes nothing", async ({ page }) => {
    const a = actions("fi");
    const seen = await fakeDecisions(page, (_d, _n, route) =>
      json(route, 200, {
        data: { ok: true, status: "canceled", tool: "proposeBusinessDnaUpdate" },
      }),
    );
    await open(page, "fi");
    await page.getByRole("button", { name: a.cancel }).click();
    await expect(page.getByRole("status")).toHaveText(a.result.canceled);
    expect(seen.map((d) => d.decision)).toEqual(["cancel"]);
    await expect(page.getByRole("button", { name: a.confirm })).toHaveCount(0);
  });

  test("a double tap on Confirm sends one decision", async ({ page }) => {
    const a = actions("fi");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const seen = await fakeDecisions(page, async (_d, _n, route) => {
      await held; // the answer is slow, so the second tap lands while the first is in flight
      await json(route, 200, {
        data: { ok: true, status: "done", tool: "proposeBusinessDnaUpdate" },
      });
    });
    await open(page, "fi");
    const confirm = page.getByRole("button", { name: a.confirm });
    await confirm.click();
    await confirm.click({ force: true });
    release();
    await expect(page.getByRole("status")).toHaveText(a.result.done);
    expect(seen).toHaveLength(1);
  });

  test("a lost answer can be sent again and shows the first decision's result", async ({
    page,
  }) => {
    const a = actions("fi");
    let applied = 0;
    const seen = await fakeDecisions(page, async (_d, attempt, route) => {
      if (attempt === 1) {
        applied += 1; // it ran on the server, but the answer never arrived
        return route.abort("connectionreset");
      }
      // The repeat is refused with the first decision's recorded outcome; nothing runs again.
      return json(route, 409, { error: { code: "already_decided", outcome: "done" } });
    });
    await open(page, "fi");
    await page.getByRole("button", { name: a.confirm }).click();
    await expect(page.getByRole("status")).toHaveText(a.result.noAnswer);
    await page.getByRole("button", { name: a.tryAgain }).click();
    await expect(page.getByRole("status")).toHaveText(a.result.done);
    expect(seen.map((d) => d.decision)).toEqual(["confirm", "confirm"]);
    expect(applied).toBe(1);
  });

  test("a change made elsewhere meanwhile is reported, not applied", async ({ page }) => {
    const a = actions("fi");
    await fakeDecisions(page, (_d, _n, route) =>
      json(route, 200, {
        data: { ok: true, status: "not_done", reason: "stale", tool: "proposeBusinessDnaUpdate" },
      }),
    );
    await open(page, "fi");
    await page.getByRole("button", { name: a.confirm }).click();
    await expect(page.getByRole("status")).toHaveText(a.result.stale);
  });

  test("a member without permission is told so, with nothing to retry", async ({ page }) => {
    const a = actions("fi");
    await fakeDecisions(page, (_d, _n, route) =>
      json(route, 403, { error: { code: "permission_denied" } }),
    );
    await open(page, "fi");
    await page.getByRole("button", { name: a.confirm }).click();
    await expect(page.getByRole("status")).toHaveText(a.result.permission);
    await expect(page.getByRole("button", { name: a.tryAgain })).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
