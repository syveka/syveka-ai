import { z } from "zod";

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contact.created") }),
  z.object({ type: z.literal("deal.stage_changed"), toStage: z.string().optional() }),
  z.object({ type: z.literal("deal.won") }),
  z.object({ type: z.literal("call.completed") }),
  z.object({ type: z.literal("schedule.cron"), cron: z.string().min(9) }),
  z.object({ type: z.literal("manual") }),
]);

const comparators = z.enum(["eq", "neq", "gt", "lt", "contains", "exists"]);

export const stepSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("condition"),
    field: z.string().min(1), // path into context, e.g. "trigger.valueCents"
    comparator: comparators,
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("ai.generate"),
    prompt: z.string().min(1).max(4000), // supports {{variables}}
    outputVar: z.string().min(1).max(50),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("email.send"),
    to: z.string().min(3).max(200), // address or {{variable}}
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(10_000),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("crm.create_activity"),
    contactIdVar: z.string().min(1),
    activityType: z.enum(["NOTE", "TASK"]),
    subject: z.string().min(1).max(200),
    body: z.string().max(4000).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("notify.member"),
    userId: z.string().uuid().optional(), // default: workflow creator
    title: z.string().min(1).max(200),
    body: z.string().max(1000).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("wait.duration"),
    seconds: z.number().int().min(60).max(60 * 60 * 24 * 30),
  }),
]);

export const workflowSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(20),
});

export type WorkflowTrigger = z.infer<typeof triggerSchema>;
export type WorkflowStep = z.infer<typeof stepSchema>;
export type WorkflowInput = z.infer<typeof workflowSchema>;
