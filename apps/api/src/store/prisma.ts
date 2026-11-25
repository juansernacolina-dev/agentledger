import type { AgentVersionConfig } from "@agentledger/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";
import { nextVersionNumber } from "../agents/publish.js";
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

const userFields = { id: true, email: true, displayName: true } as const;
const workspaceFields = { id: true, slug: true, name: true, createdAt: true } as const;

export class PrismaWorkspaceStore implements WorkspaceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserByTokenHash(tokenHash: string): Promise<UserRecord | null> {
    const token = await this.prisma.apiToken.findUnique({
      where: { tokenHash },
      select: { revokedAt: true, user: { select: userFields } },
    });
    if (token === null || token.revokedAt !== null) return null;
    return token.user;
  }

  async listMemberships(userId: string): Promise<MembershipRecord[]> {
    return this.prisma.membership.findMany({
      where: { userId },
      select: { role: true, workspace: { select: workspaceFields } },
      orderBy: { workspace: { slug: "asc" } },
    });
  }

  async findMembership(workspaceId: string, userId: string): Promise<MembershipRecord | null> {
    return this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, workspace: { select: workspaceFields } },
    });
  }

  async listMembers(workspaceId: string): Promise<MemberRecord[]> {
    return this.prisma.membership.findMany({
      where: { workspaceId },
      select: { role: true, user: { select: userFields } },
      orderBy: { user: { email: "asc" } },
    });
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    try {
      return await this.prisma.workspace.create({
        data: {
          id: input.id,
          slug: input.slug,
          name: input.name,
          memberships: { create: { userId: input.ownerId, role: "admin" } },
        },
        select: workspaceFields,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new SlugTakenError(input.slug);
      }
      throw error;
    }
  }
}

const agentFields = {
  id: true,
  workspaceId: true,
  slug: true,
  name: true,
  description: true,
  createdAt: true,
  versions: { select: { version: true }, orderBy: { version: "desc" }, take: 1 },
} as const satisfies Prisma.AgentDefinitionSelect;

const versionFields = {
  id: true,
  workspaceId: true,
  agentId: true,
  version: true,
  config: true,
  configHash: true,
  notes: true,
  createdById: true,
  createdAt: true,
} as const satisfies Prisma.AgentVersionSelect;

type AgentRow = Prisma.AgentDefinitionGetPayload<{ select: typeof agentFields }>;
type VersionRow = Prisma.AgentVersionGetPayload<{ select: typeof versionFields }>;

function toAgentRecord({ versions, ...agent }: AgentRow): AgentRecord {
  return { ...agent, latestVersion: versions[0]?.version ?? null };
}

/** Configs were validated against the contract before they were stored. */
function toVersionRecord(row: VersionRow): AgentVersionRecord {
  return { ...row, config: row.config as unknown as AgentVersionConfig };
}

export class PrismaAgentStore implements AgentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listAgents(workspaceId: string): Promise<AgentRecord[]> {
    const rows = await this.prisma.agentDefinition.findMany({
      where: { workspaceId },
      select: agentFields,
      orderBy: { slug: "asc" },
    });
    return rows.map(toAgentRecord);
  }

  async findAgent(workspaceId: string, agentId: string): Promise<AgentRecord | null> {
    const row = await this.prisma.agentDefinition.findUnique({
      where: { id_workspaceId: { id: agentId, workspaceId } },
      select: agentFields,
    });
    return row === null ? null : toAgentRecord(row);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    try {
      const row = await this.prisma.agentDefinition.create({ data: input, select: agentFields });
      return toAgentRecord(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AgentSlugTakenError(input.slug);
      }
      throw error;
    }
  }

  async listVersions(workspaceId: string, agentId: string): Promise<AgentVersionRecord[]> {
    const rows = await this.prisma.agentVersion.findMany({
      where: { workspaceId, agentId },
      select: versionFields,
      orderBy: { version: "desc" },
    });
    return rows.map(toVersionRecord);
  }

  async findVersion(workspaceId: string, agentId: string, version: number): Promise<AgentVersionRecord | null> {
    const row = await this.prisma.agentVersion.findFirst({
      where: { workspaceId, agentId, version },
      select: versionFields,
    });
    return row === null ? null : toVersionRecord(row);
  }

  async publishVersion(input: PublishVersionInput): Promise<AgentVersionRecord> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the agent row so concurrent publishes get consecutive numbers
      // instead of colliding on (agent_id, version).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM agent_definitions
        WHERE id = ${input.agentId} AND workspace_id = ${input.workspaceId}
        FOR UPDATE`;
      if (locked.length === 0) {
        throw new Error(`unknown agent ${input.agentId} in workspace ${input.workspaceId}`);
      }
      const latest = await tx.agentVersion.findFirst({
        where: { agentId: input.agentId, workspaceId: input.workspaceId },
        select: { version: true, configHash: true },
        orderBy: { version: "desc" },
      });
      const row = await tx.agentVersion.create({
        data: {
          id: input.id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          version: nextVersionNumber(latest, input),
          config: input.config as unknown as Prisma.InputJsonObject,
          configHash: input.configHash,
          notes: input.notes,
          createdById: input.createdById,
        },
        select: versionFields,
      });
      return toVersionRecord(row);
    });
  }
}
