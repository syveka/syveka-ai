import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/generated/prisma/client/client";
import type * as GuardModule from "@/server/auth/guard";

/**
 * Every contact, company and deal Server Action asks for its exact permission,
 * and the real guard applies the real matrix: a denied role throws 403 before
 * the rate limiter or service runs. Only the session (which supplies the role),
 * audit, rate limiter and services are fakes; requirePermission is a spy around
 * the real function.
 */
const s = vi.hoisted(() => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly status: 401 | 403 = 401,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  return {
    AuthError,
    role: "OWNER" as string,
    audit: vi.fn(),
    actionWriteLimitError: vi.fn(async () => null),
    services: {
      createContact: vi.fn(),
      updateContact: vi.fn(),
      archiveContact: vi.fn(),
      restoreContact: vi.fn(),
      deleteContact: vi.fn(),
      addContactNote: vi.fn(),
      createCompany: vi.fn(),
      updateCompany: vi.fn(),
      archiveCompany: vi.fn(),
      restoreCompany: vi.fn(),
      deleteCompany: vi.fn(),
      addCompanyNote: vi.fn(),
      createDeal: vi.fn(),
      updateDeal: vi.fn(),
      moveDeal: vi.fn(),
      deleteDeal: vi.fn(),
      addDealNote: vi.fn(),
      addDealTask: vi.fn(),
      toggleDealTask: vi.fn(),
      generateDealInsights: vi.fn(),
      createStage: vi.fn(),
      updateStage: vi.fn(),
      deleteStage: vi.fn(),
    },
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  AuthError: s.AuthError,
  getTenantContext: vi.fn(async () => ({
    userId: "user-1",
    email: "user@example.test",
    orgId: "org-1",
    role: s.role,
    locale: "en",
  })),
}));
vi.mock("@/server/auth/guard", async (importActual) => {
  const actual = await importActual<typeof GuardModule>();
  return { ...actual, requirePermission: vi.fn(actual.requirePermission) };
});
vi.mock("@/server/services/audit", () => ({ audit: s.audit }));
vi.mock("@/server/security/rate-limit", () => ({
  actionWriteLimitError: s.actionWriteLimitError,
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/ai-spend", () => ({
  AiSpendError: class AiSpendError extends Error {},
  assertAiSpendAllowed: vi.fn(),
  recordAiSpend: vi.fn(),
}));
vi.mock("@/server/services/contacts", () => ({
  createContact: s.services.createContact,
  updateContact: s.services.updateContact,
  archiveContact: s.services.archiveContact,
  restoreContact: s.services.restoreContact,
  deleteContact: s.services.deleteContact,
  addContactNote: s.services.addContactNote,
}));
vi.mock("@/server/services/companies", () => ({
  createCompany: s.services.createCompany,
  updateCompany: s.services.updateCompany,
  archiveCompany: s.services.archiveCompany,
  restoreCompany: s.services.restoreCompany,
  deleteCompany: s.services.deleteCompany,
  addCompanyNote: s.services.addCompanyNote,
}));
vi.mock("@/server/services/deals", () => ({
  DealError: class DealError extends Error {},
  createDeal: s.services.createDeal,
  updateDeal: s.services.updateDeal,
  moveDeal: s.services.moveDeal,
  deleteDeal: s.services.deleteDeal,
  addDealNote: s.services.addDealNote,
  addDealTask: s.services.addDealTask,
  toggleDealTask: s.services.toggleDealTask,
  generateDealInsights: s.services.generateDealInsights,
  createStage: s.services.createStage,
  updateStage: s.services.updateStage,
  deleteStage: s.services.deleteStage,
}));

import {
  addContactNoteAction,
  archiveContactAction,
  createContactAction,
  deleteContactAction,
  restoreContactAction,
  updateContactAction,
} from "@/actions/contacts";
import {
  addCompanyNoteAction,
  archiveCompanyAction,
  createCompanyAction,
  deleteCompanyAction,
  restoreCompanyAction,
  updateCompanyAction,
} from "@/actions/companies";
import {
  addDealNoteAction,
  addDealTaskAction,
  createDealAction,
  createStageAction,
  deleteDealAction,
  deleteStageAction,
  generateDealInsightsAction,
  moveDealAction,
  toggleDealTaskAction,
  updateDealAction,
  updateStageAction,
} from "@/actions/deals";
import { requirePermission } from "@/server/auth/guard";
import { can, type Permission } from "@/server/auth/permissions";

const ROLES: Role[] = ["OWNER", "ADMIN", "MANAGER", "MEMBER", "VIEWER"];
const ID = "11111111-1111-4111-8111-111111111111";
const STAGE_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const contactForm = () => form({ firstName: "Ada" });
const companyForm = () => form({ name: "Acme Oy" });
const dealForm = () => form({ title: "ERP rollout", stageId: STAGE_ID });
const noteForm = () => form({ body: "Called them" });
const taskForm = () => form({ title: "Send proposal" });
const stageForm = () => form({ name: "Demo" });

type ActionRow = {
  name: string;
  permission: Permission;
  service: keyof typeof s.services;
  invoke: () => Promise<unknown>;
};

