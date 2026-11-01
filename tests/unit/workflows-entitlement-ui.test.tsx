// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * Observed on FREE: a saved workflow listed as "contact.created · 0 runs", the
 * activation switch silently did nothing, and only "Run test" explained that
 * the plan excludes workflows. The list and the editor now explain the plan
 * limit up front, the switch is disabled with an accessible reason, and a
 * server refusal is reported instead of swallowed. Server entitlement checks
 * are unchanged (toggleWorkflowAction/testWorkflowAction still decide).
 *
 * Real: the workflows list page, WorkflowToggle, WorkflowBuilder, the
 * activation helper and the EN/FI/AR messages. Mocked: auth, data services,
 * entitlements (synthetic plans) and the server actions.
 */
const state = vi.hoisted(() => ({
  locale: "en" as "en" | "fi" | "ar",
  role: "OWNER" as "OWNER" | "MEMBER",
  entitlements: { readOnly: false, activeWorkflows: 0 } as
    { readOnly: boolean; activeWorkflows: number } | Error,
  workflows: [] as Array<Record<string, unknown>>,
}));
const actions = vi.hoisted(() => ({
  toggleWorkflowAction: vi.fn(async () => ({ error: "quota" }) as { error?: string }),
  saveWorkflowAction: vi.fn(async () => ({ error: "invalid_input" }) as { error?: string }),
  testWorkflowAction: vi.fn(async () => ({ error: "quota" }) as { error?: string }),
}));

const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES = { en: load("en"), fi: load("fi"), ar: load("ar") };

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  return {
    getLocale: vi.fn(async () => state.locale),
    getTranslations: vi.fn(async (namespace?: string) =>
      createTranslator({
        locale: state.locale,
        messages: MESSAGES[state.locale],
        namespace,
      } as never),
    ),
  };
});
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: state.role,
  })),
}));
vi.mock("@/server/services/workflows", () => ({
  listWorkflows: vi.fn(async () => state.workflows),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  getEntitlements: vi.fn(async () => {
    if (state.entitlements instanceof Error) throw state.entitlements;
    return state.entitlements;
  }),
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    user: { findUnique: vi.fn(async () => ({ timezone: "Europe/Helsinki" })) },
  },
}));
vi.mock("@/actions/workflows", () => actions);
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import WorkflowsPage from "@/app/[locale]/(app)/workflows/page";
import { WorkflowBuilder } from "@/components/workflows/workflow-builder";
import { workflowActivationBlock } from "@/lib/workflows/activation";

const workflow = (overrides: Record<string, unknown> = {}) => ({
  id: "wf-1",
  name: "Welcome new contact",
  isActive: false,
  trigger: { type: "contact.created" },
  runs: [],
  _count: { runs: 0 },
  ...overrides,
});

function withIntl(node: React.ReactNode, locale: "en" | "fi" | "ar") {
  return (
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Europe/Helsinki">
      <div dir={locale === "ar" ? "rtl" : "ltr"}>{node}</div>
    </NextIntlClientProvider>
  );
}

async function renderList(locale: "en" | "fi" | "ar" = "en") {
  state.locale = locale;
  return render(withIntl(await WorkflowsPage(), locale));
}

beforeEach(() => {
  state.locale = "en";
  state.role = "OWNER";
  state.entitlements = { readOnly: false, activeWorkflows: 0 };
  state.workflows = [workflow()];
  Object.values(actions).forEach((a) => a.mockClear());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workflowActivationBlock", () => {
  it("classifies plan, read-only and limit states", () => {
    expect(workflowActivationBlock({ readOnly: false, activeWorkflows: 0 }, 0)).toBe(
      "not_included",
    );
    expect(workflowActivationBlock({ readOnly: true, activeWorkflows: 5 }, 0)).toBe("read_only");
    expect(workflowActivationBlock({ readOnly: false, activeWorkflows: 5 }, 5)).toBe(
      "limit_reached",
    );
    expect(workflowActivationBlock({ readOnly: false, activeWorkflows: 5 }, 4)).toBeNull();
  });
});

