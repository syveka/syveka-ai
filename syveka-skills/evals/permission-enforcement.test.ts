import { describe, expect, it } from "vitest";
import { classifyRisk, checkPermission } from "../core/permissions/index.js";
import { runTask } from "../core/orchestrator.js";
import { ApprovalGate } from "../core/approvals/index.js";
import { createSkillRegistryLookupProvider } from "../providers/skill-registry-lookup/index.js";

describe("permission enforcement: risk classification", () => {
  it("classifies known HIGH-risk actions as HIGH, never lower", () => {
    expect(classifyRisk("deploy.production")).toBe("HIGH");
    expect(classifyRisk("credentials.access")).toBe("HIGH");
    expect(classifyRisk("browser.cookies.read.session")).toBe("HIGH");
  });

  it("classifies known LOW-risk actions as LOW", () => {
    expect(classifyRisk("fs.read.package.json")).toBe("LOW");
    expect(classifyRisk("test.run.local.unit")).toBe("LOW");
  });

  it("fails closed: an unclassified action defaults to HIGH, not LOW", () => {
    expect(classifyRisk("some.brand.new.action.nobody.classified.yet")).toBe("HIGH");
  });

  it("CRITICAL: fails closed on a same-string-prefix action with no segment boundary", () => {
    // "fs.readSecretDump" shares fs.read's literal string prefix but is not
    // a "."-delimited child of it - must NOT inherit LOW risk from fs.read;
    // must fall through to DEFAULT_RISK (HIGH) like any other unclassified
    // action.
    expect(classifyRisk("fs.readSecretDump")).toBe("HIGH");
    expect(classifyRisk("deploy.productionOverride")).toBe("HIGH");
    expect(classifyRisk("test.run.localhost.attack")).toBe("HIGH");
  });

  it("exact-match action ids (no trailing segment) still classify correctly", () => {
    expect(classifyRisk("fs.read")).toBe("LOW");
    expect(classifyRisk("deploy.production")).toBe("HIGH");
    expect(classifyRisk("dependency.install")).toBe("MEDIUM");
  });

  it("requires approval for HIGH and MEDIUM risk, not for LOW", () => {
    expect(checkPermission("deploy.production").approvalRequired).toBe(true);
    expect(checkPermission("dependency.install.new").approvalRequired).toBe(true);
    expect(checkPermission("fs.read.config").approvalRequired).toBe(false);
  });
});

describe("permission enforcement: orchestrator blocks gated actions without approval", () => {
  it("returns BLOCKED, not COMPLETE, when a required action is never approved", async () => {
    const report = await runTask("eval-permission-1", "Find a skill for something", {
      providerMap: { "skill-registry-lookup": createSkillRegistryLookupProvider() },
      approvalGate: new ApprovalGate(), // fresh gate - every request stays PENDING
      actionForCapability: () => "deploy.production", // force a HIGH-risk classification
    });

    expect(report.status).toBe("BLOCKED");
    const denied = report.audit_trail.find((e) => e.type === "permission_denied");
    expect(denied).toBeDefined();
  });

  it("proceeds past the gate once the approval is explicitly granted", async () => {
    const gate = new ApprovalGate();
    const requestId = "eval-permission-2:skill.discovery";
    gate.decide(requestId, "APPROVED");

    const report = await runTask("eval-permission-2", "Find a skill for something", {
      providerMap: { "skill-registry-lookup": createSkillRegistryLookupProvider() },
      approvalGate: gate,
      actionForCapability: () => "deploy.production",
    });

    expect(report.status).not.toBe("BLOCKED");
    const granted = report.audit_trail.find((e) => e.type === "permission_granted");
    expect(granted).toBeDefined();
  });
});
