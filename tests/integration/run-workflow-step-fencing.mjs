#!/usr/bin/env node
// Real-Postgres proof for the step-level fencing guard in
// src/app/api/v1/jobs/run-workflow/route.ts (claimStep/completeStep/failStep
// and the crm.create_activity/notify.member transactions). Not wired into CI
// (the "Unit and integration tests" job has no live Postgres), so this is a
// manual/local verification tool, not part of `npm test`. Run against any
// scratch Postgres with migrations already applied:
//
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
//   DIRECT_URL=postgresql://postgres:postgres@localhost:5432/postgres \
//     node tests/integration/run-workflow-step-fencing.mjs
//
// Scenario: Worker A claims a step, then stalls (slow, not dead) past the
// step-claim staleness threshold. Worker B (e.g. a QStash retry delivery)
// reclaims the now-stale step and completes it first. Worker A, unaware it
// was superseded, then finally finishes its own already-in-flight attempt
// using the SAME stepExecutionId it captured at claim time. Without the
// `startedAt` fencing token, Worker A's completion is indistinguishable from
// a legitimate one and creates a second, genuinely duplicate Activity. This
// script proves the fencing guard rejects Worker A's belated completion
// instead: its side effect rolls back with it (see runCrmCreateActivityStep),
// so exactly one Activity survives.
//
// claimStep()/runCrmCreateActivityStep() below are verbatim copies of the
// route's own logic (not a hand-written analog), so this exercises the exact
// mechanism under test, not a simplified stand-in for it.

import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const prisma = new PrismaClient();
const STALE_STEP_CLAIM_MS = 300; // shortened for test speed; the guard logic itself is identical to production

function isUniqueViolation(err) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}

async function claimStep(tx, params) {
  try {
    const created = await tx.workflowStepExecution.create({
      data: {
        organizationId: params.organizationId,
        workflowRunId: params.workflowRunId,
        stepId: params.stepId,
        status: "CLAIMED",
      },
    });
    return { claimed: true, stepExecutionId: created.id, startedAt: created.startedAt };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await tx.workflowStepExecution.findFirstOrThrow({
      where: { workflowRunId: params.workflowRunId, stepId: params.stepId },
    });
    if (existing.status === "SUCCEEDED") {
      return { claimed: false, reason: "succeeded", output: existing.output };
    }
    const staleSince = new Date(Date.now() - STALE_STEP_CLAIM_MS);
    const isReclaimable = existing.status === "FAILED" || existing.startedAt < staleSince;
    if (!isReclaimable) return { claimed: false, reason: "in_progress" };

    const newStartedAt = new Date();
    const reclaimed = await tx.workflowStepExecution.updateMany({
      where: {
        id: existing.id,
        OR: [{ status: "FAILED" }, { status: "CLAIMED", startedAt: { lt: staleSince } }],
      },
      data: { status: "CLAIMED", error: null, startedAt: newStartedAt, finishedAt: null },
    });
    if (reclaimed.count === 0) return { claimed: false, reason: "in_progress" };
    return { claimed: true, stepExecutionId: existing.id, startedAt: newStartedAt };
  }
}

async function runCrmCreateActivityStep(label, claim, fixture) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.activity.create({
        data: {
          organizationId: fixture.orgId,
          contactId: fixture.contactId,
          type: "NOTE",
          subject: `fencing-repro (${label})`,
          metadata: { via: "workflow", workflowId: fixture.workflowId },
        },
      });
      const written = await tx.workflowStepExecution.updateMany({
        where: { id: claim.stepExecutionId, startedAt: claim.startedAt },
        data: { status: "SUCCEEDED", finishedAt: new Date() },
      });
      if (written.count === 0)
        throw new Error("STEP_FENCED: claim was reclaimed by another worker");
    });
    return "completed";
  } catch (err) {
    return err.message.startsWith("STEP_FENCED") ? "fenced" : `error: ${err.message}`;
  }
}

async function main() {
  const org = await prisma.organization.create({
    data: { name: "Fencing Repro Org", slug: `fencing-repro-${Date.now()}` },
  });
  const user = await prisma.user.create({
    data: {
      id: crypto.randomUUID(),
      email: `fencing-repro-${Date.now()}@example.test`,
      fullName: "x",
    },
  });
  const workflow = await prisma.workflow.create({
    data: {
      organizationId: org.id,
      createdById: user.id,
      name: "Fencing Repro Workflow",
      trigger: { type: "manual" },
      steps: [{ id: "step1", type: "crm.create_activity" }],
    },
  });
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, firstName: "Fencing", lastName: "Repro" },
  });
  const run = await prisma.workflowRun.create({
    data: {
      organizationId: org.id,
      workflowId: workflow.id,
      triggerData: {},
      status: "RUNNING",
      sourceEventKey: `manual:${Date.now()}`,
    },
  });
  const fixture = { orgId: org.id, workflowId: workflow.id, contactId: contact.id, runId: run.id };

  try {
    const claimA = await claimStep(prisma, {
      organizationId: fixture.orgId,
      workflowRunId: fixture.runId,
      stepId: "step1",
    });
    console.log("Worker A claimed:", claimA.claimed, "startedAt:", claimA.startedAt.toISOString());

    // Worker A is slow but alive - does not complete yet.
    await new Promise((r) => setTimeout(r, STALE_STEP_CLAIM_MS + 200));

    const claimB = await claimStep(prisma, {
      organizationId: fixture.orgId,
      workflowRunId: fixture.runId,
      stepId: "step1",
    });
    console.log("Worker B claimed (reclaimed as stale):", claimB.claimed);
    const outcomeB = await runCrmCreateActivityStep("Worker B", claimB, fixture);
    console.log("Worker B outcome:", outcomeB);

    const outcomeA = await runCrmCreateActivityStep("Worker A", claimA, fixture);
    console.log("Worker A outcome (belated, using superseded claim):", outcomeA);

    const activities = await prisma.activity.findMany({
      where: { organizationId: fixture.orgId, contactId: fixture.contactId },
    });
    const stepRow = await prisma.workflowStepExecution.findFirst({
      where: { workflowRunId: fixture.runId, stepId: "step1" },
    });

    console.log(`Activities created: ${activities.length} (want 1)`);
    console.log(`Final step status: ${stepRow.status} (want SUCCEEDED)`);
    console.log(`Worker A outcome: ${outcomeA} (want "fenced")`);
    console.log(`Worker B outcome: ${outcomeB} (want "completed")`);

    if (
      activities.length === 1 &&
      stepRow.status === "SUCCEEDED" &&
      outcomeA === "fenced" &&
      outcomeB === "completed"
    ) {
      console.log(
        "\nPROVEN: the stale-but-still-alive worker's belated completion was fenced out; " +
          "only the reclaiming worker's Activity was durably created.",
      );
      process.exitCode = 0;
    } else {
      console.log("\nUNEXPECTED RESULT - fencing guard did not behave as expected.");
      process.exitCode = 1;
    }
  } finally {
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
