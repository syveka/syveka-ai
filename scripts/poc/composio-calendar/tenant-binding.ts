/**
 * PoC-scoped design for how a Composio connected account would be bound to
 * a Syveka tenant identity, mirroring this repo's REAL tenant-isolation
 * mechanism (src/server/db/tenant.ts's `tenantDb(orgId)`, which injects
 * `organizationId` into every query/mutation and OVERRIDES any
 * client-supplied value in write payloads) and the real
 * `CalendarConnection` model's `@@unique([organizationId, userId, provider])`
 * shape (prisma/schema.prisma).
 *
 * This file is standalone PoC evidence, not production code: it uses an
 * in-memory registry instead of `tenantDb`/Prisma, and is never imported by
 * `src/`. If Composio is ever promoted, the real implementation would
 * replace this in-memory Map with a `CalendarConnection`-shaped row (see
 * docs/skills/composio-calendar-poc.md "Tenant binding design") read via
 * `tenantDb(orgId)`, not a parallel mechanism.
 *
 * THE SECURITY PROPERTY THIS FILE PROVES: the only way to obtain a
 * `connected_account_id` for a Composio tool call is
 * `resolveConnectedAccountId(registry, { orgId, userId })` - a lookup keyed
 * SOLELY by a server-verified tenant/user identity. Nothing in this module
 * accepts a caller-supplied `connected_account_id` as an input to trust;
 * `buildToolExecuteRequest` explicitly strips one if present in agent/model
 * arguments, exactly like `tenantDb`'s write-payload override for
 * `organizationId`.
 */

export type ConnectionStatus = "ACTIVE" | "REVOKED" | "FAILED";

export interface TenantComposioConnection {
  organizationId: string;
  userId: string;
  provider: "composio";
  toolkitSlug: "googlecalendar";
  /** The id Composio returned from `client.link.create(...)`. */
  composioConnectedAccountId: string;
  /** The `user_id` WE passed to Composio at link-creation time - re-verified against what Composio reports back on retrieve(), see verifyConnectionOwnership(). */
  composioUserId: string;
  status: ConnectionStatus;
}

/** Stand-in for a `CalendarConnection`-shaped tenant table, scoped exactly like tenantDb(orgId) would enforce. */
export class TenantComposioConnectionRegistry {
  private byOrgAndUser = new Map<string, TenantComposioConnection>();

  private key(orgId: string, userId: string): string {
    return `${orgId}::${userId}::composio::googlecalendar`;
  }

  register(conn: TenantComposioConnection): void {
    this.byOrgAndUser.set(this.key(conn.organizationId, conn.userId), conn);
  }

  /**
   * The ONLY lookup path. Takes a server-verified (orgId, userId) pair -
   * never anything caller-supplied beyond that pair - and returns the
   * connection bound to it, or undefined. There is deliberately no
   * "get by connected_account_id" method on this class: nothing may ever
   * look up or select a connection by an id supplied from outside this
   * lookup, mirroring tenantDb's "organizationId always comes from ctx,
   * never from the request body" rule.
   */
  findForTenant(orgId: string, userId: string): TenantComposioConnection | undefined {
    return this.byOrgAndUser.get(this.key(orgId, userId));
  }
}

export interface ServerVerifiedContext {
  /** Must originate from the server-verified session (src/server/auth/session.ts), never a request body/header/query param. */
  orgId: string;
  userId: string;
}

export class TenantBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantBindingError";
  }
}

/**
 * Resolves the connected_account_id to use for a Composio tool call.
 * Fails closed (throws) rather than returning undefined/null, so a caller
 * cannot accidentally treat "no binding" as "no restriction."
 */
export function resolveConnectedAccountId(
  registry: TenantComposioConnectionRegistry,
  ctx: ServerVerifiedContext,
): string {
  const conn = registry.findForTenant(ctx.orgId, ctx.userId);
  if (!conn) {
    throw new TenantBindingError(
      `No Composio Google Calendar connection bound to org=${ctx.orgId} user=${ctx.userId} - failing closed.`,
    );
  }
  if (conn.status !== "ACTIVE") {
    throw new TenantBindingError(
      `Composio connection for org=${ctx.orgId} user=${ctx.userId} is ${conn.status}, not ACTIVE - failing closed.`,
    );
  }
  return conn.composioConnectedAccountId;
}

/**
 * Cross-checks what Composio itself reports (`GET
 * /api/v3.1/connected_accounts/{id}` -> `.user_id`) against the tenant
 * binding we expected, so a stale/corrupted local registry entry (or a
 * misissued connected_account_id) can never silently authorize a call
 * against a DIFFERENT user's Google account than the one Syveka intended.
 */
export function verifyConnectionOwnership(
  composioReportedUserId: string,
  expectedConn: TenantComposioConnection,
): void {
  if (composioReportedUserId !== expectedConn.composioUserId) {
    throw new TenantBindingError(
      `Identity mismatch: Composio reports user_id=${composioReportedUserId} for connected_account_id=` +
        `${expectedConn.composioConnectedAccountId}, but this tenant's binding expected user_id=` +
        `${expectedConn.composioUserId}. Refusing to use this connection.`,
    );
  }
}

/**
 * Builds the body for `client.tools.execute(toolSlug, body)`. This is the
 * single choke point every Google Calendar tool call in this PoC goes
 * through - `agentSuppliedArguments` is whatever an LLM/agent produced
 * (tool call arguments), which may in principle contain a
 * `connected_account_id` key (a model can put anything in JSON it emits).
 * That key is explicitly deleted and always overwritten with the
 * server-resolved id, exactly mirroring tenantDb's override of a
 * client-influenced `organizationId` in write payloads.
 */
export function buildToolExecuteRequest(
  registry: TenantComposioConnectionRegistry,
  ctx: ServerVerifiedContext,
  agentSuppliedArguments: Record<string, unknown>,
): { connected_account_id: string; arguments: Record<string, unknown> } {
  const connectedAccountId = resolveConnectedAccountId(registry, ctx);
  const sanitizedArguments = { ...agentSuppliedArguments };
  delete sanitizedArguments.connected_account_id;
  delete sanitizedArguments.user_id;
  delete sanitizedArguments.entity_id;
  return { connected_account_id: connectedAccountId, arguments: sanitizedArguments };
}
