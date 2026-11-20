import type { FastifyRequest } from "fastify";
import { forbidden, unauthorized, workspaceNotFound } from "../errors.js";
import type { MembershipRecord, UserRecord, WorkspaceStore } from "../store/types.js";
import { hasRole, type WorkspaceRole } from "./roles.js";
import { hashToken, readBearerToken } from "./tokens.js";

export async function requireUser(request: FastifyRequest, store: WorkspaceStore): Promise<UserRecord> {
  const token = readBearerToken(request.headers.authorization);
  if (token === null) throw unauthorized();
  const user = await store.findUserByTokenHash(hashToken(token));
  if (user === null) throw unauthorized();
  return user;
}

/**
 * Resolves the caller's membership in a workspace and checks their role.
 * Non-members get 404 (not 403) so other tenants' workspaces stay invisible.
 * A `null` workspace ID (malformed in the URL) is treated as unknown, after
 * the caller has been authenticated.
 */
export async function requireMembership(
  request: FastifyRequest,
  store: WorkspaceStore,
  workspaceId: string | null,
  required: WorkspaceRole,
): Promise<{ user: UserRecord; membership: MembershipRecord }> {
  const user = await requireUser(request, store);
  if (workspaceId === null) throw workspaceNotFound();
  const membership = await store.findMembership(workspaceId, user.id);
  if (membership === null) throw workspaceNotFound();
  if (!hasRole(membership.role, required)) throw forbidden(required);
  return { user, membership };
}
