import type { AgentVersionConfig } from "@agentledger/contracts";
import type { WorkspaceRole } from "../auth/roles.js";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}

export interface MembershipRecord {
  workspace: WorkspaceRecord;
  role: WorkspaceRole;
}

export interface MemberRecord {
  user: UserRecord;
  role: WorkspaceRole;
}

export interface CreateWorkspaceInput {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
}

export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Workspace slug "${slug}" is already taken.`);
    this.name = "SlugTakenError";
  }
}

/** Persistence for workspaces, users and memberships. */
export interface WorkspaceStore {
  /** The user owning an active (not revoked) token with this hash. */
  findUserByTokenHash(tokenHash: string): Promise<UserRecord | null>;
  listMemberships(userId: string): Promise<MembershipRecord[]>;
  findMembership(workspaceId: string, userId: string): Promise<MembershipRecord | null>;
  listMembers(workspaceId: string): Promise<MemberRecord[]>;
  /** Creates the workspace and makes the owner its admin, atomically. */
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
}

export interface AgentRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: Date;
  /** Highest published version number, or null before the first version. */
  latestVersion: number | null;
}

export interface AgentVersionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  version: number;
  config: AgentVersionConfig;
  configHash: string;
  notes: string | null;
  createdById: string;
  createdAt: Date;
}

export interface CreateAgentInput {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  createdById: string;
}

export interface PublishVersionInput {
  id: string;
  workspaceId: string;
  agentId: string;
  config: AgentVersionConfig;
  configHash: string;
  notes: string | null;
  createdById: string;
  /**
   * When set, publishing fails with {@link VersionConflictError} unless this is
   * still the latest version (null = the agent has no versions yet).
   */
  expectedLatestVersion?: number | null;
}

export class AgentSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`An agent with slug "${slug}" already exists in this workspace.`);
    this.name = "AgentSlugTakenError";
  }
}

/** The config is identical to the latest version, so there is nothing to publish. */
export class VersionUnchangedError extends Error {
  constructor(readonly latestVersion: number) {
    super(`The config is identical to version ${latestVersion}.`);
    this.name = "VersionUnchangedError";
  }
}

export class VersionConflictError extends Error {
  constructor(
    readonly expected: number | null,
    readonly actual: number | null,
  ) {
    super(`Expected latest version ${expected ?? "none"}, but it is ${actual ?? "none"}.`);
    this.name = "VersionConflictError";
  }
}

/**
 * Persistence for agent definitions and their immutable versions. Every lookup
 * is scoped by workspace, so an ID from another workspace is never found.
 */
export interface AgentStore {
  listAgents(workspaceId: string): Promise<AgentRecord[]>;
  findAgent(workspaceId: string, agentId: string): Promise<AgentRecord | null>;
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
  /** Newest first. */
  listVersions(workspaceId: string, agentId: string): Promise<AgentVersionRecord[]>;
  findVersion(workspaceId: string, agentId: string, version: number): Promise<AgentVersionRecord | null>;
  /**
   * Stores the config as the next version number (latest + 1). Versions are
   * append-only: there is no update or delete.
   */
  publishVersion(input: PublishVersionInput): Promise<AgentVersionRecord>;
}
