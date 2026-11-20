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
