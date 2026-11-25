import { nextVersionNumber } from "../agents/publish.js";
import type { WorkspaceRole } from "../auth/roles.js";
import {
  AgentSlugTakenError,
  SlugTakenError,
  type AgentRecord,
  type AgentStore,
  type AgentVersionRecord,
  type CreateAgentInput,
  type PublishVersionInput,
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

/**
 * In-memory agent store with the same rules as the Prisma store. Records are
 * copied in and out, so callers can never change a stored version.
 */
export class InMemoryAgentStore implements AgentStore {
  private readonly agents = new Map<string, Omit<AgentRecord, "latestVersion">>();
  private readonly versions: AgentVersionRecord[] = [];

  async listAgents(workspaceId: string): Promise<AgentRecord[]> {
    return [...this.agents.values()]
      .filter((agent) => agent.workspaceId === workspaceId)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((agent) => this.withLatest(agent));
  }

  async findAgent(workspaceId: string, agentId: string): Promise<AgentRecord | null> {
    const agent = this.agents.get(agentId);
    if (agent === undefined || agent.workspaceId !== workspaceId) return null;
    return this.withLatest(agent);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    for (const agent of this.agents.values()) {
      if (agent.workspaceId === input.workspaceId && agent.slug === input.slug) {
        throw new AgentSlugTakenError(input.slug);
      }
    }
    const agent = {
      id: input.id,
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      createdAt: new Date(),
    };
    this.agents.set(agent.id, agent);
    return this.withLatest(agent);
  }

  async listVersions(workspaceId: string, agentId: string): Promise<AgentVersionRecord[]> {
    return this.versionsOf(workspaceId, agentId)
      .sort((a, b) => b.version - a.version)
      .map((version) => structuredClone(version));
  }

  async findVersion(workspaceId: string, agentId: string, version: number): Promise<AgentVersionRecord | null> {
    const found = this.versionsOf(workspaceId, agentId).find((v) => v.version === version);
    return found === undefined ? null : structuredClone(found);
  }

  async publishVersion(input: PublishVersionInput): Promise<AgentVersionRecord> {
    const agent = this.agents.get(input.agentId);
    if (agent === undefined || agent.workspaceId !== input.workspaceId) {
      throw new Error(`unknown agent ${input.agentId} in workspace ${input.workspaceId}`);
    }
    const latest = this.latestOf(input.workspaceId, input.agentId);
    const record: AgentVersionRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      version: nextVersionNumber(latest, input),
      config: structuredClone(input.config),
      configHash: input.configHash,
      notes: input.notes,
      createdById: input.createdById,
      createdAt: new Date(),
    };
    this.versions.push(record);
    return structuredClone(record);
  }

  private versionsOf(workspaceId: string, agentId: string): AgentVersionRecord[] {
    return this.versions.filter((v) => v.workspaceId === workspaceId && v.agentId === agentId);
  }

  private latestOf(workspaceId: string, agentId: string): AgentVersionRecord | null {
    return this.versionsOf(workspaceId, agentId).reduce<AgentVersionRecord | null>(
      (latest, v) => (latest === null || v.version > latest.version ? v : latest),
      null,
    );
  }

  private withLatest(agent: Omit<AgentRecord, "latestVersion">): AgentRecord {
    return { ...agent, latestVersion: this.latestOf(agent.workspaceId, agent.id)?.version ?? null };
  }
}