describe("workflows list on a plan without workflows", () => {
  it.each(["en", "fi", "ar"] as const)(
    "explains the plan limit and disables activation with an accessible reason (%s)",
    async (locale) => {
      await renderList(locale);
      const m = MESSAGES[locale].workflows;
      const notice = screen.getByText(m.entitlement.notIncluded);
      const toggle = screen.getByRole("switch", {
        name: m.toggleLabel.replace("{name}", "Welcome new contact"),
      });
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
      expect(toggle.getAttribute("aria-describedby")).toBe(notice.id);
      expect(toggle.getAttribute("title")).toBe(m.entitlement.activationUnavailable);
      expect(screen.getByRole("link", { name: m.entitlement.viewPlans }).getAttribute("href")).toBe(
        "/settings/billing",
      );
    },
  );

  it("shows a localized trigger and run count instead of internal codes", async () => {
    await renderList("en");
    expect(screen.getByText(/Contact created · 0 runs/)).toBeTruthy();
    expect(screen.queryByText(/contact\.created/)).toBeNull();
    cleanup();
    await renderList("fi");
    expect(screen.getByText(/Kontakti luotu · 0 ajoa/)).toBeTruthy();
  });

  it("still lets an already active workflow be switched off", async () => {
    state.workflows = [workflow({ isActive: true })];
    await renderList("en");
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides the billing link from roles that cannot open billing", async () => {
    state.role = "MEMBER";
    await renderList("en");
    expect(screen.getByText(MESSAGES.en.workflows.entitlement.notIncluded)).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: MESSAGES.en.workflows.entitlement.viewPlans }),
    ).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("workflows list on other plans", () => {
  it("shows no notice and an enabled switch when activation is available", async () => {
    state.entitlements = { readOnly: false, activeWorkflows: 5 };
    await renderList("en");
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains a full plan", async () => {
    state.entitlements = { readOnly: false, activeWorkflows: 1 };
    state.workflows = [workflow({ id: "wf-on", isActive: true }), workflow()];
    await renderList("en");
    expect(screen.getByRole("status").textContent).toContain(
      "Your plan's 1 active workflow is in use. Deactivate one or upgrade your plan to activate another.",
    );
    const [on, off] = screen.getAllByRole("switch");
    expect((on as HTMLButtonElement).disabled).toBe(false);
    expect((off as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a read-only workspace", async () => {
    state.entitlements = { readOnly: true, activeWorkflows: 5 };
    await renderList("ar");
    expect(screen.getByText(MESSAGES.ar.workflows.entitlement.readOnly)).toBeTruthy();
  });

  it("leaves the decision to the server when entitlements cannot be read", async () => {
    state.entitlements = new Error("redis down");
    await renderList("en");
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("WorkflowToggle server refusal", () => {
  it("reverts and says why when the server refuses activation", async () => {
    state.entitlements = { readOnly: false, activeWorkflows: 5 };
    await renderList("fi");
    const toggle = screen.getByRole("switch");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(actions.toggleWorkflowAction).toHaveBeenCalledWith("wf-1", true);
    expect((await screen.findByRole("alert")).textContent).toContain(
      MESSAGES.fi.workflows.entitlement.activationUnavailable,
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

const addStepButton = (locale: "en" | "fi" | "ar", type: string) => {
  const label = type.split(".").reduce((m, k) => m[k], MESSAGES[locale].workflows.stepTypes);
  // A step card can show the same label; the add-step buttons come last.
  return screen.getAllByRole("button", { name: label }).at(-1) as HTMLButtonElement;
};

describe("WorkflowBuilder", () => {
  const initial = {
    id: "wf-1",
    name: "Welcome new contact",
    description: "",
    trigger: { type: "contact.created" as const },
    steps: [{ id: "s1", type: "notify.member" as const, title: "Hi" }],
    isActive: false,
    runs: [
      {
        id: "r1",
        status: "FAILED",
        startedAt: "2026-10-24T21:30:00.000Z",
        failure: null,
      },
    ],
  };

  it("shows the plan notice before building and disables the test run with a reason", () => {
    render(
      withIntl(
        <WorkflowBuilder
          initial={initial as never}
          activation={{ block: "not_included", limit: 0 }}
          timeZone="Europe/Helsinki"
          canViewPlans
        />,
        "en",
      ),
    );
    const notice = screen.getByText(MESSAGES.en.workflows.entitlement.notIncluded);
    const testRun = screen.getByRole("button", { name: "Test run" });
    expect((testRun as HTMLButtonElement).disabled).toBe(true);
    expect(testRun.getAttribute("aria-describedby")).toBe(notice.id);
  });

  it.each(["en", "fi", "ar"] as const)(
    "an internal-only workspace offers only internal steps and says why (%s)",
    (locale) => {
      render(
        withIntl(
          <WorkflowBuilder
            initial={initial as never}
            activation={{ block: null, limit: 1 }}
            timeZone="Europe/Helsinki"
            internalOnly
          />,
          locale,
        ),
      );
      const hint = screen.getByText(MESSAGES[locale].workflows.internalOnlyHint);
      for (const blocked of ["ai.generate", "email.send", "wait.duration"]) {
        const button = addStepButton(locale, blocked) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.getAttribute("aria-describedby")).toBe(hint.id);
      }
      for (const allowed of ["condition", "crm.create_activity", "notify.member"]) {
        const button = addStepButton(locale, allowed) as HTMLButtonElement;
        expect(button.disabled).toBe(false);
      }
      cleanup();
    },
  );

  it("an unrestricted workspace offers every step without the hint", () => {
    render(
      withIntl(
        <WorkflowBuilder
          initial={initial as never}
          activation={{ block: null, limit: 1 }}
          timeZone="Europe/Helsinki"
        />,
        "en",
      ),
    );
    expect((addStepButton("en", "email.send") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(MESSAGES.en.workflows.internalOnlyHint)).toBeNull();
  });

  it("shows run history in the viewer's zone with a localized status", () => {
    render(
      withIntl(
        <WorkflowBuilder
          initial={initial as never}
          activation={{ block: null, limit: 5 }}
          timeZone="Europe/Helsinki"
        />,
        "fi",
      ),
    );
    expect(screen.getByText("Epäonnistui")).toBeTruthy();
    // 21:30 UTC on 24 Oct is 00:30 on 25 Oct in Helsinki (EEST, before the DST change).
    expect(screen.getByText(/25\.10\.2026.*0\.30\.00/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["en", "fi", "ar"] as const)(
    "shows a failed run's reason as localized text, not the stored error (%s)",
    (locale) => {
      render(
        withIntl(
          <WorkflowBuilder
            initial={
              {
                ...initial,
                runs: [{ ...initial.runs[0], failure: "contact_missing_test_run" }],
              } as never
            }
            activation={{ block: null, limit: 5 }}
            timeZone="Europe/Helsinki"
          />,
          locale,
        ),
      );
      expect(
        screen.getByText(MESSAGES[locale].workflows.runFailure.contact_missing_test_run),
      ).toBeTruthy();
    },
  );

  it("shows a canceled run's reason and no reason while a run is in progress", () => {
    render(
      withIntl(
        <WorkflowBuilder
          initial={
            {
              ...initial,
              runs: [
                {
                  ...initial.runs[0],
                  id: "r1",
                  status: "CANCELED",
                  failure: "workflow_deactivated",
                },
                { ...initial.runs[0], id: "r2", status: "RUNNING", failure: "internal" },
              ],
            } as never
          }
          activation={{ block: null, limit: 5 }}
          timeZone="Europe/Helsinki"
        />,
        "en",
      ),
    );
    const m = MESSAGES.en.workflows.runFailure;
    expect(screen.getByText(m.workflow_deactivated)).toBeTruthy();
    expect(screen.queryByText(m.internal)).toBeNull();
  });

  it("every run failure code has EN/FI/AR text", async () => {
    const { WORKFLOW_RUN_FAILURES } = await import("@/lib/workflows/run-failure");
    for (const locale of ["en", "fi", "ar"] as const) {
      for (const code of WORKFLOW_RUN_FAILURES) {
        expect(MESSAGES[locale].workflows.runFailure[code], `${locale}.${code}`).toBeTruthy();
      }
    }
  });

  it("maps save errors to localized messages, never raw codes", async () => {
    render(
      withIntl(
        <WorkflowBuilder
          initial={initial as never}
          activation={{ block: null, limit: 5 }}
          timeZone="Europe/Helsinki"
        />,
        "ar",
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.ar.common.save }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      MESSAGES.ar.workflows.saveErrors.invalid_input,
    );
    actions.saveWorkflowAction.mockResolvedValueOnce({ error: "Expected string, received number" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.ar.common.save }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain(MESSAGES.ar.common.error);
  });
});
