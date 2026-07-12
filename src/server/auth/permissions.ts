import type { Role } from "@prisma/client";

/**
 * RBAC single source of truth (§12.2).
 * `can(role, permission)` is imported by Server Actions, API handlers and
 * (via a serialized subset) the UI's <Can> component.
 */
export const PERMISSIONS = [
  "org:update",
  "org:delete",
  "members:invite",
  "members:role",
  "members:remove",
  "billing:view",
  "billing:manage",
  "crm:read",
  "crm:write",
  "crm:delete",
  "crm:import-export",
  "crm:manage-pipeline",
  "chat:use",
  "kb:read",
  "kb:write",
  "voice:configure",
  "voice:view-calls",
  "workflows:manage",
  "workflows:view",
  "calendar:read",
  "calendar:write",
  "analytics:view",
  "analytics:view-own",
  "prompts:read",
  "prompts:write",
  "api-keys:manage",
  "webhooks:manage",
  "audit:view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

const MANAGER_PERMS = new Set<Permission>([
  "crm:read",
  "crm:write",
  "crm:delete",
  "crm:import-export",
  "crm:manage-pipeline",
  "chat:use",
  "kb:read",
  "kb:write",
  "voice:configure",
  "voice:view-calls",
  "workflows:manage",
  "workflows:view",
  "calendar:read",
  "calendar:write",
  "analytics:view",
  "analytics:view-own",
  "prompts:read",
  "prompts:write",
]);

const MEMBER_PERMS = new Set<Permission>([
  "crm:read",
  "crm:write",
  "chat:use",
  "kb:read",
  "voice:view-calls",
  "workflows:view",
  "calendar:read",
  "calendar:write",
  "analytics:view-own",
  "prompts:read",
  "prompts:write",
]);

const VIEWER_PERMS = new Set<Permission>([
  "crm:read",
  "kb:read",
  "voice:view-calls",
  "calendar:read",
  "prompts:read",
]);

const ADMIN_PERMS = new Set<Permission>(
  [...ALL].filter((p) => p !== "org:delete" && p !== "billing:manage"),
);
ADMIN_PERMS.add("billing:view");

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: ALL,
  ADMIN: ADMIN_PERMS,
  MANAGER: MANAGER_PERMS,
  MEMBER: MEMBER_PERMS,
  VIEWER: VIEWER_PERMS,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** API key scopes (§10.2) → implied permissions. */
export const SCOPE_PERMISSIONS: Record<string, Permission[]> = {
  "crm:read": ["crm:read"],
  "crm:write": ["crm:read", "crm:write"],
  "chat:write": ["chat:use"],
  "kb:read": ["kb:read"],
  "kb:write": ["kb:read", "kb:write"],
  "calendar:read": ["calendar:read"],
  "calendar:write": ["calendar:read", "calendar:write"],
  "analytics:read": ["analytics:view"],
};
