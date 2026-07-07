import "server-only";

import type { Plan } from "@prisma/client";

export type PlanLimits = {
  maxSeats: number;
  aiMessagesPerUserMonth: number;
  voiceAssistants: number;
  voiceMinutesMonth: number;
  kbStorageMb: number;
  activeWorkflows: number;
  maxContacts: number;
  apiAccess: boolean;
  auditRetentionDays: number;
};

/** Plan matrix (§14.1). Single source of truth for entitlements. */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    maxSeats: 2,
    aiMessagesPerUserMonth: 25, // 50 per org / 2 seats
    voiceAssistants: 0,
    voiceMinutesMonth: 0,
    kbStorageMb: 50,
    activeWorkflows: 0,
    maxContacts: 200,
    apiAccess: false,
    auditRetentionDays: 0,
  },
  STARTER: {
    maxSeats: 10,
    aiMessagesPerUserMonth: 1_000,
    voiceAssistants: 1,
    voiceMinutesMonth: 100,
    kbStorageMb: 1_024,
    activeWorkflows: 5,
    maxContacts: 5_000,
    apiAccess: false,
    auditRetentionDays: 30,
  },
  PRO: {
    maxSeats: 50,
    aiMessagesPerUserMonth: 5_000,
    voiceAssistants: 3,
    voiceMinutesMonth: 500,
    kbStorageMb: 10_240,
    activeWorkflows: 25,
    maxContacts: 50_000,
    apiAccess: true,
    auditRetentionDays: 730,
  },
  ENTERPRISE: {
    maxSeats: Number.MAX_SAFE_INTEGER,
    aiMessagesPerUserMonth: Number.MAX_SAFE_INTEGER,
    voiceAssistants: Number.MAX_SAFE_INTEGER,
    voiceMinutesMonth: Number.MAX_SAFE_INTEGER,
    kbStorageMb: Number.MAX_SAFE_INTEGER,
    activeWorkflows: Number.MAX_SAFE_INTEGER,
    maxContacts: Number.MAX_SAFE_INTEGER,
    apiAccess: true,
    auditRetentionDays: 730,
  },
};
