// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * A refused member change (the members write limit, or a member-management
 * rule) is shown next to the member's controls. Before, a refused role
 * change looked saved and a refused removal replaced the whole page.
 * Mocked: the member server actions.
 */
const actions = vi.hoisted(() => ({
  changeRoleAction: vi.fn(),
  removeMemberAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
}));
vi.mock("@/actions/members", () => actions);

import { MembersTable } from "@/app/[locale]/(app)/settings/members/members-table";

type Messages = {
  settingsMembers: {
    remove: string;
    memberChangeFailed: string;
    revokeErrors: { rate_limited: string; service_unavailable: string };
  };
};
const read = (locale: string): Messages & Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"));

const member = {
  id: "33333333-3333-4333-8333-333333333333",
  userId: "user-2",
  email: "mira@example.test",
  name: "Mira",
  role: "MEMBER",
};

function renderTable(locale = "en") {
  const messages = read(locale);
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <MembersTable
        members={[member]}
        pendingInvites={[]}
        currentUserId="user-1"
        canManage
        canRevokeInvites={false}
      />
    </NextIntlClientProvider>,
  );
  return messages.settingsMembers;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("refused member changes are shown next to the controls", () => {
  it("a removal refused by the write limit says so, and no page error is raised", async () => {
    actions.removeMemberAction.mockResolvedValue({ error: "rate_limited" });
    const t = renderTable();
    fireEvent.click(screen.getByRole("button", { name: /Mira/ }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      t.revokeErrors.rate_limited,
    );
    expect(actions.removeMemberAction).toHaveBeenCalledWith(member.id);
  });

  it("a refused role change no longer looks saved", async () => {
    actions.changeRoleAction.mockResolvedValue({ error: "service_unavailable" });
    const t = renderTable();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ADMIN" } });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      t.revokeErrors.service_unavailable,
    );
    const fd = actions.changeRoleAction.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(fd)).toEqual({ role: "ADMIN", memberId: member.id });
  });

  it("any other refusal is a generic failure (in Finnish), never raw text", async () => {
    actions.removeMemberAction.mockResolvedValue({ error: "owner_role" });
    const t = renderTable("fi");
    fireEvent.click(screen.getByRole("button", { name: /Mira/ }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", t.memberChangeFailed);
  });

  it("an earlier refusal doesn't linger after a later successful change", async () => {
    actions.removeMemberAction.mockResolvedValue({ error: "rate_limited" });
    actions.changeRoleAction.mockResolvedValue({ message: "updated" });
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: /Mira/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ADMIN" } });
    await waitFor(() => expect(actions.changeRoleAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a successful change shows no error", async () => {
    actions.removeMemberAction.mockResolvedValue({ message: "removed" });
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: /Mira/ }));
    await waitFor(() => expect(actions.removeMemberAction).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/**
 * React resets a form after its action finishes. The role select must land on
 * the role the server has, not the role it had when the row first rendered.
 * The real page delivers a saved role as a new prop; LiveTable stands in for that.
 */
describe("the role select shows the stored role after a change settles", () => {
  const stored = { set: (_role: string) => {} };

  function LiveTable() {
    const [role, setRole] = React.useState("MEMBER");
    React.useEffect(() => {
      stored.set = (next) => React.startTransition(() => setRole(next));
    }, []);
    return (
      <NextIntlClientProvider locale="en" messages={read("en")}>
        <MembersTable
          members={[{ ...member, role }]}
          pendingInvites={[]}
          currentUserId="user-1"
          canManage
          canRevokeInvites={false}
        />
      </NextIntlClientProvider>
    );
  }

  const roleSelect = () => screen.getByRole<HTMLSelectElement>("combobox");

  /** Until the action settles the select still holds the user's pick, so wait for that first. */
  async function changeRole(role: string, attempt = 1) {
    fireEvent.change(roleSelect(), { target: { value: role } });
    await waitFor(() => expect(actions.changeRoleAction).toHaveBeenCalledTimes(attempt));
    await waitFor(() => expect(roleSelect().disabled).toBe(false));
  }

  const saveAndSendNewRole = () =>
    actions.changeRoleAction.mockImplementationOnce(async (_state: unknown, fd: FormData) => {
      stored.set(String(fd.get("role")));
      return { message: "updated" };
    });

  it("shows the new role when it arrives with the action's result", async () => {
    saveAndSendNewRole();
    render(<LiveTable />);
    await changeRole("ADMIN");
    await waitFor(() => expect(roleSelect().value).toBe("ADMIN"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the new role when it arrives after the action's result", async () => {
    actions.changeRoleAction.mockResolvedValueOnce({ message: "updated" });
    render(<LiveTable />);
    await changeRole("ADMIN");
    act(() => stored.set("ADMIN"));
    await waitFor(() => expect(roleSelect().value).toBe("ADMIN"));
  });

  it("goes back to the stored role when the change is refused", async () => {
    actions.changeRoleAction.mockResolvedValueOnce({ error: "service_unavailable" });
    render(<LiveTable />);
    await changeRole("ADMIN");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(roleSelect().value).toBe("MEMBER");
  });

  it("a refusal after a saved change goes back to the saved role, not the original one", async () => {
    saveAndSendNewRole();
    actions.changeRoleAction.mockResolvedValueOnce({ error: "service_unavailable" });
    render(<LiveTable />);
    await changeRole("ADMIN");
    await waitFor(() => expect(roleSelect().value).toBe("ADMIN"));
    await changeRole("VIEWER", 2);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(roleSelect().value).toBe("ADMIN");
  });

  it("follows a role changed elsewhere", async () => {
    render(<LiveTable />);
    act(() => stored.set("MANAGER"));
    await waitFor(() => expect(roleSelect().value).toBe("MANAGER"));
  });
});