const actions: ActionRow[] = [
  {
    name: "createContactAction",
    permission: "crm:write",
    service: "createContact",
    invoke: () => createContactAction({}, contactForm()),
  },
  {
    name: "updateContactAction",
    permission: "crm:write",
    service: "updateContact",
    invoke: () => updateContactAction(ID, {}, contactForm()),
  },
  {
    name: "archiveContactAction",
    permission: "crm:write",
    service: "archiveContact",
    invoke: () => archiveContactAction(ID),
  },
  {
    name: "restoreContactAction",
    permission: "crm:write",
    service: "restoreContact",
    invoke: () => restoreContactAction(ID),
  },
  {
    name: "deleteContactAction",
    permission: "crm:delete",
    service: "deleteContact",
    invoke: () => deleteContactAction(ID),
  },
  {
    name: "addContactNoteAction",
    permission: "crm:write",
    service: "addContactNote",
    invoke: () => addContactNoteAction(ID, {}, noteForm()),
  },
  {
    name: "createCompanyAction",
    permission: "crm:write",
    service: "createCompany",
    invoke: () => createCompanyAction({}, companyForm()),
  },
  {
    name: "updateCompanyAction",
    permission: "crm:write",
    service: "updateCompany",
    invoke: () => updateCompanyAction(ID, {}, companyForm()),
  },
  {
    name: "archiveCompanyAction",
    permission: "crm:write",
    service: "archiveCompany",
    invoke: () => archiveCompanyAction(ID),
  },
  {
    name: "restoreCompanyAction",
    permission: "crm:write",
    service: "restoreCompany",
    invoke: () => restoreCompanyAction(ID),
  },
  {
    name: "deleteCompanyAction",
    permission: "crm:delete",
    service: "deleteCompany",
    invoke: () => deleteCompanyAction(ID),
  },
  {
    name: "addCompanyNoteAction",
    permission: "crm:write",
    service: "addCompanyNote",
    invoke: () => addCompanyNoteAction(ID, {}, noteForm()),
  },
  {
    name: "createDealAction",
    permission: "crm:write",
    service: "createDeal",
    invoke: () => createDealAction({}, dealForm()),
  },
  {
    name: "updateDealAction",
    permission: "crm:write",
    service: "updateDeal",
    invoke: () => updateDealAction(ID, {}, dealForm()),
  },
  {
    name: "moveDealAction",
    permission: "crm:write",
    service: "moveDeal",
    invoke: () => moveDealAction({ dealId: ID, stageId: STAGE_ID, position: 0 }),
  },
  {
    name: "deleteDealAction",
    permission: "crm:delete",
    service: "deleteDeal",
    invoke: () => deleteDealAction(ID),
  },
  {
    name: "addDealNoteAction",
    permission: "crm:write",
    service: "addDealNote",
    invoke: () => addDealNoteAction(ID, {}, noteForm()),
  },
  {
    name: "addDealTaskAction",
    permission: "crm:write",
    service: "addDealTask",
    invoke: () => addDealTaskAction(ID, {}, taskForm()),
  },
  {
    name: "toggleDealTaskAction",
    permission: "crm:write",
    service: "toggleDealTask",
    invoke: () => toggleDealTaskAction(ID, TASK_ID, true),
  },
  {
    name: "generateDealInsightsAction",
    permission: "crm:write",
    service: "generateDealInsights",
    invoke: () => generateDealInsightsAction(ID, {}, form({})),
  },
  {
    name: "createStageAction",
    permission: "crm:manage-pipeline",
    service: "createStage",
    invoke: () => createStageAction({}, stageForm()),
  },
  {
    name: "updateStageAction",
    permission: "crm:manage-pipeline",
    service: "updateStage",
    invoke: () => updateStageAction(STAGE_ID, {}, stageForm()),
  },
  {
    name: "deleteStageAction",
    permission: "crm:manage-pipeline",
    service: "deleteStage",
    invoke: () => deleteStageAction(STAGE_ID),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  s.role = "OWNER";
});

describe("the CRM permission matrix", () => {
  it.each<[Permission, Role[]]>([
    ["crm:write", ["VIEWER"]],
    ["crm:delete", ["MEMBER", "VIEWER"]],
    ["crm:manage-pipeline", ["MEMBER", "VIEWER"]],
  ])("%s is denied to exactly %j", (permission, denied) => {
    for (const role of ROLES) expect(can(role, permission)).toBe(!denied.includes(role));
  });
});

describe.each(actions)("$name", ({ permission, service, invoke }) => {
  it(`asks for exactly ${permission}, once, and reaches its service`, async () => {
    await invoke();

    expect(requirePermission).toHaveBeenCalledTimes(1);
    expect(requirePermission).toHaveBeenCalledWith(permission);
    expect(s.services[service]).toHaveBeenCalledTimes(1);
  });

  it.each(ROLES)("treats %s as the real matrix says", async (role) => {
    s.role = role;

    if (can(role, permission)) {
      await invoke();
      expect(s.services[service]).toHaveBeenCalledTimes(1);
      expect(s.audit).not.toHaveBeenCalled();
      return;
    }

    await expect(invoke()).rejects.toMatchObject({ status: 403 });
    expect(s.services[service]).not.toHaveBeenCalled();
    expect(s.actionWriteLimitError).not.toHaveBeenCalled();
    expect(s.audit).toHaveBeenCalledTimes(1);
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1" }), {
      action: "authz.denied",
      resourceType: "permission",
      resourceId: permission,
    });
  });
});
