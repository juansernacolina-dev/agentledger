import type { WorkspaceRole } from "../auth/roles.js";
import {
  SlugTakenError,
  type CreateWorkspaceInput,
  type MemberRecord,
  type MembershipRecord,
  type UserRecord,
  type WorkspaceRecord,
  type WorkspaceStore,
} from "./types.js";

/**
 * In-memory store with the same behaviour as the Prisma store. Used by route
 * tests so they run without PostgreSQL.
 */
export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly tokens = new Map<string, { userId: string; revoked: boolean }>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly memberships = new Map<string, { workspaceId: string; userId: string; role: WorkspaceRole }>();

  addUser(user: UserRecord): this {
    this.users.set(user.id, { ...user });
    return this;
  }

  addToken(tokenHash: string, userId: string, revoked = false): this {
    this.tokens.set(tokenHash, { userId, revoked });
    return this;
  }

  addWorkspace(workspace: WorkspaceRecord): this {
    this.workspaces.set(workspace.id, { ...workspace });
    return this;
  }

  addMembership(workspaceId: string, userId: string, role: WorkspaceRole): this {
    this.memberships.set(`${workspaceId}:${userId}`, { workspaceId, userId, role });
    return this;
  }

  async findUserByTokenHash(tokenHash: string): Promise<UserRecord | null> {
    const token = this.tokens.get(tokenHash);
    if (token === undefined || token.revoked) return null;
    return this.users.get(token.userId) ?? null;
  }

  async listMemberships(userId: string): Promise<MembershipRecord[]> {
    return [...this.memberships.values()]
      .filter((m) => m.userId === userId)
      .map((m) => ({ role: m.role, workspace: this.requireWorkspace(m.workspaceId) }))
      .sort((a, b) => a.workspace.slug.localeCompare(b.workspace.slug));
  }

  async findMembership(workspaceId: string, userId: string): Promise<MembershipRecord | null> {
    const m = this.memberships.get(`${workspaceId}:${userId}`);
    if (m === undefined) return null;
    return { role: m.role, workspace: this.requireWorkspace(workspaceId) };
  }

  async listMembers(workspaceId: string): Promise<MemberRecord[]> {
    return [...this.memberships.values()]
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => {
        const user = this.users.get(m.userId);
        if (user === undefined) throw new Error(`unknown user ${m.userId}`);
        return { role: m.role, user };
      })
      .sort((a, b) => a.user.email.localeCompare(b.user.email));
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    for (const ws of this.workspaces.values()) {
      if (ws.slug === input.slug) throw new SlugTakenError(input.slug);
    }
    const workspace: WorkspaceRecord = {
      id: input.id,
      slug: input.slug,
      name: input.name,
      createdAt: new Date(),
    };
    this.addWorkspace(workspace).addMembership(workspace.id, input.ownerId, "admin");
    return workspace;
  }

  private requireWorkspace(id: string): WorkspaceRecord {
    const ws = this.workspaces.get(id);
    if (ws === undefined) throw new Error(`unknown workspace ${id}`);
    return ws;
  }
}
